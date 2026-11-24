// Read-only Modbus health report: for every Modbus module, the Core's per-register record of the last successful and
// the last failed read/write (MessageModbusRegistersInfoRequest), summarised.
//
// Usage: node modbus-health.mjs [hours=24]   (failures older than `hours` are not listed)
// env: JSON=<file> also writes the raw per-module replies to that file
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , hoursArg] = process.argv;
const hours = Number(hoursArg || 24);
const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema, { strict: true });
const tagMap = loadSchema().tagMap;

const s = await openSession({ ...cfg.session(), tagMap, log: () => {} });
const cfg = dec.message(s.reconnectRaw, 'MessageBase');
const byId = new Map((cfg.Devices || []).map((d) => [d.ID, d]));
const modbusCcus = new Set((cfg.Ccus || []).filter((c) => /Modbus/i.test(c.Model)).map((c) => c.CcuId));
const modules = (cfg.Devices || []).filter((d) => modbusCcus.has(d.CcuId) && d.Model === 'ModbusModule');

async function ask(req) { // send one request, return the decoded reply (null on timeout)
  const rid = s.newRequestId();
  s.conn.sendBinary(enc.message({ ...req, RequestsId: rid }, 'MessageBase'));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    let raw;
    try { raw = await s.next(500); } catch { continue; }
    if (!raw) return null;
    const found = [raw];
    const m = P.unwrap(raw, tagMap);
    if (m.tag === 383) found.splice(0, 1, ...P.all(m.body, 1).map((f) => f.v));
    for (const r of found) {
      const u = P.unwrap(r, tagMap);
      if (u.requestsId === rid && u.type === P.TYPE.Response) return dec.message(r, 'MessageBase');
    }
  }
  return null;
}

const now = Date.now(), cutoff = now - hours * 3600e3;
const ago = (iso) => { const s2 = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); /* clamp PC/Core clock skew */ return s2 < 120 ? `${s2}s` : s2 < 7200 ? `${Math.round(s2 / 60)}m` : `${(s2 / 3600).toFixed(1)}h`; };
const name = (id) => byId.get(id)?.Name ?? `#${id}`;
const raw = {};
console.log(`Modbus health, ${new Date(now).toLocaleString('sv-SE')}, failures listed for the last ${hours} h\n`);
for (const mod of modules) {
  const r = await ask({ $type: 'MessageModbusRegistersInfoRequest', DeviceId: mod.ID });
  raw[mod.ID] = r;
  const props = mod.DeviceProperties || {};
  const head = `${mod.ID} ${mod.Name}  (slave ${props.SlaveId ?? '?'}, module poll ${props.InternalPollInterval ?? '?'} ms)`;
  if (!r || r.ErrorMessage) { console.log(`${head}\n  ! ${r ? r.ErrorMessage : 'no reply'}\n`); continue; }
  // Index 0 is not on the wire (protobuf default), so a missing Index means 0
  const regs = Object.entries(r.Registers || {}).flatMap(([type, list]) => (list || []).map((x) => ({ type, ...x, Index: x.Index ?? 0 })));
  // a register is stale when its last good read is older than 3x the fastest poll interval of the devices using it (min 15 min)
  const pollOf = (x) => Math.min(...(x.Devices || []).map((id) => Number(byId.get(id)?.DeviceProperties?.InternalPollInterval) || Infinity));
  const staleAfter = (x) => Math.max(15 * 60e3, 3 * (Number.isFinite(pollOf(x)) ? pollOf(x) : 0) + 60e3);
  const okRt = regs.map((x) => x.LastSuccessfulReadTransaction?.ResponseTime).filter((v) => v != null);
  const lastOk = regs.map((x) => x.LastSuccessfulReadTransaction?.UtcTime).filter(Boolean).sort().pop();
  const fails = regs.flatMap((x) => [['read', x.LastUnsuccessfulReadTransaction], ['write', x.LastUnsuccessfulWriteTransaction]]
    .filter(([, t]) => t?.UtcTime && Date.parse(t.UtcTime) >= cutoff).map(([op, t]) => ({ x, op, t })));
  const stale = regs.filter((x) => x.LastSuccessfulReadTransaction?.UtcTime && now - Date.parse(x.LastSuccessfulReadTransaction.UtcTime) > staleAfter(x));
  console.log(head);
  console.log(`  ${regs.length} registers, last good read ${lastOk ? ago(lastOk) + ' ago' : 'never'}, response time avg ${okRt.length ? Math.round(okRt.reduce((a, b) => a + b, 0) / okRt.length) : '-'} ms / max ${okRt.length ? Math.max(...okRt) : '-'} ms`);
  if (stale.length) console.log(`  ${stale.length} register(s) overdue (no good read for 3x their poll interval): ${stale.slice(0, 6).map((x) => `${x.type}${x.Index}`).join(', ')}${stale.length > 6 ? ' …' : ''}`);
  if (!fails.length) console.log(`  no failures in the last ${hours} h`);
  for (const { x, op, t } of fails.sort((a, b) => b.t.UtcTime.localeCompare(a.t.UtcTime)).slice(0, 8))
    console.log(`  ${op} ${x.type}${x.Index} failed ${ago(t.UtcTime)} ago: ${t.CommunicationErrorMessage ?? (t.Response?.ExceptionMessage ? `slave answered ${t.Response.ExceptionMessage}` : 'no response')}  [${(x.Devices || []).map(name).join(', ')}]`);
  if (fails.length > 8) console.log(`  … ${fails.length - 8} more`);
  console.log('');
}
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify(raw, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
s.close();
setTimeout(() => process.exit(0), 300);
