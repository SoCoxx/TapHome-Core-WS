// "Why did / didn't X happen?" for one device, in one session. Read-only. Prints:
//   - the device with its live values (and a manual override, device errors)
//   - its log: each change with origin, the rule that handled it and the device that started it, by name
//   - the rules that write it, with their live status (LimitedByCondition = blocked by its condition right now), each
//     rule's summary, and the current value of every variable its condition or formula reads
//   - the rules that only read it (inputs, conditions, variables)
//
// Usage: node why.mjs <device id | name words> [--log N] [--brief]
//   --log N   log lines to show, newest last (default 20; the Core keeps about 40)
//   --brief   no rule summaries, only status and variable values
import { connect, logLine, errorLine, ruleVariables, lastRunLines } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const logN = Number(opt('--log', 20));
const brief = args.includes('--brief');
const query = args.filter((a) => !a.startsWith('--')).join(' ');
if (!query) { console.error('usage: node why.mjs <device id | name words> [--log N] [--brief]'); process.exit(2); }

const th = await connect({ offline: false });
const { idx } = th;
let dev;
try { dev = idx.resolveDevice(query); } catch (e) { console.error(e.message); th.close(); process.exit(1); }
const id = dev.ID;

// ---------- the device ----------
const where = [idx.groupName(dev.ZoneId), idx.groupName(dev.CategoryId)].filter(Boolean).join(' / ');
console.log(`${idx.devName(id)}  [${dev.Model}]${where ? `  ${where}` : ''}${dev.IsIgnored ? '  (ignored)' : ''}`);
console.log(`  now: ${Object.keys(idx.values(dev)).filter((k) => k !== 'OperationMode' || idx.values(dev)[k].value === 1)
  .map((k) => idx.valueText(dev, k, { since: true })).join('  ') || '(no values)'}`);
const errs = await th.ask({ $type: 'MessageGetDeviceErrorsRequest', DeviceId: id });
for (const e of errs?.DeviceErrors || []) console.log(`  error: ${errorLine(e, 'Device', idx)}`);

// ---------- log ----------
const log = (await th.ask({ $type: 'MessageGetDeviceLogRequest', DeviceId: id }))?.ValueChangedLogEntries || [];
console.log(`\nLOG (${Math.min(logN, log.length)} of ${log.length}, newest last)`);
for (const e of log.slice(-logN)) console.log(`  ${logLine(e, idx)}`);
if (!log.length) console.log('  (empty)');

// ---------- rules that write the device ----------
const aff = (await th.ask({ $type: 'MessageGetAffectingTriggersInfoRequest', DeviceId: id }))?.Actions || {};
const writers = Object.values(aff).map((a) => ({ id: a.TriggerId, status: a.Status ?? 'NoInfo' })).sort((a, b) => a.id - b.id);
console.log(`\nRULES WRITING THIS DEVICE (${writers.length}, live status)`);
const STATUS_HINT = {
  LimitedByCondition: 'blocked by its limiting condition right now',
  ShouldNotEvaluate: 'not evaluated (outside its schedule/trigger)',
  ReturnedNoAction: 'evaluated, decided to do nothing',
  ReturnedAction: 'evaluated, wants to act (a higher priority may win)',
  ReturnedActionAndActionAplied: 'its action is what the device does now',
  Disabled: 'disabled',
};
for (const w of writers) {
  const r = idx.ruleById.get(w.id);
  const err = th.conf.SmartRuleErrorStatuses?.[w.id];
  const prio = r?.Priorities?.[id];
  console.log(`\n  #${w.id} ${r?.Name ?? '(not in configuration)'}  =>  ${w.status}${STATUS_HINT[w.status] ? `: ${STATUS_HINT[w.status]}` : ''}${prio != null ? `  [priority ${prio}]` : ''}${err ? `  [error status ${err}]` : ''}`);
  if (!r) continue;
  if (!brief) for (const l of idx.describeRule(r).split('\n').slice(1)) console.log(`    ${l}`);
  const vars = ruleVariables(r);
  if (vars.length) {
    console.log('    values now:');
    for (const v of vars) {
      const d = idx.devById.get(v.DeviceId);
      console.log(`      ${v.Abbreviation} = ${idx.devName(v.DeviceId)}.${d ? idx.valueText(d, v.ValueLogType) : v.ValueLogType}`);
    }
  }
  if (r.TriggerParameters?.Script) { // script rules: the debugger's last run
    const lr = await th.ask({ $type: 'MessageGetScriptLastRunValuesRequest', LastRunId: { ObjectIdType: 'Smartrule', ObjectId: w.id } });
    console.log('    last run:');
    for (const l of lastRunLines(lr)) console.log(`      ${l}`);
  }
}

// ---------- rules that read the device ----------
const readers = (idx.byDevice.get(id) || []).filter((x) => x.role !== 'output' && !aff[x.rule.Id]).sort((a, b) => a.rule.Id - b.rule.Id);
if (readers.length) {
  console.log(`\nRULES READING THIS DEVICE (${readers.length})`);
  for (const x of readers) console.log(`  ${x.role.padEnd(9)} #${x.rule.Id} ${x.rule.Name}${x.rule.IsEnabled ? '' : '  (disabled)'}`);
}
th.close();
