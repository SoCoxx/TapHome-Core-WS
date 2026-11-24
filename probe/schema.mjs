// Builds a protobuf schema from the ILSpy-decompiled TapHome.Core.Lib.Model sources and decodes
// any message into named JSON, following protobuf-net conventions (root-first inheritance via
// ProtoInclude, bcl Guid/DateTime/TimeSpan, non-packed repeated, maps as {1:key,2:value} entries).
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tools read the committed schema/taphome-schema.json. build-schema.mjs regenerates it from the decompiled
// TapHome.Core.Lib.Model sources (only needed when TapHome changes the protocol).
export const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'taphome-schema.json');
let cached = null;
export function loadSchema(file = SCHEMA_FILE) {
  if (file === SCHEMA_FILE && cached) return cached;
  const s = JSON.parse(readFileSync(file, 'utf8'));
  if (!s.classes || !s.enums || !s.tagMap) throw new Error(`${file} is not a schema file (run build-schema.mjs)`);
  if (file === SCHEMA_FILE) cached = s;
  return s;
}
// one line per class / enum / tag, so a regenerated schema diffs readably
export function saveSchema({ classes, enums, tagMap, meta }, file = SCHEMA_FILE) {
  const lines = (o, keys) => keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(',\n');
  const tags = lines(tagMap, Object.keys(tagMap).sort((a, b) => a - b));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    '{', `"meta": ${JSON.stringify(meta)},`,
    '"tagMap": {', tags, '},',
    '"enums": {', lines(enums, Object.keys(enums).sort()), '},',
    '"classes": {', lines(classes, Object.keys(classes).sort()), '}',
    '}', '',
  ].join('\n'));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.cs')) out.push(p);
  }
  return out;
}

export function buildSchema(srcDir) {
  const classes = {}; // name -> { fields: {n: {name, type, fmt}}, includes: {tag: className}, base }
  const enums = {};   // name -> { value: label }
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const stack = []; // { name, depth }
    let depth = 0, pendingIncludes = [], pendingMember = null, enumCtx = null, enumNext = 0;
    for (const raw of lines) {
      const line = raw.trim();
      const inc = /\[ProtoInclude\((\d+),\s*typeof\(([\w.]+)\)\)\]/.exec(line);
      if (inc) pendingIncludes.push([+inc[1], inc[2].split('.').pop()]);
      const cls = /\b(?:class|struct)\s+(\w+)(?:<[^>]*>)?(?:\s*\(.*?\))?(?:\s*:\s*([\w.<>]+))?/.exec(line);
      const en = /\benum\s+(\w+)/.exec(line);
      if (cls && !line.startsWith('//')) {
        const name = cls[1];
        const c = (classes[name] ||= { fields: {}, includes: {}, base: null });
        c.base = cls[2]?.split('.').pop()?.replace(/<.*$/, '') || c.base;
        for (const [t, n] of pendingIncludes) c.includes[t] = n;
        pendingIncludes = [];
        stack.push({ name, depth });
      } else if (en) {
        enumCtx = { name: en[1], depth };
        enums[en[1]] ||= {};
        enumNext = 0;
      } else if (enumCtx && depth === enumCtx.depth + 1) {
        const ev = /^(\w+)(?:\s*=\s*(-?(?:0x[0-9a-fA-F]+|\d+)))?\s*,?$/.exec(line);
        if (ev) {
          const v = ev[2] != null ? Number(ev[2]) : enumNext;
          enums[enumCtx.name][v] = ev[1];
          enumNext = v + 1;
        }
      }
      const pm = /\[ProtoMember\((\d+)([^\]]*)\)\]/.exec(line);
      if (pm) {
        const fmt = /DataFormat\.(\w+)/.exec(pm[2])?.[1] || null;
        pendingMember = { n: +pm[1], fmt, packed: /IsPacked\s*=\s*true/.test(pm[2]) };
      } else if (pendingMember) {
        const prop = /^(?:public|internal|private|protected)\s+(?:virtual\s+|override\s+|new\s+|required\s+)*([\w.<>,\[\]?\s]+?)\s+(\w+)\s*(?:\{|;|=(?!=)|$)/.exec(line); // `{` may be on the next line; `==` is an operator
        if (prop && stack.length) {
          classes[stack[stack.length - 1].name].fields[pendingMember.n] = { name: prop[2], type: prop[1].replace(/\s+/g, ''), fmt: pendingMember.fmt, packed: pendingMember.packed };
          pendingMember = null;
        }
      }
      for (const ch of raw) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (stack.length && depth === stack[stack.length - 1].depth) stack.pop();
          if (enumCtx && depth === enumCtx.depth) enumCtx = null;
        }
      }
    }
  }
  // ILSpy could not decode these attributes ("[ProtoMember(/*Could not decode attribute arguments.*/)]"), so the
  // regex above skips them. Numbers and DataFormat recovered from the IL (ilspycmd -il); the ints are ZigZag.
  const hs = classes.HistoryItemsSession;
  if (hs) {
    const f = (n, name, type, fmt = 'ZigZag') => (hs.fields[n] = { name, type, fmt, packed: true });
    f(4, 'SingleValues', 'float[]', null); f(5, 'DoubleValues', 'double[]', null); f(7, 'AbsoluteInt1Values', 'int[]');
    f(8, 'AbsoluteInt10Values', 'int[]'); f(9, 'AbsoluteInt100Values', 'int[]'); f(10, 'FirstIntValue', 'int');
    f(11, 'RelativeInt1Values', 'int[]'); f(12, 'RelativeInt10Values', 'int[]'); f(13, 'RelativeInt100Values', 'int[]');
    f(14, 'AbsoluteInt1000Values', 'int[]'); f(15, 'AbsoluteInt10000Values', 'int[]'); f(16, 'RelativeInt1000Values', 'int[]');
    f(17, 'RelativeInt10000Values', 'int[]'); f(18, 'AbsoluteInt200Values', 'int[]'); f(19, 'RelativeInt200Values', 'int[]');
    hs.fields[10].packed = false;
  }
  return { classes, enums };
}

