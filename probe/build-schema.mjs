// Regenerates schema/taphome-schema.json from the ILSpy-decompiled TapHome.Core.Lib.Model sources.
// Only needed when TapHome changes the protocol (a new app/Core version); the tools read the committed file.
// Usage: node build-schema.mjs [modelDir]   (default: "modelDir" from config.json)
// Prints what changed against the current file. Check `node probe/roundtrip.mjs reconnect` afterwards.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as P from './proto.mjs';
import { buildSchema, saveSchema, loadSchema, SCHEMA_FILE } from './schema.mjs';
import { loadConfig } from './config.mjs';

const modelDir = process.argv[2] || loadConfig().modelDir;
if (!modelDir || !existsSync(join(modelDir, 'TapHome.Core.Lib.Communication.Messages', 'MessageBase.cs')))
  throw new Error(`not a decompiled TapHome.Core.Lib.Model folder: ${modelDir}`);

const { classes, enums } = buildSchema(modelDir);
const tagMap = P.loadTagMap(join(modelDir, 'TapHome.Core.Lib.Communication.Messages'));
const info = join(modelDir, 'Properties', 'AssemblyInfo.cs');
const version = existsSync(info) ? /AssemblyInformationalVersion\("([^"]+)"\)/.exec(readFileSync(info, 'utf8'))?.[1] ?? null : null;
const meta = { source: 'TapHome.Core.Lib.Model', modelVersion: version, classes: Object.keys(classes).length, enums: Object.keys(enums).length, tags: Object.keys(tagMap).length };

if (existsSync(SCHEMA_FILE)) {
  const old = loadSchema();
  for (const [what, a, b] of [['class', old.classes, classes], ['enum', old.enums, enums], ['tag', old.tagMap, tagMap]]) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diff = [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (diff.length) console.log(`${what}: ${diff.length} changed: ${diff.slice(0, 20).join(', ')}${diff.length > 20 ? ', …' : ''}`);
  }
}
saveSchema({ classes, enums, tagMap, meta });
console.log(`[schema] ${SCHEMA_FILE}: ${meta.classes} classes, ${meta.enums} enums, ${meta.tags} message tags (${version ?? 'version unknown'})`);
