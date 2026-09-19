// Playback engine: schedules audio via AudioEngine.playAt() (sample-accurate,
// anchored to AudioContext.currentTime) and drains a time-ordered event queue
// on a setInterval tick to fire UI/vibration callbacks in close sync with
// what's actually audible. Beat/bar/section math is delegated to RhythmMath
// so the same logic is covered by the Node unit tests.
//
// Deliberately NOT requestAnimationFrame: rAF only fires on an actual paint
// cycle, so it can silently stall (tab not compositing, low-power throttling,
// some automated/headless browser contexts) while everything else keeps
// running — audio would stay correct but the beat light and vibration would
// freeze. setInterval is what already drives the sample-accurate audio
// scheduling below and has proven reliable in exactly the situations where
// rAF stalled during testing, so the UI drain uses the same mechanism.
(function (root) {
  const RM = root.RhythmMath;
  const TICK_MS = 25;
  const DRAIN_MS = 15;
  const LOOKAHEAD_SEC = 0.15;

  function clickKeyForAccent(level) {
    if (level === RM.ACCENT.ACCENT) return 'click_accent';
    if (level === RM.ACCENT.WEAK) return 'click_weak';
    return 'click_normal';
  }

  class Engine {
    constructor(opts) {
      this.sections = opts.sections;
      this.loop = !!opts.loop;
      this.patternsById = opts.patternsById || {};
      this.onBeat = opts.onBeat || function () {};
      this.onStep = opts.onStep || function () {};
      this.onSectionChange = opts.onSectionChange || function () {};
      this.onFinish = opts.onFinish || function () {};
      this.vibrationEnabled = !!opts.vibrationEnabled;
      this.running = false;
      this.eventQueue = [];
      this.tickTimer = null;
      this.drainTimer = null;
      this.stopTimer = null;
    }

    start() {
      if (this.running || !this.sections.length) return;
      this.running = true;
      this.state = { secIdx: 0, barIdx: 0, beatIdx: 0 };
      this.nextBeatTime = root.AudioEngine.currentTime + 0.05;
      this._lastAnnouncedSection = -1;
      this.eventQueue = [];
      this._tick();
      this.tickTimer = setInterval(() => this._tick(), TICK_MS);
      this.drainTimer = setInterval(() => this._drainEvents(), DRAIN_MS);
    }

    stop() {
      this.running = false;
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = null;
      if (this.drainTimer) clearInterval(this.drainTimer);
      this.drainTimer = null;
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      this.eventQueue = [];
    }

    _tick() {
      if (!this.running) return;
      const now = root.AudioEngine.currentTime;
      while (this.running && this.nextBeatTime < now + LOOKAHEAD_SEC) {
        this._scheduleBeat(this.nextBeatTime, this.state);
        const section = this.sections[this.state.secIdx];
        const bpm = RM.getBpmAt(section, this.state.barIdx);
        const { state: nextState, elapsed } = RM.advance(this.state, this.sections, this.loop);
        this.nextBeatTime += elapsed;
        this.state = nextState;
        if (nextState.finished) {
          this.running = false;
          if (this.tickTimer) clearInterval(this.tickTimer);
          this.tickTimer = null;
          const delayMs = Math.max(0, (this.nextBeatTime - root.AudioEngine.currentTime) * 1000);
          this.stopTimer = setTimeout(() => this.onFinish(), delayMs);
          break;
        }
      }
    }

    _scheduleBeat(time, state) {
      const section = this.sections[state.secIdx];
      const bpm = RM.getBpmAt(section, state.barIdx);
      const beatDur = RM.beatDurationSeconds(section, bpm);
      const accentLevel = RM.accentAt(section, state.beatIdx);
      const randomMuted = !!(section.randomMute && section.randomMute.enabled &&
        Math.random() < section.randomMute.probability);
      const muted = randomMuted || accentLevel === RM.ACCENT.MUTE;

      if (!muted) root.AudioEngine.playAt(clickKeyForAccent(accentLevel), time, 'click');

      this.eventQueue.push({
        time, type: 'beat',
        payload: {
          secIdx: state.secIdx, barIdx: state.barIdx, beatIdx: state.beatIdx,
          muted, accentLevel, bpm: Math.round(bpm),
          beatsPerBar: section.beatsPerBar, bars: section.bars, sectionName: section.name
        }
      });

      const pattern = section.drumPatternId ? this.patternsById[section.drumPatternId] : null;
      if (pattern && pattern.stepsPerBar && section.beatsPerBar) {
        const stepsPerBeat = pattern.stepsPerBar / section.beatsPerBar;
        if (stepsPerBeat > 0) {
          const n = Math.round(stepsPerBeat);
          for (let s = 0; s < n; s++) {
            const stepIndex = RM.stepIndexFor(state.beatIdx, stepsPerBeat, s);
            if (stepIndex >= pattern.stepsPerBar) continue;
            const stepTime = time + (s / n) * beatDur;
            ['kick', 'snare', 'hihat'].forEach(track => {
              if (pattern.tracks[track] && pattern.tracks[track][stepIndex]) {
                root.AudioEngine.playAt(track === 'hihat' ? 'hihat_closed' : track, stepTime, 'pattern');
              }
            });
            this.eventQueue.push({ time: stepTime, type: 'step', payload: { patternId: pattern.id, stepIndex } });
          }
        }
      }
    }

    _drainEvents() {
      const now = root.AudioEngine.currentTime;
      while (this.eventQueue.length && this.eventQueue[0].time <= now) {
        const evt = this.eventQueue.shift();
        if (evt.type === 'beat') {
          if (evt.payload.secIdx !== this._lastAnnouncedSection) {
            this._lastAnnouncedSection = evt.payload.secIdx;
            this.onSectionChange({ secIdx: evt.payload.secIdx, section: this.sections[evt.payload.secIdx] });
          }
          this.onBeat(evt.payload);
          if (this.vibrationEnabled && navigator.vibrate && !evt.payload.muted) {
            navigator.vibrate(evt.payload.accentLevel === RM.ACCENT.ACCENT ? 35 : 12);
          }
        } else {
          this.onStep(evt.payload);
        }
      }
      // once playback has actually finished and every already-scheduled event
      // has drained, the timer has nothing left to do — stop it
      if (!this.running && !this.eventQueue.length && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }
  }

  root.Engine = Engine;
}(typeof window !== 'undefined' ? window : globalThis));
