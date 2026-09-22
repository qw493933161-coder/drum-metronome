const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, makeApp } = require('./helpers/app-harness.cjs');

function syncCore(h) {
  const source = fs.readFileSync(path.join(ROOT, 'js/sync.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('  // ---------- 设置存取')) + '\n})();', h.sandbox);
  return h.window.SyncCore;
}

test('合并能忽略坏谱条目，拍数/细分/节奏格仍整组取值', () => {
  const h = makeApp(), { merge } = syncCore(h);
  const a = { v: { beats: 4, subdiv: 1, cells: ['0', '0', '0', '0'] }, at: { cells: 30 }, mine: [] };
  const b = { v: { beats: 3, subdiv: 2, cells: ['11', '11', '11'] }, at: { beats: 20 }, mine: [null, 1, {}], gone: [null] };
  const m = merge(a, b);
  assert.equal(m.v.beats, 4); assert.equal(m.v.subdiv, 1); assert.equal(m.mine.length, 0);
});

test('相同时间戳的不同内容在两台设备上得到相同结果', () => {
  const { merge, sig } = syncCore(makeApp());
  const a = { v: { bpm: 100 }, at: { bpm: 10 }, mine: [], gone: [] };
  const b = { v: { bpm: 120 }, at: { bpm: 10 }, mine: [], gone: [] };
  assert.equal(sig(merge(a, b)), sig(merge(b, a)));
});

test('两台设备修改不同练习速度、曲谱偏好时保留双方改动', () => {
  const initial = { tempos: { m: 100, 'g:rock-q': 100 }, stamps: { tempos: 1, songPref: 1 } };
  const a = makeApp(initial), b = makeApp(initial), { merge, sig } = syncCore(a);
  a.app.setBpm(90);
  b.app.s.tempos['g:rock-q'] = 130; b.app.save();
  a.window.SongBridge.setPref({ click: true });
  b.window.SongBridge.setPref({ speeds: { demo: .8 } });
  const left = a.window.SyncBridge.export(), right = b.window.SyncBridge.export(), m = merge(left, right);
  assert.equal(m.v.tempos.m, 90); assert.equal(m.v.tempos['g:rock-q'], 130);
  assert.equal(m.v.songPref.click, true); assert.equal(m.v.songPref.speeds.demo, .8);
  assert.equal(sig(m), sig(merge(right, left)));
  a.window.SyncBridge.apply(m);
  assert.equal(sig(merge(a.window.SyncBridge.export(), m)), sig(m));
});

test('新设备接受旧版整组时间戳，逐项删除不会被旧副本复活', () => {
  const a = makeApp({ tempos: { m: 100, old: 80 }, stamps: { tempos: 1 } });
  const { merge } = syncCore(a), before = a.window.SyncBridge.export();
  delete a.app.s.tempos.old; a.app.save();
  const result = merge(a.window.SyncBridge.export(), before);
  assert.equal(result.v.tempos.old, undefined);
  const fresh = makeApp(), remote = { v: { tempos: { m: 155 } }, at: { tempos: 100 }, mine: [], gone: [] };
  assert.equal(merge(fresh.window.SyncBridge.export(), remote).v.tempos.m, 155);
});

test('谱名和谱 ID 仅通过文本节点和 dataset 写入列表', () => {
  const h = makeApp(), m = h.window.SyncBridge.export();
  m.mine = [{ id: 'id" <tag>', name: '<b>练习</b>', seq: [{ k: 'n', d: 12 }], updated: 1 }];
  h.app.s.mode = 'combo'; h.window.SyncBridge.apply(m);
  const row = h.get('cMine').children[0];
  assert.equal(row.innerHTML, '');
  assert.equal(row.children[0].textContent, '<b>练习</b>');
  assert.equal(row.children[1].children[0].dataset.exp, 'id" <tag>');
});

test('数字记谱导入导出保留三连音、休止，拒绝非法时值', () => {
  const h = makeApp();
  const seq = h.app.parseDigits('123. 1.34 t1.3 ....');
  const result = h.app.decodeSheets(h.app.encodeSheets([{ name: '练习', seq }]));
  assert.equal(JSON.stringify(result[0].seq), JSON.stringify(seq));
  assert.equal(h.app.sanitizeCombo([{ k: 'n', d: 'toString' }, { k: 'n', d: '12' }]).length, 0);
});
