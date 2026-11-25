// Shared helpers for the tools: one session with the live configuration, request/reply, name lookup, and the
// pretty-printers for value history, device logs, script values and smart rules.
//
//   const th = await connect();            // live session; OFFLINE=1 reads out/reconnect.json instead
//   const dev = th.idx.resolveDevice('kuchyňa');
//   const reply = await th.ask({ $type: 'MessageGetDeviceLogRequest', DeviceId: dev.ID });
//   th.close();
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './proto.mjs';
import { loadSchema, makeDecoder, makeEncoder } from './schema.mjs';
import { openSession } from './session.mjs';
import { loadConfig } from './config.mjs';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const schema = loadSchema();
export const dec = makeDecoder(schema);
export const enc = makeEncoder(schema, { strict: true });
export const J = (o, sp) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : Number.isNaN(v) ? 'NaN' : v), sp);
export const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

// ---------- time ----------
export const TH_EPOCH = Date.UTC(2016, 0, 1); // TapHomeTime = seconds since 2016-01-01 UTC
export const thDate = (s) => new Date(TH_EPOCH + (s ?? 0) * 1000);
export const localTime = (d) => (d instanceof Date ? d : new Date(d)).toLocaleString('sv-SE');
export function ago(d, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (d instanceof Date ? d : new Date(d)).getTime()) / 1000)); // clamp PC/Core clock skew
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 86400)}d`;
}
// TimeSpan "58500s" (time of day) -> "16:15"; >= 24 h means the next day ("115200s" -> "08:00+1d")
export function clock(v) {
  const m = /^(\d+)s$/.exec(String(v));
  if (!m) return v;
  const s = Number(m[1]), h = Math.floor(s / 3600) % 24, mm = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}${s >= 86400 ? '+1d' : ''}`;
}

// ---------- names ----------
// optional config.json "translations": a TapHome.Translations .resx, to resolve built-in names stored as ${translation_key}
export function translator(cfg) {
  const tr = {};
  if (cfg.translations) {
    const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    for (const m of readFileSync(cfg.translations, 'utf8').matchAll(/<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g)) tr[m[1]] = unxml(m[2]);
  }
  return (s) => (typeof s === 'string' ? s.replace(/\$\{(\w+)\}/g, (all, k) => tr[k] ?? all) : s);
}
// for searching: lower case, no diacritics ("Kuchyňa" -> "kuchyna")
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// does folded text h contain the folded word w? Words of 5+ letters also match without their last two letters,
// so Slovak inflections find each other ("teplota" finds "teploty", "kuchyna" finds "kuchyni")
export const hasWord = (h, w) => h.includes(w) || (w.length >= 5 && h.includes(w.slice(0, w.length - 2)));

// ---------- smart rules ----------
// TriggerInputs / LimitingConditionInputs: the device ids whose changes wake the rule
export const connIds = (c) => [...new Set([
  ...Object.values(c?.InstantConnections?.Connections || {}).flat(),
  ...Object.values(c?.AggregatedConnections?.Connections || {}).flatMap((m) => Object.values(m || {}).flat()),
])].filter((x) => typeof x === 'number');

