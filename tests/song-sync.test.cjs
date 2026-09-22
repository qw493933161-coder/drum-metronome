const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers/app-harness.cjs');

const source = fs.readFileSync(path.join(ROOT, 'js/song.js'), 'utf8');
const code = source.slice(source.indexOf('  async function cloudSync(retried)'), source.indexOf('  // ---------- 界面事件'));
function setup({ files = {}, gist = 'library', recordGist = 'library', busy = false, failRaw = false, duringRead } = {}) {
  const records = new Map([['demo', { id: 'demo', name: '练习', synced: true, syncedGist: recordGist, data: new Uint8Array([1]).buffer }]]);
  const patches = [], messages = [];
  let gone = [];
  const ctx = { cloudBusy: false, cloudAgain: false, cloudRetry: null, curId: '', MAX_CLOUD: 700 * 1024,
    cloudOn: () => true, playbackBusy: () => busy, requireIdle: () => { if (busy) throw new Error('playing'); }, retryWhenIdle() {}, clearTimeout() {},
    cloudSay: (message) => messages.push(message),
    window: { CloudApi: { songsGist: () => gist, call: async (url, opts) => {
      if (opts) { patches.push(opts.body.files); return {}; }
      if (duringRead) busy = true;
      return { files };
    } } },
    readGone: () => gone.slice(), writeGone: (a) => { gone = a; },
    dbAll: async () => [...records.values()], dbGet: async (id) => records.get(id),
    dbPut: async (r) => records.set(r.id, r), dbDel: async (id) => records.delete(id),
    renderList() {}, fromB64: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer,
    toB64: (buf) => Buffer.from(buf).toString('base64'),
    fetch: async () => { if (failRaw) throw new Error('offline'); return { ok: false }; }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { records, patches, messages, run: () => ctx.cloudSync() };
}

test('原始文件下载失败：整轮取消，不删除本机曲谱', async () => {
  const h = setup({ files: { 's-demo.json': { truncated: true, raw_url: 'https://example.invalid/mock' } }, failRaw: true });
  await h.run(); assert.equal(h.records.size, 1); assert.equal(h.patches.length, 0);
});

test('一份云端谱内容损坏：只跳过这一份，本机不删，并用本机副本修复', async () => {
  for (const f of [{ content: '{bad' }, { content: JSON.stringify({ id: 'other', data: 'AA==' }) }, { content: JSON.stringify({ id: 'demo', data: '!' }) }]) {
    const h = setup({ files: { 's-demo.json': f } });
    await h.run();
    assert.equal(h.records.size, 1);
    assert.equal(h.patches.length, 1);
    assert.ok(h.patches[0]['s-demo.json'] && h.patches[0]['s-demo.json'].content.includes('"id":"demo"'));
  }
});

test('损坏的谱不会拖住其他谱：好的照常下载，坏的只提示', async () => {
  const good = { id: 'fresh', name: '新谱', added: 1, data: 'AQI=' };
  const h = setup({ files: { 's-demo.json': { content: JSON.stringify({ ...good, id: 'demo' }) }, 's-fresh.json': { content: JSON.stringify(good) }, 's-lost.json': { content: '{bad' } } });
  await h.run();
  assert.ok(h.records.has('fresh'));
  assert.ok(h.records.has('demo'));
  assert.ok(h.messages.some((m) => m.includes('1 份谱已损坏')));
});

test('换库或旧版记录缺少来源时保留并重新上传；同库明确删除才删除本机', async () => {
  for (const recordGist of ['old-library', '']) {
    const h = setup({ recordGist }); await h.run();
    assert.equal(h.records.size, 1); assert.ok(h.patches[0]['s-demo.json']);
    assert.equal(h.records.get('demo').syncedGist, 'library');
  }
  const deleted = setup(); await deleted.run(); assert.equal(deleted.records.size, 0);
});

test('开始同步之前或等待网络时开始播放，均推迟本地数据改动', async () => {
  for (const options of [{ busy: true }, { duringRead: true }]) {
    const h = setup(options); await h.run();
    assert.equal(h.records.size, 1); assert.equal(h.patches.length, 0);
  }
});


