// Edit any smart rule as JSON and write it back to the Core.
//
//   pull    <id>          read the live rule -> out/edit/<id>.json (edit this) + out/edit/<id>.orig.bin (undo copy)
//   push    <id> [--send] encode out/edit/<id>.json and, with --send, store it on the Core
//   restore <id> [--send] put out/edit/<id>.orig.bin (the rule as it was at pull time) back
//
// Read-only unless --send is given. Before sending, push checks that:
//  - the live rule is still byte-identical to the one pulled (nobody changed it in the app meanwhile)
//  - the JSON has no unknown keys (strict encoder), Id / TriggerTypeId are unchanged
//  - the encoded bytes decode back to exactly the edited JSON
// and prints a field-level diff live -> edited. Unchanged maps keep their original entry order, so pushing an
// unedited file produces the live bytes exactly.
// The Core answers MessageGenericResponse ErrorCode 1 = ok (16 = incompatible smart rule version) and broadcasts
// MessageTriggerModelsUpdatedBroadcast with the stored rule; push compares that with what was sent.
//
// Usage: node rule-edit.mjs pull|push|restore <ruleId> [--send]
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder, makeEncoder, WIRE_ORDER } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , cmd, idArg, ...flags] = process.argv;
const send = flags.includes('--send');
const id = Number(idArg);
if (!['pull', 'push', 'restore'].includes(cmd) || !id) { console.error('usage: pull|push|restore <ruleId> [--send]'); process.exit(2); }

const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema, { strict: true });
const tagMap = loadSchema().tagMap;
const editDir = join(fileURLToPath(new URL('..', import.meta.url)), 'out', 'edit');
mkdirSync(editDir, { recursive: true });
const jsonPath = join(editDir, `${id}.json`), origPath = join(editDir, `${id}.orig.bin`);
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : Number.isNaN(v) ? 'NaN' : v));

const s = await openSession({ ...cfg.session(), tagMap, log: () => {} });
const done = (code = 0) => { s.close(); setTimeout(() => process.exit(code), 300); };
const live = (dec.message(s.reconnectRaw, 'MessageBase').SmartRules || [])
  .map((b) => Buffer.from(b, 'base64')).map((b) => ({ b, r: dec.message(b, 'TriggerModel') }))
  .find((x) => x.r.Id === id && !x.r.IsDeleted);
if (!live) { console.error(`rule ${id} not found on the Core`); s.close(); process.exit(1); }