// generic, type-independent rule summary (used by export.mjs for smartrules.txt). devName(id) -> '12 "Name"'
export function makeRuleDescriber(devName) {
  function describeRequest(q) { // ValueLogTypeValueRequest
    const p = q.Parameters?.DoubleParameters?.Value ?? q.Parameters?.RangeParameters ?? '';
    const t = q.TimingParameters ? ` [${q.TimingParameters.$type.replace(/TimingParameters$/, '')}${q.TimingParameters.PulseWidthMs ? ' ' + q.TimingParameters.PulseWidthMs + ' ms' : ''}${q.TimingParameters.DelayMs ? ' delay ' + q.TimingParameters.DelayMs + ' ms' : ''}]` : '';
    return `${q.ActionType ?? 'None'} ${q.ValueLogType}${p !== '' ? ' ' + (typeof p === 'object' ? JSON.stringify(p) : p) : ''}${t}`;
  }
  function describeAction(a) { // ActionModel
    if (a.ActionType === 'NotifyAction') return `notify "${a.Parameters?.Title ?? ''}" ${a.Parameters?.Message ?? ''}`.trim();
    const p = a.Parameters || {};
    return `${devName(p.OutputDeviceId)}: ${(p.ValueLogTypeValueRequests || []).map(describeRequest).join(', ')}`;
  }
  // *Ids / *Id fields name devices, *Actions fields hold ActionModel lists
  return function describeRule(r) {
    const tp = r.TriggerParameters || {};
    const lines = [`#${r.Id} ${r.Name}  [${r.TriggerParameters?.$type?.replace(/TriggerParameters$/, '') ?? `type ${r.TriggerTypeId}`}]${r.IsEnabled ? '' : '  (disabled)'}`];
    for (const [k, v] of Object.entries(tp)) {
      if (k === '$type') continue;
      if (/Ids?$/.test(k) && (typeof v === 'number' || Array.isArray(v))) lines.push(`  ${k}: ${[].concat(v).map(devName).join(', ')}`);
      else if (/Actions$/.test(k) && Array.isArray(v)) for (const a of v) lines.push(`  ${k} -> ${describeAction(a)}`);
      else if (/Actions$/.test(k) && v && typeof v === 'object') lines.push(`  ${k}: ${Object.entries(v).map(([id, x]) => `${devName(id)}=${x}`).join(', ')}`);
      else if (/Script|Formula/.test(k) && typeof v === 'string') lines.push(`  ${k}: ${v.split(/\r?\n/).length} line(s), see file`);
      else if (Array.isArray(v) && v[0]?.Abbreviation) lines.push(`  ${k}: ${v.map((x) => `${x.Abbreviation}=${devName(x.DeviceId)}.${x.ValueLogType}`).join(', ')}`);
      else if (typeof v !== 'object') lines.push(`  ${k}: ${/Time/.test(k) ? clock(v) : v}`);
    }
    // limiting condition: the rule only acts while it holds
    const lc = r.LimitingConditionParameters;
    if (lc) {
      const kind = lc.$type.replace(/LimitingConditionParameters$/, '');
      let detail = '';
      if (lc.NonLimitingTimeStart !== undefined || lc.NonLimitingTimeEnd !== undefined) // Time: acts inside start..end
        detail = ` ${clock(lc.NonLimitingTimeStart ?? '0s')}..${clock(lc.NonLimitingTimeEnd ?? '0s')}`;
      else if (lc.SwitchId !== undefined) // Switch: acts while the switch is in a state not marked limiting
        detail = ` ${devName(lc.SwitchId)} blocks when ${[lc.IsOffValueLimiting && 'off', lc.IsOnValueLimiting && 'on'].filter(Boolean).join('/') || '(nothing)'}`;
      else if (lc.MultiValueSwitchId !== undefined) {
        const blocked = Object.keys(lc).map((k) => k.match(/^IsValue(\d+)Limiting$/)).filter((m) => m && lc[m[0]]).map((m) => m[1]);
        detail = ` ${devName(lc.MultiValueSwitchId)} blocks at value ${blocked.join('/') || '(none)'}`;
      }
      lines.push(`  condition${r.IsLimitingConditionEnabled ? '' : ' (disabled)'}: ${kind}${detail}`);
      if (lc.InputVariables?.length)
        lines.push(`    variables: ${lc.InputVariables.map((x) => `${x.Abbreviation}=${devName(x.DeviceId)}.${x.ValueLogType}`).join(', ')}`);
      if (lc.EvaluationFormula) for (const l of lc.EvaluationFormula.split(/\r?\n/)) if (l.trim()) lines.push(`    | ${l}`);
    }
    return lines.join('\n');
  };
}
// script/formula texts of a rule, by key (TriggerParameters.Script, .EvaluationFormula, the condition's formula)
export function ruleTexts(r) {
  const texts = Object.fromEntries(Object.entries(r.TriggerParameters || {}).filter(([k, v]) => /Script|Formula/.test(k) && typeof v === 'string'));
  if (r.LimitingConditionParameters?.EvaluationFormula) texts.ConditionFormula = r.LimitingConditionParameters.EvaluationFormula;
  return texts;
}
// every {Abbreviation, DeviceId, ValueLogType} a rule reads (script variables, formula inputs, condition variables)
export function ruleVariables(r) {
  const out = [];
  for (const [k, v] of Object.entries(r.TriggerParameters || {}))
    if (Array.isArray(v) && v[0]?.Abbreviation) for (const x of v) out.push({ where: k, ...x });
  for (const x of r.LimitingConditionParameters?.InputVariables || []) out.push({ where: 'condition', ...x });
  const seen = new Set();
  return out.filter((x) => { const key = `${x.Abbreviation}|${x.DeviceId}|${x.ValueLogType}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

// ---------- configuration index ----------
// conf = the decoded MessageReconnectResponse (live from connect(), or out/reconnect.json)
export function makeIndex(conf, T = (s) => s) {
  const show = (s) => T(s)?.replace?.(/\$\{(\w+)\}/g, '$1') ?? s; // untranslated ${Presence_Away} -> Presence_Away
  const devById = new Map((conf.Devices || []).map((x) => [x.ID, x]));
  const dashById = new Map((conf.Dashboards || []).map((x) => [x.DashboardId, x]));
  const name = (x) => show(x?.Name);
  const devName = (id) => `${id} "${devById.has(Number(id)) ? name(devById.get(Number(id))) : 'missing'}"`;
  const groupName = (id) => (id && id !== EMPTY_GUID ? show(dashById.get(id)?.Name) ?? id : null);
  const rules = (conf.SmartRules || []).map((b) => dec.message(Buffer.from(b, 'base64'), 'TriggerModel')).filter((r) => !r.IsDeleted);
  for (const r of rules) r.Name = show(r.Name);
  const ruleById = new Map(rules.map((r) => [r.Id, r]));
  const cut = (s, n) => (n && s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const ruleName = (id, max = 0) => (id === -1 ? 'rule -1 (deleted)' : `rule ${id}${ruleById.has(id) ? ` "${cut(ruleById.get(id).Name, max)}"` : ''}`);

  // which rules read or write a device: role input (wakes the rule), condition, variable, output (writes it)
  const byDevice = new Map();
  const add = (id, r, role) => { const l = byDevice.get(id) || []; if (!l.some((x) => x.rule === r && x.role === role)) l.push({ rule: r, role }); byDevice.set(id, l); };
  for (const r of rules) {
    for (const id of connIds(r.TriggerInputs)) add(id, r, 'input');
    for (const id of connIds(r.LimitingConditionInputs)) add(id, r, 'condition');
    for (const v of ruleVariables(r)) add(v.DeviceId, r, v.where === 'condition' ? 'condition' : 'variable');
    for (const id of Object.keys(r.Priorities || {}).map(Number)) add(id, r, 'output');
  }

  // current values: {ValueLogType: {value, at}} (protobuf omits 0, so a missing Value is 0)
  function values(x) {
    const out = {};
    for (const [k, v] of Object.entries(x?.CurrentValues || {})) {
      if (!v || typeof v !== 'object') { out[k] = { value: v }; continue; }
      out[k] = { value: 'Value' in v ? v.Value : 0, at: v.ChangedOnTHUtc ? thDate(v.ChangedOnTHUtc) : null };
    }
    return out;
  }
  // multi-value switch: slot N has ValueNIndex (the state number) and ValueNName
  function valueLabel(x, type, v) {
    if (type === 'OperationMode') return ` (${schema.enums.DeviceOperationMode?.[v] ?? '?'})`;
    if (type === 'DeviceStatus') return ` (${schema.enums.DeviceStatus?.[v] ?? '?'})`;
    if (!/MultiValueSwitch/.test(type) || v == null) return '';
    const p = x?.DeviceProperties || {};
    for (let n = 0; n < 32 && `Value${n}Index` in p; n++) if (Number(p[`Value${n}Index`]) === v && p[`Value${n}Name`]) return ` (${show(p[`Value${n}Name`])})`;
    return '';
  }
  const fmtVal = (v) => (v == null ? 'null' : typeof v === 'number' && !Number.isInteger(v) ? String(+v.toFixed(3)) : String(v));
  // one value: "SwitchState=1" or "MultiValueSwitchState=6 (Legionella)"; with {since} also " since 11-24 16:00"
  function valueText(x, type, { since = false } = {}) {
    const v = values(x)[type];
    if (!v) return `${type}=?`;
    return `${type}=${fmtVal(v.value)}${valueLabel(x, type, v.value)}${since && v.at ? ` since ${localTime(v.at).slice(5, 16)}` : ''}`;
  }
  // the values worth showing: OperationMode only when 1 (Manual = manual override active; 0 = no mode, 2 = Automatic),
  // DeviceStatus only when not 0 (OK), and not the SwitchState/DesiredState a multi-value switch mirrors
  function interesting(x) {
    const vals = values(x);
    return Object.keys(vals).filter((k) => !(k === 'OperationMode' && vals[k].value !== 1) && !(k === 'DeviceStatus' && !vals[k].value)
      && !(k === 'SwitchState' && 'MultiValueSwitchState' in vals) && !(k === 'MultiValueSwitchDesiredState' && 'MultiValueSwitchState' in vals));
  }
  const valuesLine = (x, opts) => interesting(x).map((k) => valueText(x, k, opts)).join('  ');

  // search: every word of the query must appear in the device's name, zone or category (no diacritics, any case)
  const haystack = (x) => fold(`${name(x)} ${groupName(x.ZoneId) ?? ''} ${groupName(x.CategoryId) ?? ''}`);
  function findDevices(q) {
    if (/^\d+$/.test(String(q).trim())) { const x = devById.get(Number(q)); return x ? [x] : []; }
    const words = fold(q).split(/\s+/).filter(Boolean);
    const hits = [...devById.values()].filter((x) => words.every((w) => hasWord(haystack(x), w)));
    // exact name first, then all words literally in the name, then inflected in the name, then the rest
    const exact = (x) => (fold(name(x)) === fold(q) ? 0 : words.every((w) => fold(name(x)).includes(w)) ? 1 : words.every((w) => hasWord(fold(name(x)), w)) ? 2 : 3);
    return hits.sort((a, b) => exact(a) - exact(b) || name(a).localeCompare(name(b), 'sk'));
  }
  function findRules(q) {
    if (/^#?\d+$/.test(String(q).trim())) { const r = ruleById.get(Number(String(q).replace('#', ''))); return r ? [r] : []; }
    const words = fold(q).split(/\s+/).filter(Boolean);
    return rules.filter((r) => words.every((w) => hasWord(fold(r.Name), w))).sort((a, b) => a.Id - b.Id);
  }
  const ambiguous = (what, q, list, line) => new Error(`${list.length ? `"${q}" matches ${list.length} ${what}s, be more specific or use the id:` : `no ${what} matches "${q}"`}\n${list.slice(0, 25).map((x) => `  ${line(x)}`).join('\n')}${list.length > 25 ? '\n  …' : ''}`);
  function resolveDevice(q) {
    const l = findDevices(q);
    if (l.length === 1) return l[0];
    const exact = l.filter((x) => fold(name(x)) === fold(q));
    if (exact.length === 1) return exact[0];
    throw ambiguous('device', q, l, (x) => `${x.ID}  ${name(x)}  [${x.Model}]${groupName(x.ZoneId) ? `  ${groupName(x.ZoneId)}` : ''}`);
  }
  function resolveRule(q) {
    const l = findRules(q);
    if (l.length === 1) return l[0];
    const exact = l.filter((r) => fold(r.Name) === fold(q));
    if (exact.length === 1) return exact[0];
    throw ambiguous('rule', q, l, (r) => `#${r.Id}  ${r.Name}`);
  }
  const describeRule = makeRuleDescriber(devName);
  return { conf, devById, dashById, rules, ruleById, byDevice, name, devName, ruleName, groupName, values, valueText, valuesLine,
    findDevices, findRules, resolveDevice, resolveRule, describeRule, show };
}

// ---------- session ----------
// One session for the whole tool run: the live configuration comes with it (the reconnect), so no dump is needed.
// OFFLINE=1 (or { offline: true }) reads out/reconnect.json instead and has no ask().
export async function connect({ offline = !!process.env.OFFLINE } = {}) {
  const cfg = loadConfig();
  const T = translator(cfg);
  if (offline) {
    const f = join(REPO, 'out', 'reconnect.json');
    if (!existsSync(f)) throw new Error('OFFLINE: no out/reconnect.json, run node probe/dump.mjs');
    const conf = JSON.parse(readFileSync(f, 'utf8'));
    return { conf, idx: makeIndex(conf, T), live: false, ask: async () => { throw new Error('OFFLINE: no session'); }, close() {} };
  }
  const tagMap = schema.tagMap;
  const s = await openSession({ ...cfg.session(), tagMap, log: () => {} });
  const conf = dec.message(s.reconnectRaw, 'MessageBase');
  // send one request and return its decoded reply (null on timeout). Unrelated messages that arrive meanwhile are dropped.
  async function ask(req, { timeout = 15000 } = {}) {
    const rid = s.newRequestId();
    s.conn.sendBinary(enc.message({ ...req, RequestsId: rid }, 'MessageBase'));
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let raw;
      try { raw = await s.next(500); } catch { continue; }
      if (!raw) return null;
      const m = P.unwrap(raw, tagMap);
      const parts = m.tag === 383 ? P.all(m.body, 1).map((f) => f.v) : [raw]; // container of several messages
      for (const r of parts) {
        const u = P.unwrap(r, tagMap);
        if (u.requestsId === rid && u.type === P.TYPE.Response) return dec.message(r, 'MessageBase');
      }
    }
    return null;
  }
  return { conf, idx: makeIndex(conf, T), live: true, ask, close() { s.close(); setTimeout(() => process.exit(0), 300); } };
}

