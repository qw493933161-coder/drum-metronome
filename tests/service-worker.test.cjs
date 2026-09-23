const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers/app-harness.cjs');

function worker({ status = 200, fail = false, cached = {} } = {}) {
  const listeners = {}, timers = new Map(), puts = [];
  const env = {
    self: { location: { origin: 'https://review.invalid' }, addEventListener: (type, fn) => { listeners[type] = fn; } },
    caches: { open: async () => ({
      match: async (req) => {
        const value = cached[typeof req === 'string' ? req : req.url];
        return value === undefined ? undefined : new Response(value);
      },
      put: async (req, res) => { puts.push({ url: req.url, text: await res.text() }); }
    }) },
    fetch: async () => { if (fail) throw new Error('offline'); return new Response('network', { status }); },
    AbortController, Response, URL,
    setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); }
  };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8'), env);
  return { timers, puts, async get(url, mode = 'navigate') {
    let response;
    listeners.fetch({ request: { url, mode, method: 'GET' }, respondWith(promise) { response = promise; } });
    return response;
  } };
}
const page = 'https://review.invalid/index.html';
const script = 'https://review.invalid/js/song.js';

test('服务器 5xx 优先回退对应页面或脚本缓存，无精确页面缓存时回退入口', async () => {
  for (const status of [500, 502, 503, 504]) {
    const h = worker({ status, cached: { [page]: 'saved page', [script]: 'saved script', 'index.html': 'entry' } });
    assert.equal(await (await h.get(page)).text(), 'saved page');
    assert.equal(await (await h.get(script, 'cors')).text(), 'saved script');
    assert.equal(await (await h.get('https://review.invalid/?standalone')).text(), 'entry');
    assert.equal(h.puts.length, 0); assert.equal(h.timers.size, 0);
  }
});

test('无缓存时保留服务器错误；成功与 404 响应不被旧缓存替换', async () => {
  const unavailable = worker({ status: 503 });
  assert.equal((await unavailable.get(page)).status, 503);
  for (const status of [200, 404]) {
    const h = worker({ status, cached: { [page]: 'old' } });
    const res = await h.get(page);
    assert.equal(res.status, status); assert.equal(await res.text(), 'network');
    assert.equal(h.puts.length, status === 200 ? 1 : 0);
    assert.equal(h.timers.size, 0);
  }
});

test('断网仍可离线打开；脚本无缓存时不得返回 HTML，所有请求清理超时器', async () => {
  const h = worker({ fail: true, cached: { 'index.html': 'offline entry' } });
  assert.equal(await (await h.get(page)).text(), 'offline entry');
  assert.equal((await h.get(script, 'cors')).type, 'error');
  assert.equal(h.timers.size, 0);
});
