// Offline encoder check: decode -> encode -> compare bytes. Never connects to the Core.
// Usage: node roundtrip.mjs [rules|reconnect]   (reads out/reconnect.json written by dump.mjs)
//   rules      every TriggerModel blob in SmartRules
//   reconnect  the whole MessageReconnectResponse (out/reconnect.bin, saved by dump.mjs)
import { readFileSync, existsSync } from 'node:fs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';

const [, , what = 'rules'] = process.argv;
const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema);
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

function check(label, orig, cls) {
  const obj = dec.message(orig, cls);
  let out;
  try { out = enc.message(obj, cls); } catch (e) { console.log(`${label} encode error: ${e.message}`); return 'error'; }
  if (out.equals(orig)) return 'same';
  const sem = J(dec.message(out, cls)) === J(obj);
  const at = firstDiff(orig, out);
  console.log(`${label} differs at byte ${at}/${orig.length} (re-decodes ${sem ? 'identical' : 'DIFFERENT'})\n` +
    `  orig ${orig.subarray(Math.max(0, at - 8), at + 24).toString('hex')}\n  new  ${out.subarray(Math.max(0, at - 8), at + 24).toString('hex')}`);
  return sem ? 'semantic' : 'different';
}

if (what === 'rules') {
  const d = JSON.parse(readFileSync(new URL('../out/reconnect.json', import.meta.url), 'utf8'));
  const tally = {};
  for (const b64 of d.SmartRules || []) {
    const orig = Buffer.from(b64, 'base64');
    const r = check(`#${dec.message(orig, 'TriggerModel').Id}`, orig, 'TriggerModel');
    tally[r] = (tally[r] || 0) + 1;
  }
  console.log(`[rules] ${d.SmartRules.length} blobs:`, tally);
} else {
  const f = new URL('../out/reconnect.bin', import.meta.url);
  if (!existsSync(f)) throw new Error('out/reconnect.bin missing - re-run dump.mjs');
  console.log('[reconnect]', check('MessageBase', readFileSync(f), 'MessageBase'));
}
