// Fills in "passwordSalt" in config.json from the installed TapHome Windows app, then checks it with one login.
// The salt is a string literal in the class TapHome.Core.Lib.Password of TapHome.Core.Lib.Common.dll; this reads it
// straight from the assembly's .NET metadata (no decompiler needed). The salt is never printed.
//
// Usage: node auth.mjs [path to TapHome.Core.Lib.Common.dll or the folder holding it]
//          Without a path: config.json "appDir", else (Windows) the installed Store app found with Get-AppxPackage.
//          Logs in once and stores the session (.session.json next to config.json), which the other tools reuse.
//        node auth.mjs status   config, salt and stored session; checks the stored session without the password
//        node auth.mjs logout   forget the stored session (the Core isn't contacted)
import { rmSync } from 'node:fs';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSession } from './session.mjs';
import { loadSchema } from './schema.mjs';
import { loadConfig } from './config.mjs';

const DLL = 'TapHome.Core.Lib.Common.dll';
const die = (m) => { console.error(m); process.exit(1); };

function findDll(arg, cfg) {
  const tryPath = (p) => {
    if (!p || !existsSync(p)) return null;
    if (statSync(p).isFile()) return p;
    for (const sub of ['', 'TapHome.Client.Desktop.Wpf']) if (existsSync(join(p, sub, DLL))) return join(p, sub, DLL);
    return null;
  };
  if (arg) return tryPath(arg) || die(`no ${DLL} at ${arg}`);
  const fromCfg = tryPath(cfg.appDir);
  if (fromCfg) return fromCfg;
  if (process.platform === 'win32') {
    try {
      const loc = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-AppxPackage -Name TapHome.TapHome).InstallLocation'], { encoding: 'utf8' }).trim();
      const p = tryPath(loc);
      if (p) return p;
    } catch { /* fall through */ }
  }
  die(`TapHome app not found. Install "TapHome" from the Microsoft Store, or pass the path of ${DLL} (or set "appDir" in config.json).`);
}

// ---- minimal .NET metadata reader: string literals (ldstr) used in the methods of one type ----
function typeStrings(buf, ns, name) {
  const u16 = (o) => buf.readUInt16LE(o), u32 = (o) => buf.readUInt32LE(o);
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error('not a PE file');
  const coff = pe + 4, nSec = u16(coff + 2), optSize = u16(coff + 16), opt = coff + 20;
  const dataDirs = opt + (u16(opt) === 0x20b ? 112 : 96);
  const secs = [];
  for (let i = 0, s = opt + optSize; i < nSec; i++, s += 40) secs.push({ va: u32(s + 12), vs: Math.max(u32(s + 8), u32(s + 16)), raw: u32(s + 20) });
  const off = (rva) => { const s = secs.find((x) => rva >= x.va && rva < x.va + x.vs); if (!s) throw new Error(`rva ${rva} outside sections`); return rva - s.va + s.raw; };
  const cli = off(u32(dataDirs + 14 * 8));
  const md = off(u32(cli + 8));
  if (u32(md) !== 0x424a5342) throw new Error('no CLI metadata');
  let p = md + 16 + u32(md + 12) + 2;
  const nStreams = u16(p); p += 2;
  const streams = {};
  for (let i = 0; i < nStreams; i++) {
    const o = u32(p), sz = u32(p + 4); p += 8;
    let e = p; while (buf[e]) e++;
    const nm = buf.toString('ascii', p, e); p = (e + 4) & ~3;
    streams[nm] = { o: md + o, sz };
  }
  const T = streams['#~'] || streams['#-'];
  const heap = buf[T.o + 6];
  const strIdx = heap & 1 ? 4 : 2, guidIdx = heap & 2 ? 4 : 2, blobIdx = heap & 4 ? 4 : 2;
  const valid = buf.readBigUInt64LE(T.o + 8);
  const rows = []; let q = T.o + 24;
  for (let t = 0; t < 64; t++) rows[t] = (valid >> BigInt(t)) & 1n ? (q += 4, u32(q - 4)) : 0;
  const idx = (t) => (rows[t] < 65536 ? 2 : 4);
  const coded = (bits, ts) => (Math.max(...ts.map((t) => rows[t])) < 1 << (16 - bits) ? 2 : 4);
  const resScope = coded(2, [0x00, 0x1a, 0x23, 0x01]), typeDefOrRef = coded(2, [0x02, 0x01, 0x1b]);
  const size = [
    2 + strIdx + 3 * guidIdx,                                   // 0 Module
    resScope + 2 * strIdx,                                      // 1 TypeRef
    4 + 2 * strIdx + typeDefOrRef + idx(4) + idx(6),            // 2 TypeDef
    idx(4),                                                     // 3 FieldPtr
    2 + strIdx + blobIdx,                                       // 4 Field
    idx(6),                                                     // 5 MethodPtr
    4 + 2 + 2 + strIdx + blobIdx + idx(8),                      // 6 MethodDef
  ];
  const start = []; let at = q;
  for (let t = 0; t <= 6; t++) { start[t] = at; at += rows[t] * size[t]; }
  const rd = (o, n) => (n === 2 ? u16(o) : u32(o));
  const str = (i) => { const s = streams['#Strings'].o + i; let e = s; while (buf[e]) e++; return buf.toString('utf8', s, e); };
  const td = (r) => { const o = start[2] + r * size[2]; return {
    name: str(rd(o + 4, strIdx)), ns: str(rd(o + 4 + strIdx, strIdx)),
    methods: rd(o + 4 + 2 * strIdx + typeDefOrRef + idx(4), idx(6)) }; };
  let r = 0;
  for (; r < rows[2]; r++) { const t = td(r); if (t.name === name && t.ns === ns) break; }
  if (r === rows[2]) throw new Error(`type ${ns}.${name} not found`);
  const first = td(r).methods, last = r + 1 < rows[2] ? td(r + 1).methods : rows[6] + 1;
  const us = (o) => {
    let i = streams['#US'].o + o, len = buf[i];
    if ((len & 0x80) === 0) i += 1; else if ((len & 0xc0) === 0x80) { len = ((len & 0x3f) << 8) | buf[i + 1]; i += 2; } else { len = buf.readUInt32BE(i) & 0x1fffffff; i += 4; }
    return buf.toString('utf16le', i, i + len - 1);
  };
  const out = [];
  for (let m = first; m < last; m++) {
    const rva = u32(start[6] + (m - 1) * size[6]);
    if (!rva) continue;
    const b = off(rva);
    const [code, len] = (buf[b] & 3) === 2 ? [b + 1, buf[b] >> 2] : [b + (u16(b) >> 12) * 4, u32(b + 4)];
    for (let i = code; i < code + len - 4; i++) if (buf[i] === 0x72 && buf[i + 4] === 0x70) out.push(us(buf.readUIntLE(i + 1, 3)));
  }
  return [...new Set(out)];
}