// ---------- reply decoders ----------
// HistoryItemsSerializer.ProcessDeserializedContainer: per session a start time, time deltas (s) and one value array.
// Returns [isoUtc, value, sessionId] points.
export function historyPoints(container) {
  const pts = [];
  for (const s of container.HistoryItemsSessions || []) {
    const n = (s.TimeDifferences?.length ?? 0) + 1;
    let t = TH_EPOCH + (s.StartedOn ?? 0) * 1000, acc = s.FirstIntValue ?? 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) t += s.TimeDifferences[i - 1] * 1000;
      let v;
      if (s.SingleValues) v = s.SingleValues[i];
      else if (s.DoubleValues) v = s.DoubleValues[i];
      else if (s.BitValues) v = (s.BitValues[i >> 5] >>> (i % 32)) & 1;
      else {
        const abs = Object.entries(s).find(([k]) => /^AbsoluteInt\d+Values$/.test(k));
        const rel = Object.entries(s).find(([k]) => /^RelativeInt\d+Values$/.test(k));
        if (abs) { const raw = abs[1][i], sc = +abs[0].match(/\d+/)[0]; v = raw < -8000000 ? NaN : raw / sc; }
        else if (rel) { if (i > 0) acc += rel[1][i - 1]; const sc = +rel[0].match(/\d+/)[0]; v = acc < -8000000 ? NaN : acc / sc; }
      }
      pts.push([new Date(t).toISOString(), v, s.SessionId ?? 0]);
    }
  }
  return pts;
}
// the history reply's Container (base64 HistoryItemsContainer) -> points
export const replyPoints = (r) => (r?.Container ? historyPoints(dec.message(Buffer.from(r.Container, 'base64'), 'HistoryItemsContainer')) : []);

