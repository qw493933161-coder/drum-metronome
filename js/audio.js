// Web Audio engine: owns the single shared AudioContext, synthesizes every
// click/drum sound as an in-memory AudioBuffer (no asset files to fetch —
// works fully offline from first load), and exposes precise, sample-accurate
// scheduled playback via node.start(time).
(function (root) {
  let ctx = null;
  let gains = null; // { click, pattern, music, master }
  let buffers = null; // sound key -> AudioBuffer

  function ensureContext() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    gains = {
      master: ctx.createGain(),
      click: ctx.createGain(),
      pattern: ctx.createGain(),
      music: ctx.createGain()
    };
    gains.click.connect(gains.master);
    gains.pattern.connect(gains.master);
    gains.music.connect(gains.master);
    gains.master.connect(ctx.destination);
    buffers = buildBuffers(ctx);
    return ctx;
  }

  // resume() must be called from within a user-gesture handler (tap/click) —
  // browsers refuse to start audio otherwise.
  async function resume() {
    ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx.state;
  }

  function noise() { return Math.random() * 2 - 1; }

  function makeBuffer(ctx, durSec, fillFn) {
    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.floor(sr * durSec));
    const buf = ctx.createBuffer(1, n, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = fillFn(i / sr, i, n);
    return buf;
  }

  function buildBuffers(ctx) {
    const b = {};
    b.click_accent = makeBuffer(ctx, 0.06, t => {
      const env = Math.exp(-t * 45);
      const f = 1500 * (1 - t * 1.5);
      return Math.sin(2 * Math.PI * f * t) * env * 0.9;
    });
    b.click_normal = makeBuffer(ctx, 0.055, t => {
      const env = Math.exp(-t * 45);
      const f = 1000 * (1 - t * 1.5);
      return Math.sin(2 * Math.PI * f * t) * env * 0.7;
    });
    b.click_weak = makeBuffer(ctx, 0.05, t => {
      const env = Math.exp(-t * 45);
      const f = 800 * (1 - t * 1.5);
      return Math.sin(2 * Math.PI * f * t) * env * 0.45;
    });
    b.kick = makeBuffer(ctx, 0.28, t => {
      const freq = 150 * Math.exp(-t * 18) + 45;
      const env = Math.exp(-t * 14);
      const clickTail = t < 0.003 ? (1 - t / 0.003) * 0.6 * noise() : 0;
      return (Math.sin(2 * Math.PI * freq * t) * env + clickTail) * 0.95;
    });
    b.snare = makeBuffer(ctx, 0.22, t => {
      const envN = Math.exp(-t * 18);
      const envT = Math.exp(-t * 30);
      const tone = (Math.sin(2 * Math.PI * 185 * t) + Math.sin(2 * Math.PI * 330 * t) * 0.5) * envT * 0.5;
      return (noise() * envN * 0.7 + tone) * 0.9;
    });
    let prevHat = 0;
    b.hihat_closed = makeBuffer(ctx, 0.09, t => {
      const env = Math.exp(-t * 55);
      const raw = noise();
      const hp = raw - prevHat;
      prevHat = raw;
      return hp * env * 0.8;
    });
    prevHat = 0;
    b.hihat_open = makeBuffer(ctx, 0.3, t => {
      const env = Math.exp(-t * 9);
      const raw = noise();
      const hp = raw - prevHat;
      prevHat = raw;
      return hp * env * 0.8;
    });
    return b;
  }

  // Schedule a sound to start at an exact AudioContext time (sample-accurate).
  // category selects which gain bus (and therefore which volume slider) it goes through.
  function playAt(key, time, category) {
    if (!ctx || !buffers[key]) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers[key];
    src.connect(gains[category] || gains.master);
    src.start(Math.max(time, ctx.currentTime));
  }

  function setVolume(category, value) {
    if (!gains) return;
    gains[category].gain.value = Math.max(0, Math.min(1, value));
  }

  root.AudioEngine = {
    ensureContext,
    resume,
    playAt,
    setVolume,
    get currentTime() { return ctx ? ctx.currentTime : 0; },
    get state() { return ctx ? ctx.state : 'closed'; },
    get context() { return ctx; }
  };
}(typeof window !== 'undefined' ? window : globalThis));
