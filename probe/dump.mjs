// Dumps the full Core configuration (the decoded MessageReconnectResponse) to out/reconnect.json.
// Usage: node dump.mjs <access.txt> <decompiled TapHome.Core.Lib.Model dir>
// env: MODE=cloud (TapHome account from config.json), CORE_IP (overrides config.json host)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const tagMap = loadSchema().tagMap;
const t0 = Date.now();
const schema = loadSchema();
console.log(`[schema] ${Object.keys(schema.classes).length} classes, ${Object.keys(schema.enums).length} enums (${Date.now() - t0} ms)`);
const dec = makeDecoder(schema);

const s = await openSession({ ...cfg.session(), tagMap });
const doc = dec.message(s.reconnectRaw, 'MessageBase');
s.close();

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(doc, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
writeFileSync(join(outDir, 'reconnect.json'), json);
writeFileSync(join(outDir, 'reconnect.bin'), s.reconnectRaw); // raw bytes, for roundtrip.mjs
console.log(`[dump] out/reconnect.json ${(json.length / 1e6).toFixed(1)} MB`);

const errCount = {};
for (const e of dec.errors) errCount[e] = (errCount[e] || 0) + 1;
console.log('[decode errors]', errCount);
const shape = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `object(${Object.keys(v).length})` : v]));
console.log(shape);
setTimeout(() => process.exit(0), 300);
