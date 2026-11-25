// Value history of one device, with the request built for you and a summary. Read-only.
//
// Usage: node history.mjs <device id | name words> [ValueLogType] [--hours N | --days N] [--agg raw|1h|1d|1m]
//                         [--fn Avg|Min|Max|Count|SumOrIntegral|CurrentValue|Derivate] [--all] [--csv]
//   ValueLogType  default: the only recorded one, else RealTemperature, else the first recorded one
//   range         default 5 h raw (the Core keeps raw values about 5 h, hourly about 8 days, daily/monthly 1 year)
//   --agg         default: raw up to 5 h, hourly up to 8 days, daily beyond
//   --fn          the statistics function of an aggregation (default Avg)
//   --all         print every point (default: at most 60, evenly thinned, plus the summary)
//   --csv         only "local time;value" lines, for plotting or a spreadsheet
// Switch-like values (0/1) are summarised as on-time and number of switch-ons instead of min/max/avg.
import { connect, replyPoints, localTime } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const hours = Number(opt('--days', 0)) * 24 || Number(opt('--hours', 5));
const AGG = { '1h': 'Period1H', '1d': 'Period1D', '1m': 'Period1M' };
const agg = opt('--agg', hours <= 5 ? 'raw' : hours <= 8 * 24 ? '1h' : '1d');
const fn = opt('--fn', 'Avg');
const all = args.includes('--all'), csv = args.includes('--csv');
const words = args.filter((a) => !a.startsWith('--'));
if (!words.length || (agg !== 'raw' && !AGG[agg])) {
  console.error('usage: node history.mjs <device id | name words> [ValueLogType] [--hours N | --days N] [--agg raw|1h|1d|1m] [--fn Avg] [--all] [--csv]');
  process.exit(2);
}

const th = await connect({ offline: false });
const { idx } = th;
// the last word is the ValueLogType when it looks like one (PascalCase, known to the device or the schema)
let vlt = null;
const last = words.at(-1);
if (words.length > 1 && /^[A-Z][A-Za-z]+$/.test(last)) { vlt = last; words.pop(); }
let dev;
try { dev = idx.resolveDevice(words.join(' ')); } catch (e) { console.error(e.message); th.close(); process.exit(1); }

const recorded = Object.keys(dev.EnabledValueAggregations || {});
if (!vlt) vlt = recorded.length === 1 ? recorded[0] : recorded.includes('RealTemperature') ? 'RealTemperature' : recorded[0];
if (!vlt) {
  console.log(`${idx.devName(dev.ID)} records no history. Turn it on first (references/writing.md, value history); values: ${idx.valuesLine(dev) || '-'}`);
  th.close(); process.exit(0);
}
if (!recorded.includes(vlt)) console.log(`! ${vlt} is not recorded on this device (recorded: ${recorded.join(', ') || 'none'}); the reply will be empty`);
const enabledAggs = (dev.EnabledValueAggregations?.[vlt] || []).map((a) => (a.Period ? `${a.StatisticsFunction ?? 'CurrentValue'}/${a.Period}` : 'raw'));
const want = agg === 'raw' ? 'raw' : `${fn}/${AGG[agg]}`;
if (recorded.includes(vlt) && !enabledAggs.includes(want)) console.log(`! ${want} is not among the recorded aggregations (${enabledAggs.join(', ')}); the reply may be empty`);
if (agg === 'raw' && hours > 5) console.log('! raw values reach back only about 5 h; use --agg 1h for longer ranges');

const to = new Date(), from = new Date(to.getTime() - hours * 3600e3);
const r = await th.ask({
  $type: 'MessageDeviceValueHistoryDataRequest', DeviceId: dev.ID, ValueLogType: vlt,
  ValueAggregation: agg === 'raw' ? {} : { StatisticsFunction: fn, PeriodType: 'CurrentPeriod', Period: AGG[agg] },
  DateTimeFromUtc: from.toISOString(), DateTimeToUtc: to.toISOString(),
});
const pts = replyPoints(r).filter((p) => !Number.isNaN(p[1]) && p[1] != null && Date.parse(p[0]) >= from.getTime() - 3600e3);
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(3)));

if (csv) { for (const p of pts) console.log(`${localTime(p[0])};${p[1]}`); th.close(); }
else {
  console.log(`${idx.devName(dev.ID)}  ${vlt}  ${agg === 'raw' ? 'raw' : `${fn} per ${agg}`}  ${localTime(from).slice(0, 16)} .. ${localTime(to).slice(0, 16)}`);
  console.log(`  now: ${idx.valueText(dev, vlt, { since: true })}`);
  if (!r) console.log('  no reply');
  else if (!pts.length) console.log('  no points in this range');
  else {
    const vals = pts.map((p) => p[1]);
    const isBit = vals.every((v) => v === 0 || v === 1);
    if (isBit && agg === 'raw') { // on-time and switch-ons; a raw point is stored on change
      let on = 0, ons = 0;
      for (let i = 0; i < pts.length; i++) {
        const t0 = Math.max(Date.parse(pts[i][0]), from.getTime()), t1 = i + 1 < pts.length ? Date.parse(pts[i + 1][0]) : to.getTime();
        if (pts[i][1] === 1) { on += Math.max(0, t1 - t0); if (i === 0 || pts[i - 1][1] === 0) ons++; }
      }
      console.log(`  ${pts.length} points, ${ons} switch-on(s), on for ${(on / 60000).toFixed(0)} min of ${(hours * 60).toFixed(0)} (${((on / (hours * 3600e3)) * 100).toFixed(1)} %)`);
    } else {
      const min = Math.min(...vals), max = Math.max(...vals), avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const at = (v) => localTime(pts[vals.indexOf(v)][0]).slice(5, 16);
      console.log(`  ${pts.length} points  min ${fmt(min)} (${at(min)})  max ${fmt(max)} (${at(max)})  avg ${fmt(avg)}  first ${fmt(vals[0])}  last ${fmt(vals.at(-1))}`);
    }
    const step = all || pts.length <= 60 ? 1 : Math.ceil(pts.length / 60);
    if (step > 1) console.log(`  (every ${step}. point of ${pts.length}; --all for all, --csv for a table)`);
    for (let i = 0; i < pts.length; i += step) console.log(`  ${localTime(pts[i][0])}  ${fmt(pts[i][1])}`);
    if (step > 1 && (pts.length - 1) % step) console.log(`  ${localTime(pts.at(-1)[0])}  ${fmt(pts.at(-1)[1])}`);
  }
  th.close();
}