// field-level diff of two decoded objects
function diff(a, b, p = '', out = []) {
  if (J(a) === J(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${p}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
  } else out.push(`  ${p || '(root)'}: ${J(a) ?? '(absent)'}  ->  ${J(b) ?? '(absent)'}`);
  return out;
}
// carry the original map entry order onto the edited object (JSON files lose it)
function copyOrder(from, to) {
  if (!from || !to || typeof from !== 'object' || typeof to !== 'object') return;
  if (from[WIRE_ORDER]) to[WIRE_ORDER] = from[WIRE_ORDER];
  for (const k of Object.keys(to)) if (k in from) copyOrder(from[k], to[k]);
}

async function store(bytes, expect) {
  s.requireTested(`MessageUpdateTriggerModelsRequest rule ${id}`);
  const rid = s.newRequestId();
  s.conn.sendBinary(P.wrap(299, P.fBytes(1, bytes), rid));
  console.log(`[send] MessageUpdateTriggerModelsRequest rule ${id}, ${bytes.length} bytes`);
  const t0 = Date.now();
  let reply = null, stored = null;
  const handle = (raw) => {
    const m = P.unwrap(raw, tagMap);
    if (m.tag === 383) { for (const f of P.all(m.body, 1)) handle(f.v); return; }
    if (m.requestsId === rid && m.type === P.TYPE.Response) {
      reply = dec.message(raw, 'MessageBase');
      console.log(`[reply] +${Date.now() - t0} ms ErrorCode=${reply.ErrorCode ?? 0} "${reply.ErrorMessage ?? ''}"`);
    } else if (m.tag === 300) {
      for (const b of dec.message(raw, 'MessageBase').TriggerModels || []) {
        const r = dec.message(Buffer.from(b, 'base64'), 'TriggerModel');
        if (r.Id === id) stored = r;
      }
    }
  };
  while (Date.now() - t0 < 15000 && !(reply && stored)) {
    let raw;
    try { raw = await s.next(500); } catch { continue; }
    if (!raw) { console.log('[closed]'); break; }
    handle(raw);
  }
  if (!stored) { console.log('[broadcast] stored rule not seen within 15 s'); return; }
  // the Core sets ChangesetId and derives TriggerInputs / Priorities itself; report those separately
  const strip = ({ ChangesetId, TriggerInputs, LimitingConditionInputs, Priorities, ...r }) => r;
  const d = diff(strip(expect), strip(stored));
  console.log(d.length ? `[stored] differs from what was sent:\n${d.join('\n')}` : '[stored] the Core stored exactly what was sent');
  const derived = diff({ TriggerInputs: expect.TriggerInputs, LimitingConditionInputs: expect.LimitingConditionInputs, Priorities: expect.Priorities },
    { TriggerInputs: stored.TriggerInputs, LimitingConditionInputs: stored.LimitingConditionInputs, Priorities: stored.Priorities });
  if (derived.length) console.log(`[stored] fields the Core derived:\n${derived.join('\n')}`);
  console.log(`[stored] ChangesetId ${expect.ChangesetId} -> ${stored.ChangesetId}`);
}

if (cmd === 'pull') {
  writeFileSync(origPath, live.b);
  writeFileSync(jsonPath, JSON.stringify(live.r, null, 2));
  console.log(`[pull] rule ${id} "${live.r.Name}" (${live.r.TriggerParameters?.$type}) -> out/edit/${id}.json`);
  done();
} else if (cmd === 'push') {
  if (!existsSync(origPath) || !existsSync(jsonPath)) { console.error(`pull ${id} first`); done(1); }
  else if (!live.b.equals(readFileSync(origPath))) { console.error('[abort] the rule changed on the Core since pull - pull again and redo the edit'); done(1); }
  else {
    const edited = JSON.parse(readFileSync(jsonPath, 'utf8'));
    let ok = true;
    if (edited.Id !== id || edited.TriggerTypeId !== live.r.TriggerTypeId) { console.error('[abort] Id and TriggerTypeId must not change'); ok = false; }
    copyOrder(live.r, edited);
    let bytes;
    try { bytes = ok && enc.message(edited, 'TriggerModel'); } catch (e) { console.error(`[abort] ${e.message}`); ok = false; }
    if (ok && J(dec.message(bytes, 'TriggerModel')) !== J(edited)) {
      console.error('[abort] encoded bytes do not decode back to the edited JSON'); ok = false;
      console.error(diff(edited, dec.message(bytes, 'TriggerModel')).join('\n'));
    }
    if (ok) {
      const d = diff(live.r, edited);
      console.log(`[check] encodes cleanly, ${bytes.length} bytes${bytes.equals(live.b) ? ' (identical to live: nothing to change)' : ''}`);
      console.log(d.length ? `[diff] live -> edited:\n${d.join('\n')}` : '[diff] no changes');
      if (!send) console.log('[dry] not sent (add --send)');
      else if (d.length) await store(bytes, edited);
    }
    done(ok ? 0 : 1);
  }
} else if (cmd === 'restore') {
  if (!existsSync(origPath)) { console.error(`no out/edit/${id}.orig.bin`); done(1); }
  else {
    const orig = readFileSync(origPath), back = dec.message(orig, 'TriggerModel');
    const d = diff(live.r, back);
    console.log(d.length ? `[diff] live -> restored:\n${d.join('\n')}` : '[diff] live already equals the pulled version');
    if (!send) console.log('[dry] not sent (add --send)');
    else if (d.length) await store(orig, back);
    done();
  }
}