// ValueChangedDeviceLogEntry: TapHomeTime, Values [{Key: ValueLogType, Value}], ChangeOriginId (enum ChangeOrigin),
// HandlingStatus {LastTriggerId = smart rule (-1 = rule no longer exists), SourceUserId, FirstDeviceId = what started it}.
// idx (optional) adds rule and device names.
const ORIGIN = schema.enums.ChangeOrigin || {};
export function logLine(e, idx = null) {
  const t = localTime(thDate(e.TapHomeTime));
  const vals = (e.Values || []).map((v) => `${v.Key}=${Number.isNaN(v.Value) ? 'NaN' : v.Value}`).join(' ');
  const h = e.HandlingStatus || {};
  const via = [h.LastTriggerId && (idx ? idx.ruleName(h.LastTriggerId, 32) : `rule ${h.LastTriggerId}`),
    h.FirstDeviceId && `from device ${idx ? idx.devName(h.FirstDeviceId) : h.FirstDeviceId}`,
    h.SourceUserId && `user ${h.SourceUserId.slice(0, 8)}`].filter(Boolean).join(', ');
  return `${t}  ${vals}  [${ORIGIN[e.ChangeOriginId ?? 0] ?? e.ChangeOriginId}]${via ? `  ${via}` : ''}`;
}