// ---------- wire reader ----------
function readFields(buf) {
  const out = [];
  let i = 0;
  const rv = () => { let r = 0n, s = 0n, b; do { b = buf[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const k = Number(rv()); const f = k >> 3, wt = k & 7;
    if (wt === 0) out.push({ f, wt, v: rv() });
    else if (wt === 1) { out.push({ f, wt, v: buf.subarray(i, i + 8) }); i += 8; }
    else if (wt === 2) { const l = Number(rv()); out.push({ f, wt, v: buf.subarray(i, i + l) }); i += l; }
    else if (wt === 5) { out.push({ f, wt, v: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}

const INT_TYPES = new Set(['int', 'long', 'short', 'sbyte', 'Int32', 'Int64', 'Int16']);
const UINT_TYPES = new Set(['uint', 'ulong', 'ushort', 'byte', 'char', 'UInt32', 'UInt64', 'UInt16', 'Byte']);
const LIST_RE = /^(?:List|IList|ICollection|IEnumerable|IReadOnlyList|IReadOnlyCollection|HashSet|ISet|ConcurrentBag|Collection|ObservableCollection|SortedSet)<(.+)>$/;
const MAP_RE = /^(?:Dictionary|IDictionary|ConcurrentDictionary|SortedDictionary|IReadOnlyDictionary|SortedList)<(.+)>$/;

function splitGeneric(s) { // "A,B<C,D>" -> ["A","B<C,D>"]
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') d++;
    else if (s[i] === '>') d--;
    else if (s[i] === ',' && d === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return [s];
}

function guid(buf) {
  const g = readFields(buf);
  const b = Buffer.alloc(16);
  for (const x of g) if (x.wt === 1) x.v.copy(b, x.f === 1 ? 0 : 8);
  if (b.every((x) => x === 0)) return '00000000-0000-0000-0000-000000000000';
  const r = (x) => Buffer.from(x).reverse().toString('hex');
  return `${r(b.subarray(0, 4))}-${r(b.subarray(4, 6))}-${r(b.subarray(6, 8))}-${b.subarray(8, 10).toString('hex')}-${b.subarray(10).toString('hex')}`;
}
const zz = (v) => (v >> 1n) ^ -(v & 1n);
const TICKS_PER = [864000000000n, 36000000000n, 600000000n, 10000000n, 10000n, 1n];
function bclTicks(buf) { // bcl.TimeSpan/DateTime { sint64 value = 1; scale = 2 }
  let value = 0n, scale = 0;
  for (const x of readFields(buf)) { if (x.f === 1) value = zz(x.v); else if (x.f === 2) scale = Number(x.v); }
  if (scale === 15) return value < 0n ? 'MinValue' : 'MaxValue'; // scale MinMax: value 1 = MaxValue, -1 = MinValue
  return value * (TICKS_PER[scale] ?? 1n);
}

// Maps decode to plain objects, but JS objects list integer keys in ascending order, while protobuf-net
// writes a Dictionary in insertion order. The wire order is kept under this symbol (ignored by JSON.stringify,
// kept by {...spread}) so the encoder can reproduce the original bytes; keys added later go last.
export const WIRE_ORDER = Symbol('wireOrder');
function putMap(o, k, v) {
  (o[WIRE_ORDER] ||= []);
  if (!(k in o)) o[WIRE_ORDER].push(String(k));
  o[k] = v;
}
const orderedEntries = (o) => {
  const seen = new Set(), out = [];
  for (const k of o[WIRE_ORDER] || []) if (Object.hasOwn(o, k) && !seen.has(k)) { seen.add(k); out.push([k, o[k]]); }
  for (const [k, v] of Object.entries(o)) if (!seen.has(k)) out.push([k, v]);
  return out;
};

// exact decimal seconds from ticks (1 tick = 100 ns), e.g. 58500s, 0.5s, -3s
function ticksToSeconds(t) {
  const neg = t < 0n, a = neg ? -t : t;
  const frac = (a % 10000000n).toString().padStart(7, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 10000000n}${frac ? '.' + frac : ''}s`;
}
function secondsToTicks(s) {
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?s$/.exec(s);
  if (!m) throw new Error(`bad TimeSpan "${s}"`);
  const t = BigInt(m[2]) * 10000000n + BigInt((m[3] || '').padEnd(7, '0') || '0');
  return m[1] ? -t : t;
}

export function makeDecoder({ classes, enums }) {
  const num = (big) => (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString());

  function scalar(type, fmt, x) {
    const lenTypes = ['string', 'byte[]', 'Guid', 'TimeSpan', 'DateTime', 'DateTimeOffset'];
    if (lenTypes.includes(type) && x.wt !== 2) return { $wireMismatch: type, wt: x.wt, v: typeof x.v === 'bigint' ? x.v.toString() : x.v.toString('hex') };
    switch (type) {
      case 'string': return x.v.toString('utf8');
      case 'bool': case 'Boolean': return x.v !== 0n;
      case 'double': case 'Double': return x.wt === 1 ? x.v.readDoubleLE(0) : null;
      case 'float': case 'Single': return x.wt === 5 ? x.v.readFloatLE(0) : null;
      case 'byte[]': return x.v.toString('base64');
      case 'Guid': return guid(x.v);
      case 'TimeSpan': { const t = bclTicks(x.v); return typeof t === 'string' ? t : ticksToSeconds(t); }
      case 'DateTime': case 'DateTimeOffset': {
        const t = bclTicks(x.v);
        return typeof t === 'string' ? t : new Date(Number(t / 10000n)).toISOString();
      }
    }
    if (INT_TYPES.has(type)) {
      if (x.wt === 1) return num(x.v.readBigInt64LE(0));
      if (x.wt === 5) return x.v.readInt32LE(0);
      return num(fmt === 'ZigZag' ? zz(x.v) : BigInt.asIntN(64, x.v));
    }
    if (UINT_TYPES.has(type)) {
      if (x.wt === 1) return num(x.v.readBigUInt64LE(0));
      if (x.wt === 5) return x.v.readUInt32LE(0);
      return num(x.v);
    }
    if (enums[type]) {
      const v = Number(BigInt.asIntN(32, x.v));
      return enums[type][v] ?? v;
    }
    return undefined; // not a scalar
  }

  // A map entry is {1:key, 2:value}. When the value type is itself a list (Dictionary<K, HashSet<int>>,
  // Dictionary<int, List<Guid>>, ...) protobuf-net writes its elements as repeated field 2 directly in the
  // entry, with no wrapper (verified on TriggerModel.TriggerInputs: 0a09 0834 1074 10a001 1075 =
  // {ButtonPressed: [116,160,117]}). Collect every field-2 entry instead of only the first.
  // A map-typed map value (DeviceBase.AggregatedValues = Dictionary<ValueLogType, Dictionary<int,float>>) is the
  // same: each inner {1:key,2:value} entry is one repeated field 2 (verified by byte round trip of the reconnect).
  function mapValue(vt, entryFields, vf) {
    vt = vt.replace(/\?$/, '');
    const innerMap = MAP_RE.exec(vt)?.[1];
    if (innerMap) {
      const [ikt, ivt] = splitGeneric(innerMap);
      const o = {};
      for (const e of entryFields.filter((q) => q.f === 2 && q.wt === 2)) {
        const ef = readFields(e.v);
        const kf = ef.find((q) => q.f === 1), vf2 = ef.find((q) => q.f === 2);
        putMap(o, kf ? value(ikt, null, kf) : 0, mapValue(ivt, ef, vf2));
      }
      return o;
    }
    const et = vt.endsWith('[]') && vt !== 'byte[]' ? vt.slice(0, -2) : LIST_RE.exec(vt)?.[1];
    if (!et) return vf ? value(vt, null, vf) : null;
    const out = [];
    for (const e of entryFields.filter((q) => q.f === 2)) {
      const isNum = scalar(et, null, { wt: 0, v: 0n }) !== undefined && !['string', 'byte[]', 'Guid', 'TimeSpan', 'DateTime'].includes(et);
      if (isNum && e.wt === 2) out.push(...packedVarints(e.v).map((p) => scalar(et, null, p)));
      else out.push(value(et, null, e));
    }
    return out;
  }

  function value(type, fmt, x) {
    type = type.replace(/\?$/, '');
    const s = scalar(type, fmt, x);
    if (s !== undefined) return s;
    // a collection used as a map value / list element is wrapped in one more message level (field 1)
    const innerList = type.endsWith('[]') ? type.slice(0, -2) : LIST_RE.exec(type)?.[1];
    if (innerList && x.wt === 2) return readFields(x.v).filter((e) => e.f === 1).map((e) => value(innerList, fmt, e));
    const innerMap = MAP_RE.exec(type)?.[1];
    if (innerMap && x.wt === 2) {
      const [kt, vt] = splitGeneric(innerMap);
      const o = {};
      for (const e of readFields(x.v).filter((e) => e.f === 1)) {
        const ef = readFields(e.v);
        const kf = ef.find((q) => q.f === 1), vf = ef.find((q) => q.f === 2);
        putMap(o, kf ? value(kt, null, kf) : 0, mapValue(vt, ef, vf));
      }
      return o;
    }
    // KeyValuePair<K,V> (e.g. ValueChangedDeviceLogEntry.Values) is a tuple message {1 Key, 2 Value}; both are written
    const kvp = /^KeyValuePair<(.+)>$/.exec(type)?.[1];
    if (kvp && x.wt === 2) {
      const [kt, vt] = splitGeneric(kvp);
      const ef = readFields(x.v), kf = ef.find((q) => q.f === 1), vf = ef.find((q) => q.f === 2);
      return { Key: kf ? value(kt, null, kf) : null, Value: vf ? value(vt, null, vf) : null };
    }
    const cls = type.split('.').pop().replace(/<.*$/, '');
    if (classes[cls] && x.wt === 2) return message(x.v, cls);
    if (x.wt === 2) return { $unknownType: type, $hex: x.v.subarray(0, 64).toString('hex') };
    return num(x.v);
  }

  // decode buf as class `cls`, following ProtoInclude tags into subclasses (root-first rule)
  // protobuf-net writes a hierarchy from its root: find the topmost class whose include chain reaches `cls`
  const parentOf = {};
  for (const [name, c] of Object.entries(classes)) for (const sub of Object.values(c.includes)) parentOf[sub] ||= name;
  const rootOf = (cls) => { let r = cls; while (parentOf[r] && parentOf[r] !== r) r = parentOf[r]; return r; };

  function message(buf, cls, fromRoot = true) {
    if (fromRoot) cls = rootOf(cls);
    try { return messageStrict(buf, cls); } catch (e) {
      errors.push(`${cls}: ${e.message}`);
      return { $error: `${cls}: ${e.message}`, $hex: buf.subarray(0, 96).toString('hex'), $len: buf.length };
    }
  }
  const errors = [];

  function messageStrict(buf, cls) {
    const c = classes[cls];
    if (!c) return { $unknownClass: cls, $hex: buf.subarray(0, 64).toString('hex') };
    const obj = {};
    const fields = readFields(buf);
    for (const x of fields) {
      const sub = c.includes[x.f];
      if (sub && x.wt === 2) {
        const inner = message(x.v, sub, false);
        obj.$type = inner.$type || sub;
        Object.assign(obj, inner);
        continue;
      }
      const fd = c.fields[x.f];
      if (!fd) { (obj.$unknown ||= []).push(x.f); continue; }
      const t = fd.type;
      const list = t.endsWith('[]') && t !== 'byte[]' ? t.slice(0, -2) : LIST_RE.exec(t)?.[1];
      const map = MAP_RE.exec(t)?.[1];
      if (map) {
        const [kt, vt] = splitGeneric(map);
        const entry = readFields(x.v);
        const kf = entry.find((e) => e.f === 1), vf = entry.find((e) => e.f === 2);
        const k = kf ? value(kt, null, kf) : (enums[kt] ? enums[kt][0] ?? 0 : 0);
        const vv = mapValue(vt, entry, vf);
        putMap((obj[fd.name] ||= {}), k, vv);
      } else if (list) {
        const arr = (obj[fd.name] ||= []);
        const et = list.replace(/\?$/, '');
        if (x.wt === 2 && scalar(et, fd.fmt, { wt: 0, v: 0n }) !== undefined && !['string', 'byte[]', 'Guid', 'TimeSpan', 'DateTime'].includes(et)) {
          // packed scalars
          const isFixed64 = ['double', 'Double'].includes(et) || fd.fmt === 'FixedSize';
          const isFloat = ['float', 'Single'].includes(et);
          if (isFixed64) for (let i = 0; i + 8 <= x.v.length; i += 8) arr.push(scalar(et, fd.fmt, { wt: 1, v: x.v.subarray(i, i + 8) }));
          else if (isFloat) for (let i = 0; i + 4 <= x.v.length; i += 4) arr.push(scalar(et, fd.fmt, { wt: 5, v: x.v.subarray(i, i + 4) }));
          else for (const p of packedVarints(x.v)) arr.push(scalar(et, fd.fmt, p));
        } else arr.push(value(et, fd.fmt, x));
      } else {
        obj[fd.name] = value(t, fd.fmt, x);
      }
    }
    return obj;
  }
  return { message, errors };
}

function packedVarints(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) { let r = 0n, s = 0n, b; do { b = buf[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); out.push({ wt: 0, v: r }); }
  return out;
}

// ---------- encoder: the inverse of makeDecoder ----------
// Re-serializes decoded JSON the way protobuf-net does:
//  - a class hierarchy is written from its root: the ProtoInclude field of the next subclass on the way to
//    the object's $type first, then the class's own fields in ascending field number
//  - a field is written only if it is present in the JSON (the decoder only sets fields that were on the
//    wire, so defaults protobuf-net omitted stay omitted, and explicitly written defaults stay written)
//  - map = repeated {1:key, 2:value}; a list-typed map value is repeated field 2 with no wrapper;
//    a list/map used as a list element is wrapped in one message (field 1)
//  - bcl TimeSpan/DateTime use the largest unit that divides the value exactly (protobuf-net's choice)
const wVarint = (n) => {
  n = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const wKey = (f, wt) => wVarint((f << 3) | wt);
const wLen = (f, b) => Buffer.concat([wKey(f, 2), wVarint(b.length), b]);
const zzEnc = (v) => { v = BigInt(v); return v >= 0n ? v << 1n : ((-v) << 1n) - 1n; };

function bclEncode(ticks) {
  if (ticks === 'MaxValue' || ticks === 'MinValue') return Buffer.concat([wKey(1, 0), wVarint(zzEnc(ticks === 'MaxValue' ? 1 : -1)), wKey(2, 0), wVarint(15)]);
  if (ticks === 0n) return Buffer.alloc(0);
  let scale = 5;
  for (let s = 0; s < TICKS_PER.length; s++) if (ticks % TICKS_PER[s] === 0n) { scale = s; break; }
  const value = ticks / TICKS_PER[scale];
  return Buffer.concat([wKey(1, 0), wVarint(zzEnc(value)), ...(scale ? [wKey(2, 0), wVarint(scale)] : [])]);
}
function guidEncode(s) {
  const h = s.replace(/-/g, '');
  const r = (x) => Buffer.from(x, 'hex').reverse();
  const b = Buffer.concat([r(h.slice(0, 8)), r(h.slice(8, 12)), r(h.slice(12, 16)), Buffer.from(h.slice(16), 'hex')]);
  const lo = b.subarray(0, 8), hi = b.subarray(8);
  const z = (x) => x.every((q) => q === 0);
  return Buffer.concat([...(z(lo) ? [] : [wKey(1, 1), lo]), ...(z(hi) ? [] : [wKey(2, 1), hi])]);
}

export function makeEncoder({ classes, enums }, { strict = false } = {}) {
  const parentOf = {};
  for (const [name, c] of Object.entries(classes)) for (const sub of Object.values(c.includes)) parentOf[sub] ||= name;
  const rootOf = (cls) => { let r = cls; while (parentOf[r] && parentOf[r] !== r) r = parentOf[r]; return r; };
  const enumRev = {};
  const enumNum = (type, v) => {
    if (typeof v === 'number') return v;
    const m = (enumRev[type] ||= Object.fromEntries(Object.entries(enums[type]).map(([n, l]) => [l, Number(n)])));
    if (!(v in m)) throw new Error(`unknown ${type} value "${v}"`);
    return m[v];
  };
  const isNumScalar = (t) => INT_TYPES.has(t) || UINT_TYPES.has(t) || ['bool', 'Boolean', 'double', 'Double', 'float', 'Single'].includes(t) || !!enums[t];

  // raw scalar payload + wire type, for packed and unpacked use
  function scalarRaw(type, fmt, v) {
    if (type === 'bool' || type === 'Boolean') return [0, wVarint(v ? 1 : 0)];
    // NaN: .NET's double.NaN / float.NaN bit patterns (0xFFF8000000000000 / 0xFFC00000), not JS's 0x7FF8...
    if (type === 'double' || type === 'Double') { const b = Buffer.alloc(8); if (Number.isNaN(v)) b.writeBigUInt64LE(0xFFF8000000000000n); else b.writeDoubleLE(v); return [1, b]; }
    if (type === 'float' || type === 'Single') { const b = Buffer.alloc(4); if (Number.isNaN(v)) b.writeUInt32LE(0xFFC00000); else b.writeFloatLE(v); return [5, b]; }
    if (enums[type]) return [0, wVarint(enumNum(type, v))];
    if (INT_TYPES.has(type) || UINT_TYPES.has(type)) {
      const big = BigInt(v);
      const wide = /long|Int64|UInt64/.test(type);
      if (fmt === 'ZigZag') return [0, wVarint(zzEnc(big))];
      if (fmt === 'FixedSize') {
        const b = Buffer.alloc(wide ? 8 : 4);
        if (wide) b.writeBigUInt64LE(BigInt.asUintN(64, big)); else b.writeUInt32LE(Number(BigInt.asUintN(32, big)));
        return [wide ? 1 : 5, b];
      }
      return [0, wVarint(big)];
    }
    return null;
  }

  function value(f, type, fmt, v) {
    type = type.replace(/\?$/, '');
    if (v && typeof v === 'object' && ('$wireMismatch' in v || '$unknownType' in v || '$error' in v || '$unknownClass' in v)) throw new Error(`cannot re-encode undecoded value at field ${f} (${type})`);
    switch (type) {
      case 'string': return wLen(f, Buffer.from(v, 'utf8'));
      case 'byte[]': return wLen(f, Buffer.from(v, 'base64'));
      case 'Guid': return wLen(f, guidEncode(v));
      case 'TimeSpan': return wLen(f, bclEncode(/Value$/.test(v) ? v : secondsToTicks(v)));
      case 'DateTime': case 'DateTimeOffset': return wLen(f, bclEncode(/Value$/.test(v) ? v : BigInt(Date.parse(v)) * 10000n));
    }
    const sr = scalarRaw(type, fmt, v);
    if (sr) return Buffer.concat([wKey(f, sr[0]), sr[1]]);
    const innerList = type.endsWith('[]') ? type.slice(0, -2) : LIST_RE.exec(type)?.[1];
    if (innerList) return wLen(f, Buffer.concat(v.map((e) => value(1, innerList, fmt, e))));
    const innerMap = MAP_RE.exec(type)?.[1];
    if (innerMap) return wLen(f, Buffer.concat(mapEntries(1, innerMap, v)));
    const kvp = /^KeyValuePair<(.+)>$/.exec(type)?.[1];
    if (kvp) {
      const [kt, vt] = splitGeneric(kvp);
      return wLen(f, Buffer.concat([value(1, kt, null, mapKey(kt, String(v.Key))), value(2, vt, null, v.Value)]));
    }
    const cls = type.split('.').pop().replace(/<.*$/, '');
    if (classes[cls]) return wLen(f, message(v, cls));
    throw new Error(`no encoding for type ${type}`);
  }

  function mapKey(kt, k) {
    if (enums[kt]) return /^-?\d+$/.test(k) ? Number(k) : enumNum(kt, k); // unnamed enum values decode as numbers
    if (kt === 'bool') return k === 'true';
    return k; // numeric strings become BigInt in scalarRaw; strings/Guids stay strings
  }
  function mapEntries(f, inner, obj) {
    const [kt, vt0] = splitGeneric(inner);
    const vt = vt0.replace(/\?$/, '');
    const et = vt.endsWith('[]') && vt !== 'byte[]' ? vt.slice(0, -2) : LIST_RE.exec(vt)?.[1];
    const im = MAP_RE.exec(vt)?.[1];
    return orderedEntries(obj).map(([k, v]) => {
      const parts = [value(1, kt, null, mapKey(kt, k))];
      if (v != null) {
        if (im) parts.push(...mapEntries(2, im, v)); // map-valued map: inner entries are repeated field 2
        else if (et) parts.push(...v.map((e) => value(2, et, null, e)));
        else parts.push(value(2, vt, null, v));
      }
      return wLen(f, Buffer.concat(parts));
    });
  }

  function pathTo(from, target) { // [[includeTag, subclass], ...] from `from` down to `target`
    if (from === target) return [];
    for (const [tag, sub] of Object.entries(classes[from]?.includes || {})) {
      const p = pathTo(sub, target);
      if (p) return [[Number(tag), sub], ...p];
    }
    return null;
  }

  function chain(obj, cur, path) {
    const c = classes[cur];
    const parts = [];
    if (path.length) {
      const [[tag, sub], ...rest] = path;
      parts.push(wLen(tag, chain(obj, sub, rest)));
    }
    for (const n of Object.keys(c.fields).map(Number).sort((a, b) => a - b)) {
      const fd = c.fields[n];
      const v = obj[fd.name];
      if (v === undefined) continue;
      if (v === null) throw new Error(`${cur}.${fd.name} is null (undecodable on the way in)`);
      const t = fd.type.replace(/\?$/, '');
      const map = MAP_RE.exec(t)?.[1];
      const list = t.endsWith('[]') && t !== 'byte[]' ? t.slice(0, -2) : LIST_RE.exec(t)?.[1];
      if (map) parts.push(...mapEntries(n, map, v));
      else if (list) {
        const et = list.replace(/\?$/, '');
        // packed: protobuf-net writes an empty (non-null) list as a zero-length field, and the decoder only
        // produces [] when that field was on the wire
        if (fd.packed && isNumScalar(et)) parts.push(wLen(n, Buffer.concat(v.map((e) => scalarRaw(et, fd.fmt, e)[1]))));
        else parts.push(...v.map((e) => value(n, et, fd.fmt, e)));
      } else parts.push(value(n, t, fd.fmt, v));
    }
    return Buffer.concat(parts);
  }

  // encode `obj` declared as class `cls` (it may carry $type = a subclass)
  function message(obj, cls) {
    const root = rootOf(cls);
    const target = obj.$type || root;
    const path = pathTo(root, target);
    if (!path) throw new Error(`${target} is not a subclass of ${root}`);
    if (obj.$unknown) throw new Error(`${target} has unknown fields ${obj.$unknown}`);
    if (strict) { // every key must be a field of some class on the root..$type chain (catches typos in edited JSON)
      const allowed = new Set(['$type']);
      for (const c of [root, ...path.map((p) => p[1])]) for (const fd of Object.values(classes[c].fields)) allowed.add(fd.name);
      const bad = Object.keys(obj).filter((k) => !allowed.has(k));
      if (bad.length) throw new Error(`${target}: unknown key(s) ${bad.join(', ')} (allowed: ${[...allowed].filter((k) => k !== '$type').join(', ')})`);
    }
    return chain(obj, root, path);
  }
  return { message };
}
