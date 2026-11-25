// Send any request message (given as JSON) and print the decoded reply. For exploring the protocol.
//
//   node ask.mjs '{"$type":"MessageGetDeviceLogRequest","DeviceId":74}'
//   node ask.mjs @request.json
//
// Only requests whose class name looks read-only (Get…, …History…, …Info…, …Diagnostics…) are sent; anything else
// needs --write. DRY=1 prints the encoded frame without connecting. WATCH=<s> keeps listening that long after the
// reply and prints unsolicited messages (e.g. log broadcasts after a subscribe).
// A MessageDeviceValueHistoryDataResponse's Container is decoded too and printed as [utc time, value] points.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';
import { historyPoints, logLine, lastRunLines } from './lib.mjs';

const cfg = loadConfig();
const [, , reqArg, ...flags] = process.argv;
if (!reqArg) { console.error('usage: node ask.mjs <json|@file> [--write]'); process.exit(2); }
const req = JSON.parse(reqArg.startsWith('@') ? readFileSync(reqArg.slice(1), 'utf8') : reqArg);
const READ_ONLY = /^Message(\w*Get[A-Z]\w*|\w*History\w*|\w*Info\w*|\w*Diagnostics\w*|\w*Discovery|GetUsed\w*Ports|\w*Download)Request$|^MessageGetWeekPlanProperties$/; // the last one has no Request suffix
if (!READ_ONLY.test(req.$type || '') && !flags.includes('--write')) {
  console.error(`[refused] ${req.$type} does not look read-only - add --write if you really mean to send it`); process.exit(2);
}

const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema, { strict: true });
const tagMap = loadSchema().tagMap;
const J = (o, sp) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : Number.isNaN(v) ? 'NaN' : v), sp);

const s = DRY() ? null : await openSession({ ...cfg.session(), tagMap, log: () => {} });
function DRY() { return !!process.env.DRY; }
const rid = s ? s.newRequestId() : 1;
const frame = enc.message({ ...req, RequestsId: rid }, 'MessageBase');
const back = dec.message(frame, 'MessageBase');
console.log(`[request] ${req.$type} ${frame.length} bytes ${J(back)}`);
if (!s) { console.log(`[dry] ${frame.toString('hex')}`); process.exit(0); }
if (!READ_ONLY.test(req.$type || '')) s.requireTested(req.$type);

s.conn.sendBinary(frame);
const t0 = Date.now(), watch = Number(process.env.WATCH || 0) * 1000;
let replied = 0;
const show = (raw) => {
  const m = P.unwrap(raw, tagMap);
  if (m.tag === 383) { for (const f of P.all(m.body, 1)) show(f.v); return; } // container of several messages
  if (m.requestsId === rid && m.type === P.TYPE.Response) {
    const r = dec.message(raw, 'MessageBase');
    let points;
    if (r.Container) {
      const c = dec.message(Buffer.from(r.Container, 'base64'), 'HistoryItemsContainer');
      points = historyPoints(c);
      r.Container = `(${Buffer.from(r.Container, 'base64').length} bytes, ${points.length} points, sessions: ${(c.HistoryItemsSessions || []).map((x) => Object.keys(x).filter((k) => /Values$/.test(k)).join('+')).join(', ')})`;
    }
    const log = r.ValueChangedLogEntries || r.AddedValueChangedLogEntries;
    if (r.$type === 'MessageGetScriptLastRunValuesReponse' && !process.env.RAW) { // script debugger: variables per capture step
      console.log(`[reply] +${Date.now() - t0} ms ${m.name} (RAW=1 for JSON)`);
      for (const l of lastRunLines(r)) console.log(`  ${l}`);
    } else if (log && !process.env.RAW) { // device log: one line per change
      console.log(`[reply] +${Date.now() - t0} ms ${m.name}: ${log.length} entries (RAW=1 for JSON)`);
      for (const e of log) console.log(`  ${logLine(e)}`);
    } else console.log(`[reply] +${Date.now() - t0} ms ${m.name}\n${J(r, 1)}`);
    if (points) for (const p of points) console.log(`  ${p[0]}  ${p[1]}${p[2] ? `  (session ${p[2]})` : ''}`);
    replied = Date.now();
  } else if (m.type !== P.TYPE.Broadcast || !/DeviceValueChanged|Ping/.test(m.name) || process.env.ALL) {
    if (replied || m.requestsId === rid) console.log(`[other] +${Date.now() - t0} ms ${m.name} ${J(dec.message(raw, 'MessageBase')).slice(0, 600)}`);
  }
};
while (Date.now() - t0 < 20000 + watch) {
  if (replied && Date.now() - replied > Math.max(watch, 500)) break;
  let raw;
  try { raw = await s.next(500); } catch { continue; }
  if (!raw) { console.log('[closed]'); break; }
  show(raw);
}
if (!replied) console.log('[timeout] no reply within 20 s');
s.close();
setTimeout(() => process.exit(0), 300);