// Script variable value (DataType): SerializerValueTypeId = EDataTypeProtobuf, the number sits in the low bytes of
// SerializerValueBytes (an int64 used as raw memory, little endian), strings/objects in ProtoString (JSON for objects)
const DT = { 0: 'Null', 1: 'Int', 2: 'UInt', 3: 'Float', 4: 'Double', 5: 'Int8', 6: 'UInt8', 7: 'Int16', 8: 'UInt16', 9: 'Int64', 10: 'UInt64', 11: 'Bool', 12: 'Char', 13: 'String' };
export function dataType(d) {
  if (!d) return 'null';
  const t = DT[d.SerializerValueTypeId ?? 0] ?? `type${d.SerializerValueTypeId}`;
  if (d.ProtoString !== undefined) return t === 'String' ? JSON.stringify(d.ProtoString.length > 200 ? `${d.ProtoString.slice(0, 200)}…` : d.ProtoString) : `${t} ${d.ProtoString}`;
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(d.SerializerValueBytes ?? 0));
  const v = { Null: 'null', Int: b.readInt32LE(), UInt: b.readUInt32LE(), Float: b.readFloatLE(), Double: b.readDoubleLE(), Int8: b.readInt8(), UInt8: b.readUInt8(),
    Int16: b.readInt16LE(), UInt16: b.readUInt16LE(), Int64: b.readBigInt64LE(), UInt64: b.readBigUInt64LE(), Bool: !!b[0], Char: JSON.stringify(String.fromCharCode(b.readUInt16LE())) }[t];
  return v === undefined ? `${t} raw=${d.SerializerValueBytes}` : `${v}${['Double', 'Float', 'Int', 'Bool', 'String', 'Null'].includes(t) ? '' : ` (${t})`}`;
}
// MessageGetScriptLastRunValuesReponse -> printable lines
export function lastRunLines(r) {
  const v = r?.Values;
  if (!v) return ['no last run recorded'];
  const lines = [`ran ${v.RunTimestampUtc ? localTime(v.RunTimestampUtc) : '?'} in ${v.RunDuration ?? '0s'}, result = ${dataType(v.Result)}`];
  for (const [step, vars] of Object.entries(v.ValuesParameter || {}))
    for (const [name, d] of Object.entries(vars)) lines.push(`step ${step}  ${name} = ${dataType(d)}`);
  return lines;
}
// DeviceErrors / TriggerErrors -> "2025-09-17 10:12  Code (Severity) text [devices]"
export function errorLine(e, kind = 'Device', idx = null) {
  const code = schema.enums[`${kind}ErrorCode`]?.[e.ErrorCodeId ?? 0] ?? e.ErrorCodeId ?? 0;
  const sev = schema.enums[`${kind}ErrorSeverity`]?.[e.SeverityId ?? 0] ?? e.SeverityId ?? 0;
  const devs = e.DeviceIds?.length ? `  [${e.DeviceIds.map((id) => (idx ? idx.devName(id) : id)).join(', ')}]` : '';
  return `${localTime(thDate(e.TapHomeTime))}  ${code} (${sev})${e.CustomText ? `  ${e.CustomText}` : ''}${devs}`;
}
