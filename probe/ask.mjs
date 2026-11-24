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

const TH_EPOCH = Date.UTC(2016, 0, 1); // TapHomeTime = seconds since 2016-01-01 UTC
// HistoryItemsSerializer.ProcessDeserializedContainer: per session a start time, time deltas (s) and one value array
function historyPoints(container) {
  const pts = [];
  for (const s of container.HistoryItemsSessions || []) {
    const n = (s.TimeDifferences?.length ?? 0) + 1;
    let t = TH_EPOCH + (s.StartedOn ?? 0) * 1000, acc = s.FirstIntValue ?? 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) t += s.TimeDifferences[i - 1] * 1000;
      let v;
      if (s.SingleValues) v = s.SingleValues[i];
      else if (s.DoubleValues) v = s.DoubleValues[i];
      else if (s.BitValues) v = (s.BitValues[i >> 5] >>> (i % 32)) & 1;
      else {
        const abs = Object.entries(s).find(([k]) => /^AbsoluteInt\d+Values$/.test(k));
        const rel = Object.entries(s).find(([k]) => /^RelativeInt\d+Values$/.test(k));
        if (abs) { const raw = abs[1][i], sc = +abs[0].match(/\d+/)[0]; v = raw < -8000000 ? NaN : raw / sc; }
        else if (rel) { if (i > 0) acc += rel[1][i - 1]; const sc = +rel[0].match(/\d+/)[0]; v = acc < -8000000 ? NaN : acc / sc; }
      }
      pts.push([new Date(t).toISOString(), v, s.SessionId ?? 0]);
    }
  }
  return pts;
}

// ValueChangedDeviceLogEntry: TapHomeTime, Values [{Key: ValueLogType, Value}], ChangeOriginId (enum ChangeOrigin),
// HandlingStatus {LastTriggerId = smart rule (-1 = rule no longer exists), SourceUserId, FirstDeviceId = what started it}
const ORIGIN = schema.enums.ChangeOrigin || {};
function logLine(e) {
  const t = new Date(TH_EPOCH + (e.TapHomeTime ?? 0) * 1000).toLocaleString('sv-SE');
  const vals = (e.Values || []).map((v) => `${v.Key}=${Number.isNaN(v.Value) ? 'NaN' : v.Value}`).join(' ');
  const h = e.HandlingStatus || {};
  const via = [h.LastTriggerId && `rule ${h.LastTriggerId}`, h.FirstDeviceId && `from device ${h.FirstDeviceId}`,
    h.SourceUserId && `user ${h.SourceUserId.slice(0, 8)}`].filter(Boolean).join(', ');
  return `${t}  ${vals}  [${ORIGIN[e.ChangeOriginId ?? 0] ?? e.ChangeOriginId}]${via ? `  ${via}` : ''}`;
}

// Script variable value (DataType): SerializerValueTypeId = EDataTypeProtobuf, the number sits in the low bytes of
// SerializerValueBytes (an int64 used as raw memory, little endian), strings/objects in ProtoString (JSON for objects)
const DT = { 0: 'Null', 1: 'Int', 2: 'UInt', 3: 'Float', 4: 'Double', 5: 'Int8', 6: 'UInt8', 7: 'Int16', 8: 'UInt16', 9: 'Int64', 10: 'UInt64', 11: 'Bool', 12: 'Char', 13: 'String' };
function dataType(d) {
  if (!d) return 'null';
  const t = DT[d.SerializerValueTypeId ?? 0] ?? `type${d.SerializerValueTypeId}`;
  if (d.ProtoString !== undefined) return t === 'String' ? JSON.stringify(d.ProtoString.length > 200 ? `${d.ProtoString.slice(0, 200)}…` : d.ProtoString) : `${t} ${d.ProtoString}`;
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(d.SerializerValueBytes ?? 0));
  const v = { Null: 'null', Int: b.readInt32LE(), UInt: b.readUInt32LE(), Float: b.readFloatLE(), Double: b.readDoubleLE(), Int8: b.readInt8(), UInt8: b.readUInt8(),
    Int16: b.readInt16LE(), UInt16: b.readUInt16LE(), Int64: b.readBigInt64LE(), UInt64: b.readBigUInt64LE(), Bool: !!b[0], Char: JSON.stringify(String.fromCharCode(b.readUInt16LE())) }[t];
  return v === undefined ? `${t} raw=${d.SerializerValueBytes}` : `${v}${['Double', 'Float', 'Int', 'Bool', 'String', 'Null'].includes(t) ? '' : ` (${t})`}`;
}

const s = DRY() ? null : await openSession({ ...cfg.session(), tagMap, log: () => {} });
function DRY() { return !!process.env.DRY; }
const rid = s ? s.newRequestId() : 1;
const frame = enc.message({ ...req, RequestsId: rid }, 'MessageBase');
const back = dec.message(frame, 'MessageBase');
console.log(`[request] ${req.$type} ${frame.length} bytes ${J(back)}`);
if (!s) { console.log(`[dry] ${frame.toString('hex')}`); process.exit(0); }

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
      const v = r.Values;
      console.log(`[reply] +${Date.now() - t0} ms ${m.name} (RAW=1 for JSON)`);
      if (!v) console.log('  no last run recorded');
      else {
        console.log(`  ran ${v.RunTimestampUtc} in ${v.RunDuration ?? '0s'}, result = ${dataType(v.Result)}`);
        for (const [step, vars] of Object.entries(v.ValuesParameter || {}))
          for (const [name, d] of Object.entries(vars)) console.log(`  step ${step}  ${name} = ${dataType(d)}`);
      }
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
