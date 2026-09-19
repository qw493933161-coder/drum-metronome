// Builds the full traditional "音符时值表" (note-value chart) as an importable backup:
// ~45 drum patterns (single snare voice, one 4/4 bar each) + 5 progressive practice plans.
// Run: node scripts/gen_rhythm_chart.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const RM = require('../js/rhythmMath.js');

const all = (n) => Array.from({ length: n }, (_, i) => i);
const every = (steps, n) => { const o = []; for (let i = 0; i < steps; i += n) o.push(i); return o; };
// one beat-sized cell of 0/1 repeated across the 4 beats of the bar
function cell(steps, c) {
  const per = steps / 4;
  assert.strictEqual(c.length, per, 'cell length must equal steps per beat');
  const o = [];
  for (let b = 0; b < 4; b++) c.forEach((v, i) => { if (v) o.push(b * per + i); });
  return o;
}
// cells for each of the 4 beats separately
function cells4(steps, cs) {
  const per = steps / 4;
  const o = [];
  cs.forEach((c, b) => { assert.strictEqual(c.length, per); c.forEach((v, i) => { if (v) o.push(b * per + i); }); });
  return o;
}
const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };

// ---- pattern definitions: { id, group, name, steps, onsets } ----
const defs = [];
const def = (id, group, name, steps, onsets) => defs.push({ id, group, name, steps, onsets });

// Group 1 — basic note values (16 steps: 1 step = 16th note)
def('chart-whole', 1, '全音符', 16, [0]);
def('chart-half', 1, '二分音符', 16, [0, 8]);
def('chart-dotted-half', 1, '附点二分音符+四分音符', 16, [0, 12]);
def('rhythm-quarter', 1, '四分音符', 16, every(16, 4));
def('chart-dotted-quarter-eighth', 1, '附点四分音符+八分音符', 16, [0, 6, 8, 14]);
def('rhythm-eighth', 1, '八分音符', 16, every(16, 2));
def('rhythm-sixteenth', 1, '十六分音符', 16, every(16, 1));

// Group 2 — every one-beat combination on the sixteenth grid (counted 1 e & a)
def('chart-16-1e', 2, '1 e：十六分+附点八分', 16, cell(16, [1, 1, 0, 0]));
def('chart-16-1a', 2, '1 a：附点八分+十六分', 16, cell(16, [1, 0, 0, 1]));
def('rhythm-two-s-e', 2, '1 e &：前十六后八', 16, cell(16, [1, 1, 1, 0]));
def('rhythm-e-two-s', 2, '1 & a：前八后十六', 16, cell(16, [1, 0, 1, 1]));
def('chart-16-1ea', 2, '1 e a：十六+八+十六（切分）', 16, cell(16, [1, 1, 0, 1]));
def('chart-16-and', 2, '& ：只打反拍（反拍八分）', 16, cell(16, [0, 0, 1, 0]));
def('chart-16-e', 2, 'e ：只打 e', 16, cell(16, [0, 1, 0, 0]));
def('chart-16-a', 2, 'a ：只打 a', 16, cell(16, [0, 0, 0, 1]));
def('chart-16-e-and', 2, 'e &', 16, cell(16, [0, 1, 1, 0]));
def('chart-16-e-a', 2, 'e a', 16, cell(16, [0, 1, 0, 1]));
def('chart-16-and-a', 2, '& a：八分休止+两个十六分', 16, cell(16, [0, 0, 1, 1]));
def('chart-16-e-and-a', 2, 'e & a：十六分休止+三个十六分', 16, cell(16, [0, 1, 1, 1]));

// Group 3 — triplets (12 steps = 8th-note triplets) and sextuplets (24 steps)
def('rhythm-triplet', 3, '八分三连音（全打）', 12, all(12));
def('chart-t-quarter', 3, '四分三连音（两拍三音）', 12, every(12, 2));
def('chart-t-13', 3, '1 let：首尾（摇摆八分/Shuffle）', 12, cell(12, [1, 0, 1]));
def('chart-t-12', 3, '1 trip：前两音（末音休止）', 12, cell(12, [1, 1, 0]));
def('chart-t-23', 3, 'trip let：后两音（首音休止）', 12, cell(12, [0, 1, 1]));
def('chart-t-2', 3, 'trip：只打中间音', 12, cell(12, [0, 1, 0]));
def('chart-t-3', 3, 'let：只打末音', 12, cell(12, [0, 0, 1]));
def('chart-sextuplet', 3, '六连音（十六分三连音）', 24, all(24));

// Group 4 — rests
def('rhythm-rest', 4, '四分音符+四分休止（打1、3拍）', 16, [0, 8]);
def('chart-rest-b1', 4, '四分休止在第1拍', 16, [4, 8, 12]);
def('chart-rest-b2', 4, '四分休止在第2拍', 16, [0, 8, 12]);
def('chart-rest-b3', 4, '四分休止在第3拍', 16, [0, 4, 12]);
def('chart-rest-b4', 4, '四分休止在第4拍', 16, [0, 4, 8]);
def('chart-rest-8th-lead', 4, '八分休止开头+七个八分', 16, range(1, 7).map(i => i * 2));
def('chart-rest-16th-lead', 4, '十六分休止开头+十五个十六分', 16, range(1, 15));
def('chart-rest-8th-b2', 4, '八分音符｜第2拍休止', 16, [0, 2, 8, 10, 12, 14]);
def('chart-rest-8th-b3', 4, '八分音符｜第3拍休止', 16, [0, 2, 4, 6, 12, 14]);
def('chart-rest-16th-front', 4, '十六分音符｜前两拍打、后两拍休止', 16, range(0, 7));
def('chart-rest-16th-back', 4, '十六分音符｜前两拍休止、后两拍打', 16, range(8, 15));

