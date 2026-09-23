const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, makeApp } = require('./helpers/app-harness.cjs');

const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const stream = () => ({ stopped: 0, getTracks() { return [{ stop: () => { this.stopped++; } }]; } });

function scanner({ camera, detect = async () => [], play = async () => {} }) {
  const h = makeApp();
  h.sandbox.navigator.mediaDevices = { getUserMedia: camera };
  h.window.BarcodeDetector = class { detect = detect; };
  h.get('pairQr').getContext = () => ({ clearRect() {} });
  Object.assign(h.get('pairVideo'), { play, readyState: 2 });
  h.sandbox.fetch = () => { throw new Error('本测试禁止网络请求'); };
  vm.runInContext(read('js/sync.js'), h.sandbox);
  h.scan = () => h.get('pairScan').click();
  h.close = () => h.get('pairClose').click();
  h.loops = () => [...h.timers.values()].filter((t) => t.ms === 250);
  return h;
}

test('取消扫码后，迟到的摄像头授权立即释放，不再扫描', async () => {
  const camera = deferred(), media = stream();
  const h = scanner({ camera: () => camera.promise });
  const opening = h.scan();
  await h.close(); camera.resolve(media); await opening;
  assert.equal(media.stopped, 1);
  assert.equal(h.get('pairVideo').srcObject, null);
  assert.equal(h.get('pair').hidden, true);
  assert.equal(h.loops().length, 0);
});

test('关闭后重开扫码：旧授权或旧拒绝都不能关闭新会话', async () => {
  for (const rejectOld of [false, true]) {
    const old = deferred(), current = stream(), stale = stream();
    let calls = 0;
    const h = scanner({ camera: () => ++calls === 1 ? old.promise : Promise.resolve(current) });
    const first = h.scan();
    await h.close(); await h.scan();
    if (rejectOld) old.reject(new Error('旧授权被拒绝')); else old.resolve(stale);
    await first;
    assert.equal(h.get('pair').hidden, false);
    assert.equal(h.get('pairVideo').srcObject, current);
    assert.equal(current.stopped, 0);
    assert.equal(stale.stopped, rejectOld ? 0 : 1);
    assert.equal(h.loops().length, 1);
    await h.close(); assert.equal(current.stopped, 1);
  }
});

test('等待视频播放或二维码识别时取消，不能复活扫描或更换同步配置', async () => {
  const video = deferred(), media = stream();
  const h = scanner({ camera: async () => media, play: () => video.promise });
  const opening = h.scan();
  await Promise.resolve(); await h.close(); video.resolve(); await opening;
  assert.equal(h.loops().length, 0); assert.equal(media.stopped, 1);

  const detection = deferred();
  const q = scanner({ camera: async () => stream(), detect: () => detection.promise });
  await q.scan();
  const pending = q.loops()[0].f();
  await q.close();
  // 仅测试用占位数据，不是真实令牌，也不访问 GitHub。
  detection.resolve([{ rawValue: 'DRUMSYNC1:' + btoa(JSON.stringify({ t: 'test_placeholder_123456789', g: '', s: '' })) }]);
  await pending;
  assert.equal(q.window.CloudApi.hasToken(), false);
  assert.equal(q.storage.has('metronome-sync-v1'), false);
  assert.equal(q.loops().length, 0);
});

function songApp() {
  const h = makeApp();
  h.sandbox.location = { href: 'https://review.invalid/' };
  h.app.s.mode = 'song';
  const event = () => {
    const handlers = [];
    return { on(fn) { handlers.push(fn); }, emit(value) { handlers.forEach((fn) => fn(value)); } };
  };
  const score = { tracks: [], masterBars: [0, 960].map((start) => ({ start, calculateDuration: () => 960 })) };
  let api;
  h.window.alphaTab = { LayoutMode: { Page: 0 }, AlphaTabApi: class {
    constructor() {
      api = this;
      for (const name of ['scoreLoaded', 'renderFinished', 'playerReady', 'playerStateChanged', 'error']) this[name] = event();
      this.isReadyForPlayback = true; this.plays = 0;
    }
    load() { this.scoreLoaded.emit(score); this.playerReady.emit(); return true; }
    renderTracks() {}
    changeTrackMute() {}
    clearPlaybackRangeHighlight() {}
    playPause() { this.plays++; }
  } };
  // 只在内存副本中暴露打开函数；其余使用实际界面事件与桥接对象。
  vm.runInContext(read('js/song.js').replace(/\}\)\(\);\s*$/, 'window.__openRecord = openRecord; })();'), h.sandbox);
  h.open = (id) => h.window.__openRecord({ id, name: id, data: new Uint8Array([1]).buffer });
  h.api = () => api;
  return h;
}

test('整首循环和小节循环同时开启时，一次取消勾选即可全部关闭并保存', async () => {
  const h = songApp(); await h.open('valid');
  h.get('songLoop').checked = true; await h.get('songLoop').emit('change');
  h.get('loopFrom').value = '1'; h.get('loopTo').value = '2';
  await h.get('loopSet').click();
  assert.ok(h.api().playbackRange); assert.equal(h.api().isLooping, true);
  h.get('songLoop').checked = false; await h.get('songLoop').emit('change');
  assert.equal(h.get('songLoop').checked, false);
  assert.equal(h.api().isLooping, false);
  assert.equal(h.api().playbackRange, null);
  assert.equal(JSON.parse(h.storage.get('metronome-v2')).songPref.loop, false);
  h.get('songLoop').checked = true; await h.get('songLoop').emit('change');
  assert.equal(h.api().isLooping, true);
});

test('曲谱加载抛错、返回失败或异步报错均保留提示，不会误播旧谱；重选好谱可恢复', async () => {
  for (const mode of ['throw', 'false', 'event', 'later']) {
    const h = songApp(); await h.open('valid');
    const api = h.api(), goodLoad = api.load;
    await h.window.SongUI.toggle(); assert.equal(api.plays, 1);
    api.load = () => {
      if (mode === 'throw') throw new Error('损坏的谱');
      if (mode === 'false') return false;
      if (mode === 'event') api.error.emit(new Error('解析失败'));
      return true;
    };
    await h.open('bad');
    if (mode === 'later') api.error.emit(new Error('异步解析失败'));
    // 上一份音色的迟到事件不能擦掉失败提示。
    api.playerReady.emit();
    assert.match(h.get('songMsg').textContent, /打开失败/);
    assert.equal(h.get('songBody').hidden, true);
    assert.equal(h.get('songScroll').classList.contains('busy'), false);
    await h.window.SongUI.toggle(); assert.equal(api.plays, 1);
    api.load = goodLoad; await h.open('valid-again');
    assert.equal(h.get('songBody').hidden, false);
    assert.equal(h.get('songMsg').textContent, '');
    await h.window.SongUI.toggle(); assert.equal(api.plays, 2);
  }
});
