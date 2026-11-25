// Is the Core the version this client was tested with? TapHome changes the protocol from time to time, so every
// session compares the Core's versions with schema/tested.json (see session.mjs); this tool shows the comparison and
// checks that the committed schema still fits the live Core: the whole reconnect reply and every smart rule must
// decode with no unknown fields and re-encode to the same bytes.
//   node probe/version.mjs          report. Exit 0 = tested Core, 1 = untested but the schema fits, 2 = the schema does not fit
//   node probe/version.mjs accept   record the live Core as tested (only when the schema fits and the protocol matches)
import { writeFileSync } from 'node:fs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';
import { openSession, TESTED, TESTED_FILE } from './session.mjs';
import { loadConfig } from './config.mjs';

const [, , cmd] = process.argv;
if (cmd && cmd !== 'accept') { console.error('usage: node version.mjs [accept]'); process.exit(2); }
const cfg = loadConfig();
const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema);

const s = await openSession({ ...cfg.session(), tagMap: schema.tagMap, log: () => {}, warn: false });
const raw = s.reconnectRaw;
const { live, tested, diffs } = s.versions;
s.close();

const same = (a, b) => (a === b ? 'same' : `TESTED ${b}`);
console.log(`core      ${live.version}   ${same(live.version, tested.version)}`);
console.log(`protocol  ${live.protocolVersion}   ${same(live.protocolVersion, tested.protocolVersion)}   (this client claims ${TESTED.client.protocolVersion}, app ${TESTED.client.softwareVersion})`);
const rDiff = diffs.find((d) => d.startsWith('smart rule'));
console.log(`rules     ${Object.keys(live.triggerVersions).length} smart rule types   ${rDiff ? rDiff.replace('smart rule formats ', 'CHANGED ') : 'same formats'}`);
console.log(`tested on ${TESTED.testedOn}`);

// schema fit: markers the decoder leaves for what it could not decode, then decode -> encode -> same bytes
const MARKS = ['$unknown', '$unknownType', '$unknownClass', '$error', '$wireMismatch'];
function marks(o, path = '', out = []) {
  if (!o || typeof o !== 'object' || out.length >= 10) return out;
  for (const k of MARKS) if (k in o) out.push(`${path || '(root)'} ${k}${k === '$unknown' ? ` fields ${o[k]}` : ''}`);
  for (const [k, v] of Object.entries(o)) if (!MARKS.includes(k)) marks(v, `${path}.${k}`, out);
  return out;
}
const fits = (buf, cls) => { try { return enc.message(dec.message(buf, cls), cls).equals(buf); } catch { return false; } };

const conf = dec.message(raw, 'MessageBase');
const problems = marks(conf).map((m) => `decode: ${m}`);
if (!fits(raw, 'MessageBase')) problems.push('reconnect reply does not re-encode to the same bytes');
const blobs = (conf.SmartRules || []).map((b) => Buffer.from(b, 'base64'));
const badRules = blobs.filter((b) => marks(dec.message(b, 'TriggerModel')).length || !fits(b, 'TriggerModel')).map((b) => dec.message(b, 'TriggerModel').Id);
if (badRules.length) problems.push(`smart rules that do not decode/re-encode cleanly: ${badRules.slice(0, 20).join(', ')}${badRules.length > 20 ? ' …' : ''}`);
console.log(problems.length ? `schema    DOES NOT FIT:\n${problems.map((p) => `  ${p}`).join('\n')}` : `schema    fits (reconnect ${raw.length} B and ${blobs.length} smart rules decode and re-encode byte for byte)`);

if (cmd !== 'accept') {
  console.log(diffs.length ? '\n=> UNTESTED Core: writes are refused. When the schema fits, node probe/version.mjs accept records it as tested.' : '\n=> tested Core');
  setTimeout(() => process.exit(problems.length ? 2 : diffs.length ? 1 : 0), 300);
} else if (problems.length) {
  console.error('\n[refused] the schema does not fit this Core: regenerate it first (README: "When TapHome updates the protocol")');
  setTimeout(() => process.exit(2), 300);
} else if (live.protocolVersion !== TESTED.client.protocolVersion) {
  console.error(`\n[refused] the Core speaks protocol ${live.protocolVersion}, this client claims ${TESTED.client.protocolVersion}. Regenerate the schema from the `
    + 'matching app, set client.protocolVersion and client.softwareVersion in schema/tested.json, then accept again');
  setTimeout(() => process.exit(2), 300);
} else if (!diffs.length) {
  console.log('\n=> already the tested Core, nothing to record');
  setTimeout(() => process.exit(0), 300);
} else {
  const today = new Date().toLocaleDateString('sv-SE');
  writeFileSync(TESTED_FILE, `${JSON.stringify({ ...TESTED, core: live, testedOn: today }, null, 2)}\n`);
  console.log(`\n[accept] schema/tested.json now records core "${live.version}" (tested ${today}). Commit it.`
    + '\n  Reads are verified. Writes are allowed again; try the kinds you use on TEST devices and rules first.');
  setTimeout(() => process.exit(0), 300);
}
