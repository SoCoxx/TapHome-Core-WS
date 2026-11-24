// Media library ("Moja lokalita → Knižnica médií"): list, download, upload, delete.
//
//   list                         MessageGetMediaListRequest + the metadata of every item (read-only)
//   get    <id> [outDir=out/media]  download in chunks (the Core sends at most 4096 B per chunk), verify the MD5 (read-only)
//   put    <file> <TEST name> [purpose=2]   upload like the app: one metadata message (Position 0, no Buffer), then
//                                 80000-byte chunks, every message carrying the MD5 of the whole file
//   delete <id>                  MessageDeleteMediaRequest - only for items whose OriginalMediaName starts with "TEST"
//
// MediaPurpose: 0 Unknown, 1 DashboardBackground, 2 SchemeBackground. The app converts images to WebP before upload
// (MediaType "Webp"); "Png" is the other type it can send. The thumbnail (here: the file itself when it is small) goes
// with the metadata message. DRY=1 builds the upload messages without sending them.
// Usage: node media.mjs list|get|put|delete ...
import { join, basename, extname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
const [, , cmd, ...args] = process.argv;
const schema = loadSchema();
const dec = makeDecoder(schema), enc = makeEncoder(schema, { strict: true });
const tagMap = loadSchema().tagMap;
const die = (m) => { console.error(m); process.exit(2); };
const PURPOSE = { 0: 'Unknown', 1: 'DashboardBackground', 2: 'SchemeBackground' };

let upload;
if (cmd === 'put') { // build everything before connecting
  const [file, name, purposeArg] = args;
  if (!file || !name?.startsWith('TEST')) die('usage: put <file> "TEST <name>" [purpose=2]');
  const data = readFileSync(file), md5 = createHash('md5').update(data).digest().toString('base64');
  const type = { '.png': 'Png', '.webp': 'Webp' }[extname(file).toLowerCase()] || die('only .png or .webp');
  const id = randomUUID(), b64 = data.toString('base64');
  const msgs = [{ $type: 'MessageMediaUploadRequest', Id: id, MediaPurposeId: Number(purposeArg ?? 2), OriginalMediaName: name, MediaType: type,
    ...(data.length <= 16384 ? { Thumbnail: b64, ThumbnailType: type } : {}), FinalSize: data.length, Position: 0, Md5Hash: md5 }];
  for (let pos = 0; pos < data.length; pos += 80000)
    msgs.push({ $type: 'MessageMediaUploadRequest', Id: id, FinalSize: data.length, Position: pos, Buffer: data.subarray(pos, pos + 80000).toString('base64'), Md5Hash: md5 });
  for (const m of msgs) { const back = dec.message(enc.message({ ...m, RequestsId: 1 }, 'MessageBase'), 'MessageBase'); delete back.RequestsId;
    if (JSON.stringify(back) !== JSON.stringify(m)) die('[abort] upload message does not decode back as intended'); }
  console.log(`[check] ${msgs.length} upload message(s) for ${basename(file)} (${data.length} B, ${type}) as "${name}", id ${id}`);
  if (process.env.DRY) { console.log('[dry] not sent'); process.exit(0); }
  upload = { msgs, id };
} else if (!['list', 'get', 'delete'].includes(cmd)) die('usage: list | get <id> [outDir] | put <file> "TEST <name>" [purpose] | delete <id>');

const s = await openSession({ ...cfg.session(), tagMap, log: () => {} });
async function ask(req) {
  const rid = s.newRequestId();
  s.conn.sendBinary(enc.message({ ...req, RequestsId: rid }, 'MessageBase'));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    let raw;
    try { raw = await s.next(500); } catch { continue; }
    if (!raw) return null;
    const m = P.unwrap(raw, tagMap);
    const list = m.tag === 383 ? P.all(m.body, 1).map((f) => f.v) : [raw];
    for (const r of list) { const u = P.unwrap(r, tagMap); if (u.requestsId === rid && u.type === P.TYPE.Response) return dec.message(r, 'MessageBase'); }
  }
  return null;
}
const meta = async (id) => ask({ $type: 'MessageMediaDownloadRequest', Id: id, Position: 0, BufferSize: 1 });
const done = (code = 0) => { s.close(); setTimeout(() => process.exit(code), 300); };

