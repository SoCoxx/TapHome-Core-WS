// Smart rule write test: create / rename / delete a rule the way the TapHome app does.
//   create  MessageUpdateTriggerModelsRequest (299) { 1: TriggerModel }   Id 0 = new rule
//   rename  same message, with the rule's own bytes (from a fresh reconnect) and only field 3 (Name) replaced
//   delete  MessageDeleteTriggerModelsRequest (301) { 1: TriggerIds }
// The Core answers MessageGenericResponse (ErrorCode 1 = ok, 16 = incompatible smart rule version) and broadcasts
// MessageTriggerModelsUpdatedBroadcast (300: 1 = rule blobs, 2 = changeset) / MessageTriggerModelsDeletedBroadcast (302).
//
// Usage: node rules-write.mjs create <buttonId> <name>
//        node rules-write.mjs rename <ruleId> <newName>
//        node rules-write.mjs delete <ruleId>
// env: DRY=1 builds and decodes the frame but does not send it (for rename/delete it still connects to read the rule)
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , cmd, arg1, ...rest] = process.argv;
const arg2 = rest.join(' ');
const schema = loadSchema();
const dec = makeDecoder(schema);
const tagMap = loadSchema().tagMap;
const outDir = join(fileURLToPath(new URL('..', import.meta.url)), 'out');
mkdirSync(outDir, { recursive: true });
const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