// Group 5 — syncopation & common combined rhythms
def('chart-sync-8-4-8', 5, '切分：八分+四分+八分', 16, [0, 2, 6, 8, 10, 14]);
def('chart-332-8th', 5, '附点四分 3+3+2（八分音符分组）', 16, [0, 6, 12]);
def('chart-332-16th', 5, '十六分 3+3+2（每半小节）', 16, [0, 3, 6, 8, 11, 14]);
def('chart-333322', 5, '十六分 3+3+3+3+2+2', 16, [0, 3, 6, 9, 12, 14]);
def('chart-swing-ride', 5, '摇摆 Ride 型（1、2、2let、3、4、4let）', 12, [0, 3, 5, 6, 9, 11]);
def('chart-alt-e2s', 5, '前八后十六 / 前十六后八 交替', 16,
  cells4(16, [[1, 0, 1, 1], [1, 1, 1, 0], [1, 0, 1, 1], [1, 1, 1, 0]]));
def('chart-alt-dot', 5, '附点八+十六 / 十六+附点八 交替', 16,
  cells4(16, [[1, 0, 0, 1], [1, 1, 0, 0], [1, 0, 0, 1], [1, 1, 0, 0]]));

// ---- validation ----
const ids = new Set();
defs.forEach(d => {
  assert.ok(!ids.has(d.id), 'duplicate id ' + d.id);
  ids.add(d.id);
  assert.strictEqual(d.steps % 4, 0, d.id + ': steps must divide by 4 beats');
  d.onsets.forEach(o => assert.ok(o >= 0 && o < d.steps, `${d.id}: onset ${o} out of range`));
  assert.strictEqual(new Set(d.onsets).size, d.onsets.length, d.id + ': repeated onset');
});
const seen = {};
defs.forEach(d => {
  const key = d.steps + ':' + d.onsets.slice().sort((a, b) => a - b).join(',');
  if (seen[key]) console.log(`note: identical onsets — ${seen[key]} == ${d.id} (kept: different teaching intent)`);
  seen[key] = d.id;
});

// ---- build patterns (updatedAt descending so the app lists them in chart order) ----
const now = Date.now();
const counters = {};
const byId = {};
const patterns = defs.map((d, idx) => {
  counters[d.group] = (counters[d.group] || 0) + 1;
  const z = () => new Array(d.steps).fill(0);
  const snare = z();
  d.onsets.forEach(i => { snare[i] = 1; });
  const p = {
    id: d.id,
    name: `${d.group}-${String(counters[d.group]).padStart(2, '0')} ${d.name}`,
    stepsPerBar: d.steps,
    tracks: { kick: z(), snare, hihat: z() },
    updatedAt: now - idx * 1000
  };
  byId[d.id] = { pattern: p, rawName: d.name };
  return p;
});

// ---- plans ----
function section(id, patternId) {
  return {
    id: 'sec-' + patternId,
    name: byId[patternId].rawName,
    isRamp: false, bpm: 80, bpmFrom: 80, bpmTo: 80,
    beatsPerBar: 4, noteValue: 4, bars: 4,
    accentPattern: RM.defaultAccentPattern(4),
    randomMute: { enabled: false, probability: 0.2 },
    drumPatternId: patternId
  };
}
function plan(id, name, patternIds, idx) {
  patternIds.forEach(pid => assert.ok(byId[pid], 'unknown pattern ' + pid));
  return { id, name, loop: false, sections: patternIds.map(pid => section(null, pid)), updatedAt: now - idx * 1000 };
}
const g = (n) => defs.filter(d => d.group === n).map(d => d.id);

const plans = [
  plan('plan-rhythm-fundamentals', '时值表 1｜基础音符时值', g(1), 0),
  plan('plan-chart-2', '时值表 2｜十六分音符单拍组合（1 e & a）',
    ['rhythm-quarter', 'rhythm-eighth', 'rhythm-sixteenth',
     'chart-16-1e', 'chart-16-1a', 'rhythm-two-s-e', 'rhythm-e-two-s', 'chart-16-1ea',
     'chart-16-and', 'chart-16-e', 'chart-16-a', 'chart-16-e-and', 'chart-16-e-a', 'chart-16-and-a', 'chart-16-e-and-a'], 1),
  plan('plan-chart-3', '时值表 3｜三连音与六连音',
    ['rhythm-triplet', 'chart-t-quarter', 'chart-t-13', 'chart-t-12', 'chart-t-23', 'chart-t-2', 'chart-t-3', 'chart-sextuplet'], 2),
  plan('plan-chart-4', '时值表 4｜休止符练习', g(4), 3),
  plan('plan-chart-5', '时值表 5｜切分与综合节奏型', g(5), 4)
];

const backup = { exportedAt: new Date().toISOString(), version: 1, plans, patterns };
const outPath = path.join(__dirname, '..', 'data', 'rhythm-value-chart.json');
fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));
console.log(`wrote ${outPath}\n${patterns.length} patterns, ${plans.length} plans\n`);

patterns.forEach(p => {
  const per = p.stepsPerBar / 4;
  const s = p.tracks.snare.map(v => (v ? 'x' : '.')).join('');
  const grouped = s.match(new RegExp('.{1,' + per + '}', 'g')).join(' ');
  console.log(p.name.padEnd(44, ' '), grouped);
});