if (cmd === 'list') {
  const l = await ask({ $type: 'MessageGetMediaListRequest' });
  console.log(`${l.MediaIds?.length ?? 0} item(s), ${l.UsedSpace ?? 0} of ${l.TotalSpace} B used`);
  for (const id of l.MediaIds || []) {
    const r = await meta(id);
    console.log(`  ${id}  ${PURPOSE[r.MediaPurposeId ?? 0]}  ${r.MediaType}  ${r.FinalSize} B  "${r.OriginalMediaName}"  uploaded ${new Date(Number(BigInt(r.UploadedOnTUtc ?? 0) / 10000n) - 62135596800000).toISOString().slice(0, 16)}`);
  }
  done();
} else if (cmd === 'get') {
  const [id, outArg] = args;
  const parts = []; let pos = 0, first, md5;
  do {
    const r = await ask({ $type: 'MessageMediaDownloadRequest', Id: id, Position: pos, BufferSize: 80000 });
    if (!r || r.ErrorMessage) { console.error(`[error] ${r ? r.ErrorMessage : 'no reply'}`); done(1); break; }
    first ||= r; md5 ||= r.Md5Hash;
    const b = Buffer.from(r.Buffer || '', 'base64');
    if (!b.length) break;
    parts.push(b); pos += b.length;
  } while (pos < first.FinalSize);
  if (first) {
    // the Core sends no Md5Hash on download; then check the size (and the RIFF size field of a WebP)
    const data = Buffer.concat(parts);
    const riffOk = data.subarray(0, 4).toString() !== 'RIFF' || data.readUInt32LE(4) + 8 === data.length;
    const ok = md5 ? createHash('md5').update(data).digest().toString('base64') === md5 : data.length === first.FinalSize && riffOk;
    const outDir = outArg || join(fileURLToPath(new URL('..', import.meta.url)), 'out', 'media');
    mkdirSync(outDir, { recursive: true });
    const ext = { Webp: '.webp', Png: '.png', Jpeg: '.jpg' }[first.MediaType] || '.bin';
    const file = join(outDir, `${id}${ext}`);
    writeFileSync(file, data);
    console.log(`[get] "${first.OriginalMediaName}" ${data.length}/${first.FinalSize} B in ${parts.length} chunk(s), ${md5 ? 'MD5' : 'size check'} ${ok ? 'ok' : 'MISMATCH'} -> ${file}`);
    done(ok ? 0 : 1);
  }
} else if (cmd === 'put') {
  for (const m of upload.msgs) {
    const r = await ask(m);
    console.log(`[put] position ${m.Position}${m.Buffer ? ` (${Buffer.from(m.Buffer, 'base64').length} B)` : ' (metadata)'}: ErrorCode=${r?.ErrorCode ?? 'no reply'} "${r?.ErrorMessage ?? ''}"`);
    if (!r || r.ErrorCode !== 1) { done(1); break; }
  }
  console.log(`[put] done, id ${upload.id}`);
  done();
} else if (cmd === 'delete') {
  const [id] = args;
  const r = await meta(id);
  if (!r || r.ErrorMessage || !String(r.OriginalMediaName).startsWith('TEST')) { console.error(`[refused] ${id} is not a TEST media item (${r?.OriginalMediaName ?? r?.ErrorMessage})`); done(1); }
  else {
    const d = await ask({ $type: 'MessageDeleteMediaRequest', MediaIds: [id] });
    console.log(`[delete] "${r.OriginalMediaName}": ErrorCode=${d?.ErrorCode ?? 'no reply'} "${d?.ErrorMessage ?? ''}"`);
    done();
  }
}
