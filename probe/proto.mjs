// Minimal protobuf-net codec for TapHome Core messages (no dependencies).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const TYPE = { None: 0, Request: 1, Response: 2, Broadcast: 3, Stream: 4, Acknowledgement: 5, Container: 6, Progress: 7 };

// include tag -> { name, type } built from the decompiled message classes
export function loadTagMap(msgDir) {
  const map = {};
  for (const m of readFileSync(join(msgDir, 'MessageBase.cs'), 'utf8').matchAll(/ProtoInclude\((\d+), typeof\((\w+)\)\)/g)) {
    const f = join(msgDir, m[2] + '.cs');
    const t = existsSync(f) ? /MessageType\s*=>\s*MessageType\.(\w+)/.exec(readFileSync(f, 'utf8')) : null;
    map[+m[1]] = { name: m[2], type: t ? TYPE[t[1]] : null };
  }
  return map;
}

export function varint(n) {
  n = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
export const key = (f, wt) => varint((f << 3) | wt);
export const fVarint = (f, v) => (v ? Buffer.concat([key(f, 0), varint(v)]) : Buffer.alloc(0));
export const fBool = (f, v) => (v ? Buffer.concat([key(f, 0), varint(1)]) : Buffer.alloc(0));
export const fBytes = (f, b) => Buffer.concat([key(f, 2), varint(b.length), b]);
export const fString = (f, s) => (s == null ? Buffer.alloc(0) : fBytes(f, Buffer.from(s, 'utf8')));

// .NET Guid.ToByteArray() order; protobuf-net bcl.Guid = { fixed64 lo = 1; fixed64 hi = 2 }
export function guidBytes(s) {
  const b = Buffer.from(s.replace(/[{}-]/g, ''), 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}
export function fGuid(f, s) {
  const b = guidBytes(s);
  return fBytes(f, Buffer.concat([key(1, 1), b.subarray(0, 8), key(2, 1), b.subarray(8)]));
}
export function decGuid(fld) {
  if (!fld) return null;
  const g = decode(fld.v);
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(get(g, 1)?.v.readBigUInt64LE(0) ?? 0n, 0);
  b.writeBigUInt64LE(get(g, 2)?.v.readBigUInt64LE(0) ?? 0n, 8);
  const r = (x) => Buffer.from(x).reverse().toString('hex');
  return `${r(b.subarray(0, 4))}-${r(b.subarray(4, 6))}-${r(b.subarray(6, 8))}-${b.subarray(8, 10).toString('hex')}-${b.subarray(10).toString('hex')}`;
}

export function decode(buf) {
  const fields = [];
  let i = 0;
  const rv = () => { let r = 0n, s = 0n, b; do { b = buf[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const k = Number(rv()); const f = k >> 3, wt = k & 7;
    if (wt === 0) fields.push({ f, wt, v: rv() });
    else if (wt === 1) { fields.push({ f, wt, v: buf.subarray(i, i + 8) }); i += 8; }
    else if (wt === 2) { const l = Number(rv()); fields.push({ f, wt, v: buf.subarray(i, i + l) }); i += l; }
    else if (wt === 5) { fields.push({ f, wt, v: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error(`wire type ${wt} at ${i}`);
  }
  return fields;
}
export const get = (fs, f) => fs.find((x) => x.f === f);
export const all = (fs, f) => fs.filter((x) => x.f === f);
export const int32 = (v) => Number(BigInt.asIntN(32, v ?? 0n));
export const str = (fld) => (fld ? Buffer.from(fld.v).toString('utf8') : null);

// MessageBase: subtype under its include tag first, then RequestsId (field 1)
export const wrap = (tag, inner, requestsId = 0) => Buffer.concat([fBytes(tag, inner), fVarint(1, requestsId)]);
export function unwrap(buf, tagMap) {
  const fs = decode(buf);
  const sub = fs.find((x) => x.f >= 99 && x.wt === 2);
  return { tag: sub?.f, ...(tagMap[sub?.f] || { name: `?${sub?.f}`, type: null }), requestsId: int32(get(fs, 1)?.v), body: sub ? decode(sub.v) : [] };
}

// salt = TapHome.Core.Lib.Password's constant, from config.json (passwordSalt)
export function passwordHash(secret, salt) {
  if (!salt) throw new Error('passwordSalt missing in config.json');
  let b = Buffer.from(secret + salt, 'utf8');
  for (let k = 0; k < 2; k++) b = createHash('sha512').update(b).digest();
  return b.toString('hex');
}

// protobuf-net writes double as fixed64 and, like every scalar, omits it when it equals the default (0)
export const fDouble = (f, v) => {
  if (!v) return Buffer.alloc(0);
  const b = Buffer.alloc(8); b.writeDoubleLE(v);
  return Buffer.concat([key(f, 1), b]);
};
