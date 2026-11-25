// Create, rename and delete virtual devices / variables the way the TapHome app does.
//
//   add    <Interface> <Model> <name>   MessageAddDeviceRequest (e.g. Variable VirtualVariableGeneral, PushButton VirtualPushButton)
//   rename <deviceId> <newName>         MessageUpdateDeviceNameRequest
//   delete <deviceId>                   MessageDeleteDeviceRequest {ForceDelete: true}, as the app sends it
//
// Safety: names must start with "TEST "; rename/delete only touch a device on CCU 1 (Virtual devices) whose current name
// starts with "TEST ". DRY=1 encodes and decodes the request without sending it.
// Replies: add -> MessageAddDeviceResponse {Ccus, AddedDevice}; rename/delete -> MessageGenericResponse
// (ErrorCode 1 = ok, 3 = device is still used somewhere, 15 = error).
//
// Usage: node devices-write.mjs add|rename|delete ...
import { join } from 'node:path';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , cmd, ...args] = process.argv;
const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema, { strict: true });
const tagMap = loadSchema().tagMap;
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const die = (m) => { console.error(m); process.exit(2); };

let req;
if (cmd === 'add') {
  const [intf, model, ...n] = args, name = n.join(' ');
  if (!intf || !model || !name.startsWith('TEST ')) die('usage: add <Interface> <Model> "TEST <name>"');
  req = { $type: 'MessageAddDeviceRequest', DeviceName: name, Interface: intf, Model: model, DeviceTypeId: 0 };
} else if (cmd === 'rename') {
  const [id, ...n] = args, name = n.join(' ');
  if (!+id || !name.startsWith('TEST ')) die('usage: rename <deviceId> "TEST <new name>"');
  req = { $type: 'MessageUpdateDeviceNameRequest', DeviceId: +id, Name: name };
} else if (cmd === 'delete') {
  if (!+args[0]) die('usage: delete <deviceId>');
  req = { $type: 'MessageDeleteDeviceRequest', DeviceId: +args[0], ForceDelete: true };
} else die('usage: add|rename|delete ...');

const frame0 = enc.message({ ...req, RequestsId: 1 }, 'MessageBase');
const back = dec.message(frame0, 'MessageBase');
delete back.RequestsId;
if (J(back) !== J(req)) die(`[abort] request does not decode back as intended: ${J(back)}`);
console.log(`[check] ${req.$type} ${frame0.length} bytes decodes exactly to ${J(req)}`);
if (process.env.DRY) { console.log('[dry] not sent'); process.exit(0); }

const s = await openSession({ ...cfg.session(), tagMap, log: () => {} });
const devices = dec.message(s.reconnectRaw, 'MessageBase').Devices || [];
if (cmd !== 'add') {
  const d = devices.find((x) => x.ID === req.DeviceId);
  if (!d) { console.error(`device ${req.DeviceId} not found`); s.close(); process.exit(1); }
  if (d.CcuId !== 1 || !String(d.Name).startsWith('TEST ')) {
    console.error(`[refused] device ${d.ID} "${d.Name}" (CCU ${d.CcuId}) is not a TEST virtual device`); s.close(); process.exit(1);
  }
  console.log(`[target] ${d.ID} "${d.Name}" ${d.Model}`);
} else if (devices.some((x) => x.Name === req.DeviceName)) {
  console.error(`[refused] a device named "${req.DeviceName}" already exists`); s.close(); process.exit(1);
}

s.requireTested(req.$type);
const rid = s.newRequestId();
s.conn.sendBinary(enc.message({ ...req, RequestsId: rid }, 'MessageBase'));
console.log(`[send] ${req.$type} RequestsId=${rid}`);
const t0 = Date.now();
let replied = 0;
const show = (raw) => {
  const m = P.unwrap(raw, tagMap);
  if (m.tag === 383) { for (const f of P.all(m.body, 1)) show(f.v); return; }
  if (m.requestsId === rid && m.type === P.TYPE.Response) {
    const r = dec.message(raw, 'MessageBase');
    if (r.AddedDevice) {
      const a = r.AddedDevice;
      console.log(`[reply] +${Date.now() - t0} ms ${m.name}: device ${a.ID} "${a.Name}" ${a.Model} (${a.Interface}) on CCU ${a.CcuId}`);
      console.log(`        properties ${J(a.DeviceProperties)}`);
      console.log(`        values ${J(a.CurrentValues)}`);
    } else console.log(`[reply] +${Date.now() - t0} ms ${m.name} ErrorCode=${r.ErrorCode ?? 0} "${r.ErrorMessage ?? ''}"`);
    replied = Date.now();
  } else if (!/DeviceValueChanged|Ping|Pong|Acknowledg/.test(m.name)) {
    console.log(`[other] +${Date.now() - t0} ms ${m.name} ${J(dec.message(raw, 'MessageBase')).slice(0, 300)}`);
  }
};
while (Date.now() - t0 < 15000 && !(replied && Date.now() - replied > 1500)) {
  let raw;
  try { raw = await s.next(500); } catch { continue; }
  if (!raw) { console.log('[closed]'); break; }
  show(raw);
}
if (!replied) console.log('[timeout] no reply within 15 s');
s.close();
setTimeout(() => process.exit(0), 300);
