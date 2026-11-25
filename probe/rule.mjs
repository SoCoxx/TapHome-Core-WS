// One smart rule, everything about it, in one session. Read-only. Prints:
//   - the summary (as in out/config/smartrules.txt) and the full script/formula texts
//   - its live status on every device it writes (LimitedByCondition = blocked by its condition right now)
//   - the current value of every variable it reads, and of the devices that wake it
//   - its errors, and for script rules the debugger's last run (variable values per step)
//
// Usage: node rule.mjs <rule id | name words>
import { connect, connIds, ruleTexts, ruleVariables, lastRunLines, errorLine } from './lib.mjs';

const query = process.argv.slice(2).join(' ');
if (!query) { console.error('usage: node rule.mjs <rule id | name words>'); process.exit(2); }

const th = await connect({ offline: false });
const { idx } = th;
let r;
try { r = idx.resolveRule(query); } catch (e) { console.error(e.message); th.close(); process.exit(1); }

console.log(idx.describeRule(r));
for (const [k, v] of Object.entries(ruleTexts(r))) {
  if (k === 'ConditionFormula') continue; // describeRule prints it already
  console.log(`\n  ${k}:`);
  for (const l of v.split(/\r?\n/)) console.log(`    | ${l}`);
}

// live status, per device it writes
const outputs = Object.keys(r.Priorities || {}).map(Number);
if (outputs.length) {
  console.log('\nSTATUS (live, per device it writes)');
  for (const id of outputs) {
    const aff = (await th.ask({ $type: 'MessageGetAffectingTriggersInfoRequest', DeviceId: id }))?.Actions || {};
    const mine = aff[r.Id];
    const others = Object.values(aff).filter((a) => a.TriggerId !== r.Id).map((a) => `#${a.TriggerId} ${a.Status ?? 'NoInfo'}`);
    const d = idx.devById.get(id);
    console.log(`  ${idx.devName(id)}: ${mine?.Status ?? 'NoInfo'}  [priority ${r.Priorities[id]}]  now ${d ? idx.valuesLine(d) || '-' : '?'}`);
    if (others.length) console.log(`    other rules on it: ${others.join(', ')}`);
  }
}

// what it reads
const vars = ruleVariables(r);
if (vars.length) {
  console.log('\nVARIABLES NOW');
  for (const v of vars) {
    const d = idx.devById.get(v.DeviceId);
    console.log(`  ${v.Abbreviation} = ${idx.devName(v.DeviceId)}.${d ? idx.valueText(d, v.ValueLogType, { since: true }) : v.ValueLogType}  (${v.where})`);
  }
}
const named = new Set(vars.map((v) => v.DeviceId));
const wakers = [...new Set([...connIds(r.TriggerInputs), ...connIds(r.LimitingConditionInputs)])].filter((id) => !named.has(id));
if (wakers.length) {
  console.log('\nINPUTS NOW (devices whose change wakes the rule)');
  for (const id of wakers) {
    const d = idx.devById.get(id);
    const vals = id === 1 ? '(time-driven)' : d ? idx.valuesLine(d, { since: true }) || '-' : '?'; // device 1 = TapHome Clock
    console.log(`  ${idx.devName(id)}  ${vals}`);
  }
}

// errors and last run
const errStatus = th.conf.SmartRuleErrorStatuses?.[r.Id];
const errs = (await th.ask({ $type: 'MessageGetTriggerErrorsRequest', TriggerId: r.Id }))?.TriggerErrors || [];
console.log(`\nERRORS: ${errs.length ? '' : 'none'}${errStatus ? ` (error status ${errStatus})` : ''}`);
for (const e of errs) console.log(`  ${errorLine(e, 'Trigger', idx)}`);
if (r.TriggerParameters?.Script || /Script/.test(r.TriggerParameters?.$type ?? '')) {
  const lr = await th.ask({ $type: 'MessageGetScriptLastRunValuesRequest', LastRunId: { ObjectIdType: 'Smartrule', ObjectId: r.Id } });
  console.log('\nLAST RUN');
  for (const l of lastRunLines(lr)) console.log(`  ${l}`);
}
th.close();
