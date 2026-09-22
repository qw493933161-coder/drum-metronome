// 在内存 DOM 和可控音频时钟中运行原应用。测试钩子只注入内存副本，不进入发布代码。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const MAIN = fs.readFileSync(path.join(ROOT, 'js/metronome.js'), 'utf8');
const EXPOSE = `window.__test = {
  s, start, stop, tick, drain, setBpm, setKey, setTrain, save, comboTimeline, comboChanged,
  parseDigits, encodeSheets, decodeSheets, sanitizeCombo, layoutCombo, rewindAtBeat,
  grooves: GROOVES, pads: PADS, presets: COMBO_PRESETS,
  get queue() { return queue; }, get cache() { return comboCache; },
  get runtime() { return { playing, starting, nextTime, audioBpm, shownBpm, countLeft, gapLeft }; }
};\n})();`;

function element() {
  const events = new Map();
  const classes = new Set();
  let html = '';
  return {
    hidden: true, value: '', textContent: '', dataset: {}, children: [],
    style: { setProperty() {} },
    classList: {
      add(v) { classes.add(v); }, remove(v) { classes.delete(v); }, contains(v) { return classes.has(v); },
      toggle(v, on) { if (on) classes.add(v); else classes.delete(v); }
    },
    get innerHTML() { return html; }, set innerHTML(v) { html = v; this.children = []; },
    addEventListener(k, f) { if (!events.has(k)) events.set(k, []); events.get(k).push(f); },
    emit(k, event = {}) { return Promise.all((events.get(k) || []).map((f) => f({ target: this, ...event }))); },
    click() { return this.emit('click'); },
    setAttribute() {}, append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}

class AudioClock {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.sources = []; this.destination = {}; }
  resume() { return Promise.resolve(); }
  parameter() {
    return { value: 1, events: [], setValueAtTime(v, t) { this.events.push({ v, t }); },
      exponentialRampToValueAtTime(v, t) { this.events.push({ v, t }); },
      cancelScheduledValues(t) { this.events = this.events.filter((e) => e.t < t); } };
  }
  node() {
    return { gain: this.parameter(), frequency: this.parameter(),
      connect(target) { this.target = target; return target; }, disconnect() { this.target = null; } };
  }
  createGain() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createBuffer() { return { getChannelData: () => new Float32Array(128) }; }
  source(kind) {
    const clock = this;
    const node = Object.assign(this.node(), { kind,
      start(t) { this.t = t; this.createdAt = clock.currentTime; },
      stop(t) { this.end = t === undefined ? clock.currentTime : t; if (t === undefined) this.cancelled = true; }
    });
    this.sources.push(node);
    return node;
  }
  createOscillator() { return this.source('oscillator'); }
  createBufferSource() { return this.source('noise'); }
}

function makeApp(initial = {}) {
  const nodes = new Map(), timers = new Map(), storage = new Map();
  const audio = new AudioClock();
  if (Object.keys(initial).length) storage.set('metronome-v2', JSON.stringify(initial));
  let timerId = 0;
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = Object.assign(element(), { hidden: false, visibilityState: 'visible',
    getElementById: get, createElement: element, body: element(), documentElement: element() });
  const window = Object.assign(element(), { matchMedia: () => ({ matches: false, addEventListener() {} }),
    AudioContext: function () { return audio; } });
  const sandbox = { window, document, console, navigator: {},
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    setInterval(f, ms) { timers.set(++timerId, { f, ms }); return timerId; },
    clearInterval(id) { timers.delete(id); }, setTimeout() { return ++timerId; }, clearTimeout() {},
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, btoa, atob, URL };
  vm.createContext(sandbox);
  vm.runInContext(MAIN.replace(/\}\)\(\);\s*$/, EXPOSE), sandbox);
  window.KeepAlive.on = () => {};
  window.KeepAlive.off = () => {};
  const app = window.__test;
  function at(t, drain = true) { audio.currentTime = t; app.tick(); if (drain && app.runtime.playing) app.drain(); }
  async function begin(settings = {}) {
    app.stop(); audio.currentTime = 0; audio.sources = [];
    Object.assign(app.s, { mode: 'metro', bpm: 120, beats: 4, subdiv: 1, cdSec: 0, gap: 0,
      train: { on: false, every: 1, step: 10, max: 200, mute: 0 }, ...settings });
    app.s.cells = Array.from({ length: app.s.beats }, () => '0'.repeat(app.s.subdiv));
    app.comboChanged();
    await app.start();
  }
  return { app, audio, window, document, sandbox, storage, timers, get, at, begin };
}

module.exports = { ROOT, MAIN, EXPOSE, makeApp, element };
