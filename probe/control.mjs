// Sends one device command the way the TapHome app does (MessageDeviceAction, tag 101) and reports the
// Core's reply plus the value broadcasts that follow for that device.
//
// Usage: node control.mjs <deviceId> <action> [param ...]
//   action  set  -> see below (values by ValueLogType, like the REST API)
//   action  switch | dim-level | slide-level | blind-level | blind-slope | temperature | multi-value-switch |
//           variable-set-value | push-button | push-button-held | cct | hue-brightness | alarm | ...
//   param   typed like ProtoParameterBase: true/false -> Bool, a number -> Double (what the app sends for
//           levels, set points, multi-value states and variables), normal|long|double|tripple -> ClickKind.
//           Force a type with a prefix: int:3  long:3  float:1.5  double:1.5  str:abc  bool:true  click:long
// env: MODE=cloud (TapHome account from config.json), CORE_IP (overrides config.json host), DRY=1 (print the frame, do not connect), WATCH=<seconds after reply, default 4>
import { join } from 'node:path';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , devArg, action, ...rawParams] = process.argv;
if (!action) { console.error('usage: node control.mjs <deviceId> <action> [param ...]'); process.exit(2); }
const deviceId = Number(devArg);
const CLICK = { normal: 1, long: 2, double: 3, tripple: 4, triple: 4 };

// ProtoParameterBase include tags (ProtoParameterBase.cs); each subtype has its value in field 1
function param(s) {
  const m = /^(\w+):(.*)$/.exec(s);
  const [t, v] = m ? [m[1].toLowerCase(), m[2]] : [null, s];
  const inner = (tag, field) => P.fBytes(tag, field);
  if (t === 'str') return inner(100, P.fString(1, v));
  if (t === 'int') return inner(101, P.fVarint(1, Number(v)));
  if (t === 'long') return inner(102, P.fVarint(1, BigInt(v)));
  if (t === 'float') { const b = Buffer.alloc(4); b.writeFloatLE(Number(v)); return inner(111, Number(v) ? Buffer.concat([P.key(1, 5), b]) : Buffer.alloc(0)); }
  if (t === 'bool' || (!t && /^(true|false)$/i.test(v))) return inner(104, P.fBool(1, /^true$/i.test(v)));
  if (t === 'alarm') return inner(105, P.fVarint(1, Number(v))); // AlarmMode enum
  if (t === 'click' || (!t && CLICK[v.toLowerCase()])) return inner(106, P.fVarint(1, CLICK[v.toLowerCase()] ?? Number(v)));
  if (t === 'double' || (!t && v !== '' && !isNaN(Number(v)))) return inner(103, P.fDouble(1, Number(v)));
  throw new Error(`cannot type parameter "${s}"`);
}
// action "set": value by ValueLogType, like the REST setDeviceValue?valueTypeId=..&value=..
// params: <ValueLogType name or id>=<number>, e.g. VariableState=1  48=1  TemperatureSetPoint=21.5
// Resolved to the action key + parameter type the app itself sends (DeviceActionsHelper.GetDeviceKeyAction /
// GetValueToBe). The protocol also has MessageTapHomeApiSetDeviceValueRequest (a Values map), but a user
// session's handler rejects it with "Unknown device action received from App".
const schemaForEnums = loadSchema();
const VLT_NAME = schemaForEnums.enums.ValueLogType || {};
const VLT = Object.fromEntries(Object.entries(VLT_NAME).map(([id, n]) => [n.toLowerCase(), Number(id)]));
const BY_TYPE = {
  SwitchState: ['switch', (v) => `bool:${v > 0}`],
  AnalogOutputValue: ['dim-level', (v) => `double:${v}`], AnalogOutputDesiredValue: ['dim-level', (v) => `double:${v}`],
  TemperatureSetPoint: ['temperature', (v) => `double:${v}`],
  MultiValueSwitchState: ['multi-value-switch', (v) => `double:${v}`], MultiValueSwitchDesiredState: ['multi-value-switch', (v) => `double:${v}`],
  VariableState: ['variable-set-value', (v) => `double:${v}`],
  BlindsSlope: ['blind-slope', (v) => `double:${v}`],
  BlindsLevel: ['blind-level', (v) => `double:${v}`], SlideLevel: ['slide-level', (v) => `double:${v}`], // blind-level needs a slope-capable device
  ButtonPressed: ['push-button', (v) => `click:${v}`], ButtonHeldState: ['push-button-held', (v) => `bool:${v > 0}`],
  CorrelatedColorTemperature: ['cct', (v) => `double:${v}`], HueBrightness: ['hue-brightness', (v) => `double:${v}`],
  AlarmMode: ['alarm', (v) => `alarm:${v}`],
};
let sendAction = action, sendParams = rawParams;
if (action === 'set') {
  if (rawParams.length !== 1) throw new Error('set takes exactly one ValueLogType=value');
  const [k, v] = rawParams[0].split('=');
  const name = /^\d+$/.test(k) ? VLT_NAME[k] : VLT_NAME[VLT[k.toLowerCase()]];
  const map = BY_TYPE[name];
  if (!map || v == null || isNaN(Number(v))) throw new Error(`cannot set "${rawParams[0]}" (supported: ${Object.keys(BY_TYPE).join(', ')})`);
  sendAction = map[0]; sendParams = [map[1](Number(v))];
}
// the app sends ClickKind for push-button even when given a number
const params = sendParams.map((s) => (sendAction === 'push-button' && /^\d$/.test(s) ? `click:${s}` : s)).map(param);

