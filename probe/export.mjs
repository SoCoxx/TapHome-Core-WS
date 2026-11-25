// Turns out/reconnect.json (from dump.mjs) into a browsable configuration backup under out/config/:
//   zones.json, categories.json, dashboards.json   groupings with their devices
//   devices.json                                   flat index of every device
//   interfaces/<ccu>/<module>/_module.json + <device>.json, scripts as separate .txt files
// and prints an overview. Usage: node export.mjs   (paths from config.json)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, makeDecoder } from './schema.mjs';
import { loadConfig } from './config.mjs';
import { translator, makeRuleDescriber, connIds, ruleTexts } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const d = JSON.parse(readFileSync(join(root, 'reconnect.json'), 'utf8'));
const cfg = loadConfig();
const dec = makeDecoder(loadSchema());
const outDir = join(root, 'config');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// optional config.json "translations": resolve built-in names stored as ${translation_key}
const T = translator(cfg);
for (const x of [...d.Dashboards, ...d.Devices, ...d.Ccus]) if (x.Name) x.Name = T(x.Name);

const EMPTY = '00000000-0000-0000-0000-000000000000';
const safe = (s) => String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+$/, '').slice(0, 80) || '_';
const save = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o, null, 2)); };

// ---------- groupings ----------
const SET_NAMES = { 0: 'dashboards', 1: 'zones', 2: 'categories' };
const dashById = Object.fromEntries(d.Dashboards.map((x) => [x.DashboardId, x]));
const devById = Object.fromEntries(d.Devices.map((x) => [x.ID, x]));
const ref = (id) => ({ id, name: devById[id]?.Name ?? `#${id} (missing)`, model: devById[id]?.Model });
const orderOf = {};
for (const s of d.DashboardSets) (s.DashboardIdsString || '').split(',').filter(Boolean).forEach((id, i) => { orderOf[id] = i; });

const groups = { dashboards: [], zones: [], categories: [] };
for (const db of d.Dashboards) {
  const kind = SET_NAMES[db.DashboardTypeId ?? 0] ?? `type${db.DashboardTypeId}`;
  const entry = { id: db.DashboardId, name: db.Name, order: orderOf[db.DashboardId] ?? 999, iconId: db.IconId, accentColorId: db.AccentColorId };
  if (kind === 'zones' || kind === 'categories') {
    const key = kind === 'zones' ? 'ZoneId' : 'CategoryId';
    entry.devices = d.Devices.filter((x) => x[key] === db.DashboardId).map((x) => ref(x.ID));
  }
  if (db.Content) { // DashboardModel: sections listing devices, other dashboards, charts, schemes
    const content = dec.message(Buffer.from(db.Content, 'base64'), 'DashboardModel');
    entry.sections = (content.SectionModels || []).map((s) => ({
      type: s.$type, name: s.Name || undefined,
      devices: s.DeviceIds?.map(ref),
      dashboards: s.DashboardIds?.map((g) => dashById[g]?.Name ?? g),
      charts: s.DeviceAggregationModels?.length,
      scheme: s.Model ? true : undefined,
    }));
  }
  (groups[kind] ||= []).push(entry);
}
for (const [k, list] of Object.entries(groups)) {
  list.sort((a, b) => a.order - b.order);
  save(join(outDir, `${k}.json`), list);
}
const groupName = (id) => (id && id !== EMPTY ? dashById[id]?.Name ?? id : null);

// ---------- devices ----------
const isScript = (k, v) => typeof v === 'string' && v.length > 0 &&
  (/Script|Formulas/.test(k) || /^(Read|Write)[A-Z]\w*$/.test(k) || k === 'InitializeScript');
