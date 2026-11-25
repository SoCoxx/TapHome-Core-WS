// Finds devices, smart rules and zones/categories by name, with the devices' live values. Read-only.
//
// Usage: node find.mjs <query> [<query> ...] [--rules] [--json]
//   query    a device id, or words that must all appear in the name, zone or category (any case, diacritics optional):
//            "svetlo kuchyna", "492", "teplota garaz"
//   --rules  also list each device's smart rules (role: input / condition / variable / output)
//   --json   machine-readable output
// env: OFFLINE=1 searches out/reconnect.json (from dump.mjs) without connecting; its values are as old as the dump
import { connect, fold, hasWord, J } from './lib.mjs';

const args = process.argv.slice(2);
const queries = args.filter((a) => !a.startsWith('--'));
const withRules = args.includes('--rules'), asJson = args.includes('--json');
if (!queries.length) { console.error('usage: node find.mjs <query> [<query> ...] [--rules] [--json]'); process.exit(2); }

const th = await connect();
const { idx } = th;
const MAX = 40;
const out = [];
const roles = (id) => (idx.byDevice.get(id) || []).sort((a, b) => a.rule.Id - b.rule.Id);

for (const q of queries) {
  const devices = idx.findDevices(q);
  const rules = /^\d+$/.test(q) ? [] : idx.findRules(q);
  const groups = /^\d+$/.test(q) ? [] : [...idx.dashById.values()].filter((g) => (g.DashboardTypeId === 1 || g.DashboardTypeId === 2)
    && fold(q).split(/\s+/).filter(Boolean).every((w) => hasWord(fold(idx.show(g.Name)), w)));
  if (asJson) {
    out.push({ query: q,
      devices: devices.map((x) => ({ id: x.ID, name: idx.name(x), model: x.Model, zone: idx.groupName(x.ZoneId), category: idx.groupName(x.CategoryId),
        values: Object.fromEntries(Object.entries(idx.values(x)).map(([k, v]) => [k, v.value])),
        ...(withRules ? { rules: roles(x.ID).map((r) => ({ id: r.rule.Id, name: r.rule.Name, role: r.role })) } : {}) })),
      rules: rules.map((r) => ({ id: r.Id, name: r.Name, type: r.TriggerParameters?.$type?.replace(/TriggerParameters$/, ''), enabled: !!r.IsEnabled })),
      groups: groups.map((g) => ({ id: g.DashboardId, name: idx.show(g.Name), kind: g.DashboardTypeId === 1 ? 'zone' : 'category' })) });
    continue;
  }
  console.log(`\n"${q}": ${devices.length} device(s), ${rules.length} rule(s)${groups.length ? `, ${groups.length} zone/category` : ''}`);
  for (const x of devices.slice(0, MAX)) {
    const where = [idx.groupName(x.ZoneId), idx.groupName(x.CategoryId)].filter(Boolean).join(' / ');
    console.log(`  ${String(x.ID).padStart(5)}  ${idx.name(x)}  [${x.Model}]${where ? `  ${where}` : ''}${x.IsIgnored ? '  (ignored)' : ''}`);
    const vals = idx.valuesLine(x, { since: true });
    if (vals) console.log(`         ${vals}`);
    if (withRules) for (const r of roles(x.ID)) console.log(`         ${r.role.padEnd(9)} #${r.rule.Id} ${r.rule.Name}${r.rule.IsEnabled ? '' : '  (disabled)'}`);
  }
  if (devices.length > MAX) console.log(`  … ${devices.length - MAX} more, narrow the query`);
  for (const r of rules.slice(0, MAX))
    console.log(`  rule #${r.Id}  ${r.Name}  [${r.TriggerParameters?.$type?.replace(/TriggerParameters$/, '') ?? r.TriggerTypeId}]${r.IsEnabled ? '' : '  (disabled)'}`);
  for (const g of groups) {
    const key = g.DashboardTypeId === 1 ? 'ZoneId' : 'CategoryId';
    const n = [...idx.devById.values()].filter((x) => x[key] === g.DashboardId).length;
    console.log(`  ${g.DashboardTypeId === 1 ? 'zone' : 'category'} "${idx.show(g.Name)}": ${n} devices (query "${idx.show(g.Name)}" lists them)`);
  }
}
if (asJson) console.log(J(out, 1));
else if (!th.live) console.log(`\n(OFFLINE: values from out/reconnect.json)`);
th.close();
