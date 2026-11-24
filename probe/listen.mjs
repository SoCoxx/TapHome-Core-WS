// Listen-only session: prints every broadcast except the constant value-change / ping traffic, so a change made from
// another session (the app, or ask.mjs in a second terminal) shows whether the Core notifies other clients about it.
// Sends nothing after login. Usage: node listen.mjs [seconds=120]   env ALL=1 also shows value changes
import { join } from 'node:path';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , secArg] = process.argv;
const seconds = Number(secArg || 120);
const dec = makeDecoder(loadSchema());
const tagMap = loadSchema().tagMap;
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const QUIET = /DeviceValueChanged|Ping|Pong|Acknowledg|ModuleUptime/;

const s = await openSession({ ...cfg.session(), tagMap, log: () => {} });
console.log(`[listen] ${seconds} s, ${new Date().toLocaleTimeString('sv-SE')}`);
const t0 = Date.now();
const show = (raw) => {
  const m = P.unwrap(raw, tagMap);
  if (m.tag === 383) { for (const f of P.all(m.body, 1)) show(f.v); return; }
  if (QUIET.test(m.name) && !process.env.ALL) return;
  console.log(`[${new Date().toLocaleTimeString('sv-SE')}] ${m.name} ${J(dec.message(raw, 'MessageBase')).slice(0, 400)}`);
};
while (Date.now() - t0 < seconds * 1000) {
  let raw;
  try { raw = await s.next(1000); } catch { continue; }
  if (!raw) { console.log('[closed]'); break; }
  show(raw);
}
s.close();
setTimeout(() => process.exit(0), 300);