// replace (or add) one top-level length-delimited field in a protobuf message, keeping every other byte as is
function replaceField(buf, field, value) {
  const fs = P.decode(buf);
  const parts = [];
  let i = 0, done = false;
  // re-walk raw bytes so untouched fields are copied verbatim
  const rv = () => { let r = 0n, s = 0n, b; do { b = buf[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const start = i;
    const k = Number(rv()), f = k >> 3, wt = k & 7;
    if (wt === 0) rv(); else if (wt === 1) i += 8; else if (wt === 5) i += 4; else if (wt === 2) { const l = Number(rv()); i += l; } else throw new Error(`wire type ${wt}`);
    if (f === field) { if (!done) parts.push(P.fString(field, value)); done = true; } else parts.push(buf.subarray(start, i));
  }
  if (!done) parts.push(P.fString(field, value));
  if (!fs.length) throw new Error('empty message');
  return Buffer.concat(parts);
}

let frameBody, tag, expectBroadcast, session;
const open = async () => (session ||= await openSession({ ...cfg.session(), tagMap }));
const currentRules = async () => {
  const s = await open();
  const blobs = dec.message(s.reconnectRaw, 'MessageBase').SmartRules || [];
  return blobs.map((b) => Buffer.from(b, 'base64')).map((b) => ({ b, r: dec.message(b, 'TriggerModel') }));
};

if (cmd === 'create') {
  const buttonId = Number(arg1);
  if (!buttonId || !arg2) throw new Error('create <buttonId> <name>');
  // TriggerModel: 2 TriggerTypeId=27 (PushButtonTrigger), 3 Name, 4 Version=12 (TriggerVersions[27] from the Core),
  // IsEnabled false (default -> omitted), 12 TriggerParameters = TriggerParametersBase{100: PushButtonTriggerParameters{1: PushButtonIds}}
  // No actions, no Priorities/TriggerInputs (the Core derives them). Byte layout copied from existing rule #20.
  const model = Buffer.concat([
    P.fVarint(2, 27), P.fString(3, arg2), P.fVarint(4, 12),
    P.fBytes(12, P.fBytes(100, P.fVarint(1, buttonId))),
  ]);
  const decoded = dec.message(model, 'TriggerModel');
  const want = { TriggerTypeId: 27, Name: arg2, Version: 12, TriggerParameters: { $type: 'PushButtonTriggerParameters', PushButtonIds: [buttonId] } };
  console.log('[model]', model.toString('hex'));
  console.log('[decoded]', show(decoded));
  if (show(decoded) !== show(want) || dec.errors.length) { console.error('[abort] decoded model differs from intent', dec.errors); process.exit(1); }
  console.log('[check] decodes exactly to the intended rule');
  frameBody = P.fBytes(1, model); tag = 299; expectBroadcast = 300;
} else if (cmd === 'rename') {
  const id = Number(arg1);
  const hit = (await currentRules()).find((x) => x.r.Id === id && !x.r.IsDeleted);
  if (!hit) throw new Error(`rule ${id} not found`);
  if (!/^TEST /.test(hit.r.Name)) throw new Error(`refusing to touch rule ${id} "${hit.r.Name}" (not a TEST rule)`);
  const model = replaceField(hit.b, 3, arg2);
  const before = dec.message(hit.b, 'TriggerModel'), after = dec.message(model, 'TriggerModel');
  console.log('[before]', show(before));
  console.log('[after] ', show(after));
  if (show({ ...before, Name: arg2 }) !== show(after)) { console.error('[abort] patch changed more than the name'); process.exit(1); }
  console.log('[check] only Name differs');
  frameBody = P.fBytes(1, model); tag = 299; expectBroadcast = 300;
} else if (cmd === 'delete') {
  const id = Number(arg1);
  const hit = (await currentRules()).find((x) => x.r.Id === id && !x.r.IsDeleted);
  if (!hit) throw new Error(`rule ${id} not found`);
  if (!/^TEST /.test(hit.r.Name)) throw new Error(`refusing to delete rule ${id} "${hit.r.Name}" (not a TEST rule)`);
  console.log('[delete]', id, hit.r.Name);
  frameBody = P.fVarint(1, id); tag = 301; expectBroadcast = 302;
} else {
  console.error('usage: create <buttonId> <name> | rename <ruleId> <newName> | delete <ruleId>');
  process.exit(2);
}

if (process.env.DRY) {
  console.log(`[dry] would send tag ${tag}: ${P.wrap(tag, frameBody, 2).toString('hex')}`);
  session?.close();
  setTimeout(() => process.exit(0), 300);
} else {
  const s = await open();
  s.requireTested(tagMap[tag].name);
  const rid = s.newRequestId();
  s.conn.sendBinary(P.wrap(tag, frameBody, rid));
  console.log(`[send] ${tagMap[tag].name} RequestsId=${rid}`);
  const t0 = Date.now();
  let reply = null, bc = null;
  const handle = (raw) => {
    const m = P.unwrap(raw, tagMap);
    if (m.tag === 383) { for (const f of P.all(m.body, 1)) handle(f.v); return; }
    if (m.requestsId === rid && m.type === P.TYPE.Response) {
      reply = dec.message(raw, 'MessageBase');
      console.log(`[reply] +${Date.now() - t0} ms ${m.name} ${show({ flags: reply.ResponseFlagsId ?? 0, ErrorCode: reply.ErrorCode ?? 0, ErrorMessage: reply.ErrorMessage })}`);
    } else if (m.tag === expectBroadcast) {
      bc = dec.message(raw, 'MessageBase');
      if (m.tag === 300) {
        const blobs = (bc.TriggerModels || []).map((b) => Buffer.from(b, 'base64'));
        for (const b of blobs) {
          const r = dec.message(b, 'TriggerModel');
          writeFileSync(join(outDir, `rule-${r.Id}.bin`), b);
          console.log(`[broadcast] +${Date.now() - t0} ms ${m.name} changeset=${bc.SmartRulesChangesetId} rule=${show(r)}`);
        }
      } else console.log(`[broadcast] +${Date.now() - t0} ms ${m.name} ${show(bc)}`);
    } else if (/Trigger|SmartRule/.test(m.name || '')) console.log(`[other] ${m.name}`);
  };
  while (Date.now() - t0 < 15000 && !(reply && bc && Date.now() - t0 > 1500)) {
    let raw;
    try { raw = await s.next(500); } catch { continue; }
    if (!raw) { console.log('[closed]', s.conn.closeInfo?.()); break; }
    handle(raw);
  }
  if (!reply) console.log('[reply] none within 15 s');
  if (!bc) console.log('[broadcast] none within 15 s');
  s.close();
  setTimeout(() => process.exit(0), 300);
}