const tagMap = loadSchema().tagMap;
const body = (name) => Buffer.concat([
  P.fVarint(1, deviceId), P.fString(2, name), P.fString(3, sendAction), ...params.map((p) => P.fBytes(4, p)),
]);

if (process.env.DRY) {
  console.log(`${sendAction}(${sendParams.join(', ')})`, P.wrap(101, body(''), 2).toString('hex'));
  process.exit(0);
}

const dec = makeDecoder(schemaForEnums);
const s = await openSession({ ...cfg.session(), tagMap });
const devices = dec.message(s.reconnectRaw, 'MessageBase').Devices || [];
const dev = devices.find((d) => d.ID === deviceId);
if (!dev) { console.error(`device ${deviceId} not found`); s.close(); process.exit(1); }
const vals = (d) => Object.fromEntries(Object.entries(d.CurrentValues || {}).map(([k, v]) => [k, v && typeof v === 'object' ? ('Value' in v ? v.Value : 0) : v]));
console.log(`[device] ${dev.ID} "${dev.Name}" ${dev.Model}  now ${JSON.stringify(vals(dev))}`);

// ValueLogType names for the broadcast's ValueTypeId
const vlt = schemaForEnums.enums.ValueLogType || {};

const rid = s.newRequestId();
const frame = P.wrap(101, body(dev.Name), rid);
console.log(`[send] ${sendAction}(${sendParams.join(', ')}) RequestsId=${rid} ${frame.length} bytes`);
s.conn.sendBinary(frame);

const WATCH = Number(process.env.WATCH ?? 4) * 1000;
let replyAt = null;
const t0 = Date.now();
const handle = (raw) => {
  const m = P.unwrap(raw, tagMap);
  if (m.tag === 383) { for (const f of P.all(m.body, 1)) handle(f.v); return; }
  if (m.requestsId === rid && m.type === P.TYPE.Response) {
    replyAt = Date.now();
    const d = dec.message(raw, 'MessageBase');
    const flags = d.ResponseFlagsId ?? 0;
    console.log(`[reply] +${replyAt - t0} ms ${m.name} flags=${flags} (${['', 'Handled', 'Failed', 'Handled|Failed'][flags] || 'None'})` +
      `${d.ErrorMessage ? ' error="' + d.ErrorMessage + '"' : ''}${d.ErrorCode ? ' code=' + d.ErrorCode : ''}`);
    return;
  }
  if (m.tag === 107 && P.int32(P.get(m.body, 1)?.v) === deviceId) {
    const vt = P.int32(P.get(m.body, 2)?.v);
    const vf = P.get(m.body, 3);
    const v = vf ? vf.v.readDoubleLE(0) : 0; // fixed64; omitted when 0
    console.log(`[value] +${Date.now() - t0} ms ${vlt[vt] ?? vt} = ${v}`);
  }
};
while (Date.now() - t0 < 15000 && !(replyAt && Date.now() - replyAt > WATCH)) {
  let raw;
  try { raw = await s.next(500); } catch { continue; }
  if (!raw) { console.log('[closed]'); break; }
  handle(raw);
}
if (!replyAt) console.log('[reply] none within 15 s');
s.close();
setTimeout(() => process.exit(0), 300);