const cfg = loadConfig();
const raw = JSON.parse(readFileSync(cfg.file, 'utf8'));
const cmd = process.argv[2];

if (cmd === 'logout') {
  if (cfg.sessionFile && existsSync(cfg.sessionFile)) rmSync(cfg.sessionFile);
  console.log('[auth] stored session removed');
  process.exit(0);
}
if (cmd === 'status') {
  const set = (k) => (raw[k] && !/^local admin password/.test(raw[k]) ? 'set' : 'MISSING');
  console.log(`[auth] config ${cfg.file}: host ${set('host')}, username ${set('username')}, password ${set('password')}, passwordSalt ${set('passwordSalt')}`);
  const store = cfg.sessionFile && existsSync(cfg.sessionFile) ? JSON.parse(readFileSync(cfg.sessionFile, 'utf8')) : {};
  const key = `${cfg.cred().isLocal ? 'local' : 'cloud'}:${cfg.host}:${cfg.cred().u.toLowerCase()}`;
  if (!store[key]) { console.log('[auth] no stored session: run node probe/auth.mjs'); process.exit(1); }
  console.log(`[auth] stored session for ${cfg.cred().u} on ${cfg.host}, saved ${store[key].savedAt}`);
  try {
    const s = await openSession({ ...cfg.session(), tagMap: loadSchema().tagMap, log: () => {}, noLogin: true });
    s.close();
    console.log(`[auth] stored session valid (${s.reconnectRaw.length} bytes of configuration)`);
  } catch (e) { console.log(`[auth] ${e.message}: run node probe/auth.mjs`); process.exit(1); }
  process.exit(0);
}
for (const k of ['host', 'username', 'password']) if (!raw[k] || /^local admin password/.test(raw[k])) die(`config.json: set "${k}" first`);

const dll = findDll(cmd, raw);
console.log(`[auth] reading ${dll}`);
const candidates = typeStrings(readFileSync(dll), 'TapHome.Core.Lib', 'Password').filter((s) => s.length >= 16).sort((a, b) => b.length - a.length);
if (!candidates.length) die('no salt candidate found in TapHome.Core.Lib.Password (the app version may have changed)');
if (candidates.length > 1) console.log(`[auth] ${candidates.length} candidates; trying the longest first`);

const { tagMap } = loadSchema();
let salt = null;
for (const c of candidates.slice(0, 3)) {
  try {
    const s = await openSession({ host: cfg.host, cred: cfg.cred(), salt: c, tagMap, log: () => {}, sessionFile: cfg.sessionFile, fresh: true });
    s.close(); salt = c; break;
  } catch (e) {
    if (/LoginResult/.test(e.message)) { console.log(`[auth] candidate rejected (${e.message})`); continue; }
    die(`[auth] could not reach the Core at ${cfg.host}: ${e.message}`);
  }
}
if (!salt) die('[auth] login failed with every candidate: check "username" and "password" in config.json');

// keep the file's layout: replace the value in place, or add the key after "password"
let text = readFileSync(cfg.file, 'utf8');
const val = JSON.stringify(salt).replace(/\$/g, '$$$$');
text = /"passwordSalt"\s*:\s*"(?:[^"\\]|\\.)*"/.test(text)
  ? text.replace(/"passwordSalt"\s*:\s*"(?:[^"\\]|\\.)*"/, `"passwordSalt": ${val}`)
  : text.replace(/("password"\s*:\s*"(?:[^"\\]|\\.)*")/, `$1,\n  "passwordSalt": ${val}`);
if (JSON.parse(text).passwordSalt !== salt) die('[auth] could not update config.json; nothing written');
writeFileSync(cfg.file, text);
console.log(`[auth] login ok as ${cfg.cred().u} on ${cfg.host}; passwordSalt (${salt.length} chars) saved to ${cfg.file}`);
if (cfg.sessionFile) console.log(`[auth] session stored in ${cfg.sessionFile}; the tools reuse it (NO_SESSION=1 logs in every time)`);
