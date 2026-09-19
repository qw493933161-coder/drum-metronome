// Pure, environment-agnostic rhythm math: no DOM, no AudioContext, no timers.
// Runs identically under Node (for unit tests) and in the browser (real playback),
// so the numbers the tests assert on are exactly the numbers the engine uses live.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RhythmMath = mod;
}(typeof self !== 'undefined' ? self : this, function () {

  const ACCENT = { MUTE: 0, WEAK: 1, NORMAL: 2, ACCENT: 3 };

  function defaultAccentPattern(beatsPerBar) {
    const arr = new Array(beatsPerBar).fill(ACCENT.NORMAL);
    arr[0] = ACCENT.ACCENT;
    return arr;
  }

  // bpm at a given bar index within a section (linear ramp if section.isRamp)
  function getBpmAt(section, barIdx) {
    if (!section.isRamp) return section.bpm;
    const span = Math.max(section.bars - 1, 1);
    const t = Math.min(Math.max(barIdx / span, 0), 1);
    return section.bpmFrom + (section.bpmTo - section.bpmFrom) * t;
  }

  // seconds per beat, honoring the note value the beat is counted in (4 = quarter, 8 = eighth...)
  function beatDurationSeconds(section, bpm) {
    return (60 / bpm) * (4 / section.noteValue);
  }

  function accentAt(section, beatIdx) {
    if (!section.accentPattern || section.accentPattern[beatIdx] == null) return ACCENT.NORMAL;
    return section.accentPattern[beatIdx];
  }

  // Pure state transition: given the current {secIdx, barIdx, beatIdx} and the
  // section list, returns the next state plus how many seconds elapsed to get
  // there. Does not mutate its inputs.
  function advance(state, sections, loop) {
    const section = sections[state.secIdx];
    const bpm = getBpmAt(section, state.barIdx);
    const elapsed = beatDurationSeconds(section, bpm);

    let secIdx = state.secIdx;
    let barIdx = state.barIdx;
    let beatIdx = state.beatIdx + 1;
    let finished = false;

    if (beatIdx >= section.beatsPerBar) {
      beatIdx = 0;
      barIdx += 1;
      const bars = section.bars;
      if (bars !== Infinity && barIdx >= bars) {
        barIdx = 0;
        secIdx += 1;
        if (secIdx >= sections.length) {
          if (loop) secIdx = 0;
          else finished = true;
        }
      }
    }

    return { state: { secIdx, barIdx, beatIdx, finished }, elapsed };
  }

  // subdivision step index (within an attached drum pattern) for the s-th
  // sub-step of the given beat, when the pattern has `stepsPerBar` steps
  // laid out evenly across `beatsPerBar` beats.
  function stepIndexFor(beatIdx, stepsPerBeat, s) {
    return Math.round(beatIdx * stepsPerBeat) + s;
  }

  return {
    ACCENT,
    defaultAccentPattern,
    getBpmAt,
    beatDurationSeconds,
    accentAt,
    advance,
    stepIndexFor
  };
}));
