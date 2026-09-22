const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp } = require('./helpers/app-harness.cjs');

const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const live = (h) => h.audio.sources.filter((n) => !n.cancelled);

test('20–300 BPM 与 1–8 细分的全部组合：一分钟内保持原拍点', async () => {
  const h = makeApp();
  for (let bpm = 20; bpm <= 300; bpm++) for (let subdiv = 1; subdiv <= 8; subdiv++) {
    await h.begin({ bpm, subdiv });
    for (let i = 1; i < 2400; i++) h.at(i / 40, false);
    const sounds = live(h), dt = 60 / bpm / subdiv;
    assert.ok(sounds.length > 0);
    sounds.forEach((n, i) => { near(n.t, .08 + i * dt); assert.ok(n.t >= n.createdAt); });
  }
});

test('十分钟极端细分与全部预置节奏的时间轴无累计漂移', async () => {
  const h = makeApp();
  await h.begin({ bpm: 137, subdiv: 8 });
  for (let i = 1; i < 24000; i++) h.at(i / 40, false);
  live(h).forEach((n, i) => near(n.t, .08 + i * 60 / 137 / 8, 1e-6));
  for (const mode of ['groove', 'pad', 'combo']) {
    const list = mode === 'groove' ? h.app.grooves : mode === 'pad' ? h.app.pads : h.app.presets;
    for (const item of list) {
      const settings = { mode, bpm: 137, groove: item.id, pad: item.id };
      if (mode === 'combo') settings.combo = h.app.sanitizeCombo(item.seq);
      await h.begin(settings);
      for (let i = 1; i < 2400; i++) h.at(i / 40, false);
      const q = h.app.queue.filter((e) => e.groove), dt = 60 / 137 / (mode === 'combo' ? 12 : item.spb);
      q.forEach((e, i) => near(e.t, .08 + i * dt));
      assert.ok(live(h).length > 0);
    }
  }
});

test('卡顿只跳过错过的音符，恢复后仍在原网格上，不补播', async () => {
  const h = makeApp();
  await h.begin({ bpm: 300, subdiv: 8 });
  h.at(.3);
  assert.ok(live(h).some((n) => n.t > .3));
  for (const n of live(h)) {
    assert.ok(n.t >= n.createdAt + .005 - 1e-9);
    near((n.t - .08) / .025, Math.round((n.t - .08) / .025));
  }
  h.at(2.137);
  for (const n of live(h)) near((n.t - .08) / .025, Math.round((n.t - .08) / .025));
  h.at(40);
  assert.equal(h.app.runtime.playing, false);
  assert.equal(h.timers.size, 0);
});

test('切换任意细分都保持下一正拍在 580ms，之后仍每 500ms 一拍', async () => {
  const h = makeApp();
  for (const subdiv of [1, 2, 3, 5, 6, 7, 8]) {
    await h.begin({ bpm: 120, subdiv: 4 });
    for (let i = 1; i <= 10; i++) h.at(i / 40);
    h.app.setKey('subdiv', subdiv);
    for (let i = 11; i < 80; i++) h.at(i / 40);
    const beats = live(h).filter((n) => n.frequency.value === 1100);
    beats.forEach((n, i) => near(n.t, .08 + i * .5));
    assert.ok(beats.length >= 4);
  }
});

test('后台预排后调速：下一正拍采用新速度，旧音源被撤销', async () => {
  const h = makeApp();
  await h.begin();
  h.document.hidden = true; h.at(.1);
  assert.ok(live(h).some((n) => n.t > 3));
  h.document.hidden = false;
  h.app.setBpm(60);
  for (let i = 5; i < 140; i++) h.at(i / 40);
  const times = live(h).map((n) => n.t);
  assert.equal(times.length, 5);
  [.08, .58, 1.58, 2.58, 3.58].forEach((t, i) => near(times[i], t));
  assert.equal(h.app.runtime.shownBpm, 60);
});

test('启动重入和取消未完成的启动都不会遗留音源、定时器', async () => {
  const h = makeApp();
  let resume;
  h.audio.resume = () => new Promise((resolve) => { resume = resolve; });
  const first = h.app.start(), second = h.app.start();
  resume(); await Promise.all([first, second]);
  assert.equal(h.timers.size, 2);
  h.app.stop(); assert.equal(h.timers.size, 0); assert.equal(live(h).length, 0);
  const pending = h.app.start(); h.app.stop(); resume(); await pending;
  assert.equal(h.app.runtime.playing, false); assert.equal(h.timers.size, 0); assert.equal(live(h).length, 0);
});

test('渐进加速不污染持久化速度，停止后再打开仍是起始 BPM', async () => {
  const h = makeApp();
  await h.begin({ train: { on: true, every: 1, step: 10, max: 200, mute: 0 } });
  h.document.hidden = true; h.at(.1);
  assert.ok(h.app.runtime.audioBpm > 120);
  h.app.s.volClick = 80; h.app.save(); h.app.stop();
  assert.equal(JSON.parse(h.storage.get('metronome-v2')).bpm, 120);
  assert.equal(h.app.runtime.shownBpm, 120);
});

test('预备拍和每遍间隔可以在下一拍安全调速', async () => {
  const h = makeApp();
  await h.begin({ cdSec: 4 }); h.at(.1); h.app.setBpm(60);
  for (let i = 5; i < 350; i++) h.at(i / 40);
  const times = live(h).map((n) => n.t);
  near(times[1], .58); near(times[2], 1.58);
  await h.begin({ mode: 'combo', combo: [{ k: 'n', d: 48 }], gap: 4 });
  for (let i = 1; i <= 90; i++) h.at(i / 40);
  h.app.setBpm(60);
  for (let i = 91; i < 270; i++) h.at(i / 40, false);
  const gaps = h.app.queue.filter((e) => e.gap);
  near(gaps[0].t, 2.58); near(gaps[1].t, 3.58); near(gaps[2].t, 4.58);
});

test('同步换谱会清除播放缓存，空谱与坏 BPM 都有正确边界', async () => {
  const h = makeApp();
  h.app.s.combo = [{ k: 'n', d: 48 }]; h.app.comboTimeline();
  const m = h.window.SyncBridge.export(); m.v.combo = [{ k: 'r', d: 48 }]; m.v.bpm = 'bad';
  h.window.SyncBridge.apply(m);
  assert.equal(h.app.cache, null); assert.equal(h.app.s.bpm, 100);
  assert.equal(h.app.comboTimeline().hits.size, 0);
  m.v.combo = []; h.window.SyncBridge.apply(m); assert.equal(h.app.s.combo.length, 0);
  h.window.SongUI = { playing: () => true }; assert.equal(h.window.SyncBridge.apply(m), false);
});
