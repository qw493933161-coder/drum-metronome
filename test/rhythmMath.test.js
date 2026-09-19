// Minimal zero-dependency test runner (no npm needed) for rhythmMath.js.
// Run with: node test/rhythmMath.test.js
const assert = require('assert');
const RM = require('../js/rhythmMath.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok - ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL - ' + name);
    console.log('    ' + e.message);
  }
}

function approx(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) < (eps || 1e-6), (msg || '') + ` expected ${a} ~= ${b}`);
}

console.log('rhythmMath.js');

test('beatDurationSeconds: 120 bpm quarter-note beat = 0.5s', () => {
  const section = { noteValue: 4 };
  approx(RM.beatDurationSeconds(section, 120), 0.5);
});

test('beatDurationSeconds: 120 bpm eighth-note beat = 0.25s', () => {
  const section = { noteValue: 8 };
  approx(RM.beatDurationSeconds(section, 120), 0.25);
});

test('getBpmAt: non-ramp section returns flat bpm regardless of bar', () => {
  const section = { isRamp: false, bpm: 140 };
  approx(RM.getBpmAt(section, 0), 140);
  approx(RM.getBpmAt(section, 7), 140);
});

test('getBpmAt: ramp interpolates linearly across bars, inclusive endpoints', () => {
  // 4 bars: bar indices 0,1,2,3 -> t = 0, 1/3, 2/3, 1
  const section = { isRamp: true, bpmFrom: 80, bpmTo: 120, bars: 4 };
  approx(RM.getBpmAt(section, 0), 80);
  approx(RM.getBpmAt(section, 3), 120);
  approx(RM.getBpmAt(section, 1), 80 + (120 - 80) * (1 / 3), 1e-6);
  approx(RM.getBpmAt(section, 2), 80 + (120 - 80) * (2 / 3), 1e-6);
});

test('getBpmAt: single-bar ramp does not divide by zero, uses bpmFrom', () => {
  const section = { isRamp: true, bpmFrom: 80, bpmTo: 120, bars: 1 };
  approx(RM.getBpmAt(section, 0), 80);
});

test('defaultAccentPattern: first beat accented, rest normal', () => {
  const p = RM.defaultAccentPattern(4);
  assert.deepStrictEqual(p, [RM.ACCENT.ACCENT, RM.ACCENT.NORMAL, RM.ACCENT.NORMAL, RM.ACCENT.NORMAL]);
});

test('advance: steps through beats within a bar', () => {
  const sections = [{ bpm: 120, noteValue: 4, beatsPerBar: 4, bars: 2, isRamp: false }];
  let state = { secIdx: 0, barIdx: 0, beatIdx: 0 };
  const r1 = RM.advance(state, sections, false);
  assert.deepStrictEqual({ secIdx: r1.state.secIdx, barIdx: r1.state.barIdx, beatIdx: r1.state.beatIdx }, { secIdx: 0, barIdx: 0, beatIdx: 1 });
  approx(r1.elapsed, 0.5);
});

test('advance: rolls over to next bar after last beat', () => {
  const sections = [{ bpm: 120, noteValue: 4, beatsPerBar: 4, bars: 2, isRamp: false }];
  let state = { secIdx: 0, barIdx: 0, beatIdx: 3 };
  const r = RM.advance(state, sections, false);
  assert.deepStrictEqual({ secIdx: r.state.secIdx, barIdx: r.state.barIdx, beatIdx: r.state.beatIdx }, { secIdx: 0, barIdx: 1, beatIdx: 0 });
});

test('advance: rolls over to next section after last bar', () => {
  const sections = [
    { bpm: 120, noteValue: 4, beatsPerBar: 4, bars: 1, isRamp: false },
    { bpm: 90, noteValue: 4, beatsPerBar: 3, bars: 4, isRamp: false }
  ];
  let state = { secIdx: 0, barIdx: 0, beatIdx: 3 };
  const r = RM.advance(state, sections, false);
  assert.strictEqual(r.state.secIdx, 1);
  assert.strictEqual(r.state.barIdx, 0);
  assert.strictEqual(r.state.beatIdx, 0);
});

test('advance: without loop, finishes after the last section\'s last beat', () => {
  const sections = [{ bpm: 120, noteValue: 4, beatsPerBar: 2, bars: 1, isRamp: false }];
  let state = { secIdx: 0, barIdx: 0, beatIdx: 1 };
  const r = RM.advance(state, sections, false);
  assert.strictEqual(r.state.finished, true);
});

test('advance: with loop, wraps back to section 0 instead of finishing', () => {
  const sections = [{ bpm: 120, noteValue: 4, beatsPerBar: 2, bars: 1, isRamp: false }];
  let state = { secIdx: 0, barIdx: 0, beatIdx: 1 };
  const r = RM.advance(state, sections, true);
  assert.strictEqual(r.state.finished, false);
  assert.strictEqual(r.state.secIdx, 0);
});

test('advance: infinite bars (quick mode) never rolls to a new section', () => {
  const sections = [{ bpm: 120, noteValue: 4, beatsPerBar: 4, bars: Infinity, isRamp: false }];
  let state = { secIdx: 0, barIdx: 500, beatIdx: 3 };
  const r = RM.advance(state, sections, false);
  assert.strictEqual(r.state.secIdx, 0);
  assert.strictEqual(r.state.barIdx, 501);
  assert.strictEqual(r.state.finished, false);
});

test('advance: 300 consecutive beats at 120bpm/4/4 sum to exact wall-clock time (no drift in the math)', () => {
  const sections = [{ bpm: 120, noteValue: 4, beatsPerBar: 4, bars: Infinity, isRamp: false }];
  let state = { secIdx: 0, barIdx: 0, beatIdx: 0 };
  let total = 0;
  for (let i = 0; i < 300; i++) {
    const r = RM.advance(state, sections, false);
    total += r.elapsed;
    state = r.state;
  }
  approx(total, 300 * 0.5, 1e-9); // 0.5s per beat at 120bpm, summed exactly
});

test('stepIndexFor: maps sub-steps within a beat to absolute pattern step index', () => {
  // 16 steps over 4 beats -> 4 steps per beat
  assert.strictEqual(RM.stepIndexFor(0, 4, 0), 0);
  assert.strictEqual(RM.stepIndexFor(0, 4, 3), 3);
  assert.strictEqual(RM.stepIndexFor(1, 4, 0), 4);
  assert.strictEqual(RM.stepIndexFor(3, 4, 3), 15);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