const scriptExt = (v) => (/^\s*[\[{]/.test(v) ? 'json' : 'txt');

function deviceRecord(x) {
  return {
    ID: x.ID, Name: x.Name, Model: x.Model, Interface: x.Interface, SerialNumber: x.SerialNumber,
    CcuId: x.CcuId, HardwareParentId: x.HardwareParentId ?? 0, DeviceType: x.DeviceType,
    Zone: groupName(x.ZoneId), Category: groupName(x.CategoryId), ZoneId: x.ZoneId, CategoryId: x.CategoryId,
    Visibility: x.Visibility, IsIgnored: x.IsIgnored ?? false, PollInterval: x.PollInterval,
    DeviceProperties: x.DeviceProperties, SupportedValueLogTypes: x.SupportedValueLogTypes && Object.keys(x.SupportedValueLogTypes),
    CurrentValues: x.CurrentValues && Object.fromEntries(Object.entries(x.CurrentValues).map(([k, v]) => [k, v && typeof v === 'object' ? ('Value' in v ? v.Value : 0) : v])), // protobuf omits 0
  };
}
function writeDevice(dir, base, x) {
  save(join(dir, `${base}.json`), deviceRecord(x));
  for (const [k, v] of Object.entries(x.DeviceProperties || {})) {
    if (isScript(k, v)) save(join(dir, `${base}.${k}.${scriptExt(v)}`), v.replace(/\r?\n/g, '\r\n'));
  }
}

save(join(outDir, 'devices.json'), d.Devices.map(deviceRecord).map(({ DeviceProperties, SupportedValueLogTypes, ...r }) => r));
save(join(outDir, 'interfaces.json'), d.Ccus);
save(join(outDir, 'core.json'), { CoreVersion: d.CoreVersionString, LocationInfo: d.LocationInfo, CoreProperties: d.CoreProperties, UserGroups: d.UserGroups });

const children = {};
for (const x of d.Devices) if (x.HardwareParentId) (children[x.HardwareParentId] ||= []).push(x);
const report = [];
for (const ccu of [...d.Ccus].sort((a, b) => a.CcuId - b.CcuId)) {
  const devs = d.Devices.filter((x) => x.CcuId === ccu.CcuId);
  const ccuDir = join(outDir, 'interfaces', `${ccu.CcuId}-${safe(ccu.Name)}`);
  save(join(ccuDir, '_interface.json'), ccu);
  const modules = devs.filter((x) => children[x.ID] || /Module/.test(x.Model || '')).sort((a, b) => a.Name.localeCompare(b.Name, 'sk'));
  const moduleIds = new Set(modules.map((m) => m.ID));
  report.push(`\n${ccu.Name}  [${ccu.Model}]  ${devs.length} devices, ${modules.length} modules`);
  for (const m of modules) {
    const kids = (children[m.ID] || []).sort((a, b) => a.Name.localeCompare(b.Name, 'sk'));
    const mDir = join(ccuDir, `${m.ID}-${safe(m.Name)}`);
    writeDevice(mDir, '_module', m);
    for (const k of kids) writeDevice(mDir, `${k.ID}-${safe(k.Name)}`, k);
    const tags = [groupName(m.ZoneId), groupName(m.CategoryId)].filter(Boolean);
    report.push(`  ${m.Name.padEnd(40)} ${String(kids.length).padStart(3)} devices${tags.length ? '  [' + tags.join(', ') + ']' : ''}`);
  }
  const loose = devs.filter((x) => !moduleIds.has(x.ID) && !(x.HardwareParentId && devById[x.HardwareParentId]?.CcuId === ccu.CcuId));
  for (const x of loose) writeDevice(join(ccuDir, '_devices'), `${x.ID}-${safe(x.Name)}`, x);
  if (loose.length) report.push(`  (${loose.length} devices without a module)`);
}

// ---------- smart rules ----------
// MessageReconnectResponse.SmartRules = serialized TriggerModel blobs (the app deserializes each with
// ProtobufSerializer.Deserialize<TriggerModel>). IsDeleted ones are tombstones the app hides.
// TriggerInputs   = devices/values whose change wakes the rule (inputs)
// Priorities keys = devices the rule writes to (outputs), value = the rule's priority on that device
const rules = (d.SmartRules || []).map((b) => dec.message(Buffer.from(b, 'base64'), 'TriggerModel')).filter((r) => !r.IsDeleted);
for (const r of rules) r.Name = T(r.Name);
const devName = (id) => `${id} "${devById[id]?.Name ?? 'missing'}"`;
// generic, type-independent summary (lib.mjs)
const describeRule = makeRuleDescriber(devName);

const byDevice = {};
const rulesDir = join(outDir, 'smartrules');
const ruleIndex = [];
for (const r of rules.sort((a, b) => a.Id - b.Id)) {
  const inputs = connIds(r.TriggerInputs), condInputs = connIds(r.LimitingConditionInputs);
  const outputs = Object.keys(r.Priorities || {}).map(Number);
  for (const [role, ids] of [['input', inputs], ['condition', condInputs], ['output', outputs]]) {
    for (const id of ids) (byDevice[id] ||= { device: devById[id]?.Name ?? null, rules: [] }).rules.push({ id: r.Id, name: r.Name, role });
  }
  const base = `${r.Id}-${safe(r.Name)}`;
  const summary = describeRule(r);
  ruleIndex.push({ id: r.Id, name: r.Name, type: r.TriggerParameters?.$type?.replace(/TriggerParameters$/, ''), enabled: !!r.IsEnabled,
    inputs: inputs.map(devName), outputs: outputs.map(devName), condition: r.LimitingConditionParameters?.$type?.replace(/LimitingConditionParameters$/, '') });
  save(join(rulesDir, `${base}.json`), { summary: summary.split('\n'), ...r });
  // scripts / formulas as separate files so they diff cleanly
  const texts = ruleTexts(r);
  for (const [k, v] of Object.entries(texts)) save(join(rulesDir, `${base}.${k}.txt`), v.replace(/\r?\n/g, '\r\n'));
  ruleIndex.at(-1).summary = summary;
}
save(join(outDir, 'smartrules.json'), ruleIndex.map(({ summary, ...x }) => x));
save(join(outDir, 'smartrules.txt'), ruleIndex.map((x) => x.summary).join('\n\n') + '\n');
save(join(outDir, 'smartrules-by-device.json'), byDevice);
const typeCount = {};
for (const x of ruleIndex) typeCount[x.type] = (typeCount[x.type] || 0) + 1;
report.push(`\nSMART RULES (${rules.length}, ${(d.SmartRules || []).length - rules.length} deleted tombstones skipped)`);
for (const [t, n] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) report.push(`  ${String(t).padEnd(40)} ${n}`);

for (const k of ['zones', 'categories', 'dashboards']) {
  report.push(`\n${k.toUpperCase()} (${groups[k].length})`);
  for (const g of groups[k]) {
    const n = g.devices ? `${g.devices.length} devices` : `${(g.sections || []).reduce((a, s) => a + (s.devices?.length || 0), 0)} devices in ${(g.sections || []).length} sections`;
    report.push(`  ${String(g.name).padEnd(30)} ${n}`);
  }
}
const scriptFiles = d.Devices.reduce((a, x) => a + Object.entries(x.DeviceProperties || {}).filter(([k, v]) => isScript(k, v)).length, 0);
report.push(`\n[export] out/config: ${d.Devices.length} devices, ${scriptFiles} script files, core ${d.CoreVersionString}`);
console.log(report.join('\n'));
