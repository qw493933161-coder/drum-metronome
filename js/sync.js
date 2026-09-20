// 云同步：把设置和练习谱存到你自己 GitHub 账号下的一个“秘密 Gist”里，多台设备共用。
// 令牌只存在本机 localStorage['metronome-sync-v1']，不进入导出、不进入 Gist、不写日志。
// 依赖 metronome.js 提供的 window.SyncBridge（export / apply / isPlaying / changed）。
(() => {
  'use strict';

  const CFG_KEY = 'metronome-sync-v1';
  const FILE = 'drum-metronome-sync.json';
  const DESC = 'drum-metronome-sync（练习数据同步，请勿删除）';
  const API = 'https://api.github.com';
  const GONE_KEEP = 90 * 24 * 3600 * 1000;
  const GROUPS = [['beats', 'subdiv', 'cells']];   // 这几项互相依赖，必须整组一起取新的那边

  // ---------- 合并（纯函数，不碰界面和网络） ----------
  const stampOf = (side, k) => (side && side.at && Number(side.at[k])) || 0;
  const created = (id) => parseInt(String(id).slice(0, 8), 36) || 0;

  function merge(L, R, now = Date.now()) {
    const v = {}, at = {}, done = new Set();
    const keys = Object.keys(L.v || {});      // 以本机认识的项为准，云端多出来的旧项直接丢弃
    keys.forEach((k) => {
      if (done.has(k)) return;
      const group = GROUPS.find((g) => g.includes(k)) || [k];
      const has = (side) => group.every((g) => side.v && g in side.v);
      const top = (side) => Math.max(0, ...group.map((g) => stampOf(side, g)));
      let win;
      if (!has(R)) win = L;
      else if (!has(L)) win = R;
      else win = top(R) > top(L) ? R : L;          // 平手留本地，避免来回抖动
      group.forEach((g) => {
        done.add(g);
        if (win.v && g in win.v) { v[g] = win.v[g]; if (stampOf(win, g)) at[g] = stampOf(win, g); }
      });
    });

    const goneAt = new Map();
    [...(L.gone || []), ...(R.gone || [])].forEach((g) => goneAt.set(g.id, Math.max(goneAt.get(g.id) || 0, g.at)));
    const best = new Map();
    [...(L.mine || []), ...(R.mine || [])].forEach((m) => {
      const cur = best.get(m.id);
      if (!cur || (m.updated || 1) > (cur.updated || 1)) best.set(m.id, m);
    });
    const mine = [];
    best.forEach((m, id) => {
      const g = goneAt.get(id);
      if (g === undefined || (m.updated || 1) > g) mine.push(m);     // 删除记号比谱新 → 谱已被删
    });
    mine.sort((a, b) => created(b.id) - created(a.id) || (a.id < b.id ? -1 : 1));
    const gone = [];
    goneAt.forEach((t, id) => {
      const m = best.get(id);
      if (now - t < GONE_KEEP && !(m && (m.updated || 1) > t)) gone.push({ id, at: t });
    });
    gone.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { v, at, mine, gone };
  }

  // 比较两份状态是否等价（谱的顺序、对象键顺序不算差异）
  const canon = (x) => {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') {
      const o = {};
      Object.keys(x).sort().forEach((k) => { o[k] = canon(x[k]); });
      return o;
    }
    return x;
  };
  const sig = (st) => JSON.stringify(canon({
    v: st.v || {}, at: st.at || {},
    mine: (st.mine || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1)),
    gone: (st.gone || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1))
  }));

  window.SyncCore = { merge, sig };

  // ---------- 设置存取 ----------
  let cfg = { token: '', gistId: '', songsGist: '', last: 0 };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY)) || {}); } catch (e) { /* ignore */ }
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  const $ = (id) => document.getElementById(id);
  const bridge = () => window.SyncBridge;

  // ---------- GitHub Gist 接口 ----------
  class ApiError extends Error {
    constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
  }
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: Object.assign({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + cfg.token
        }, opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store'
      });
    } catch (e) { throw new ApiError('network'); }
    if (res.status === 401) throw new ApiError('auth', 401);
    if (res.status === 404) throw new ApiError('notfound', 404);
    if (res.status === 403 || res.status === 429) throw new ApiError('limit', res.status);
    if (!res.ok) throw new ApiError('http', res.status);
    return res.json();
  }

  const fileBody = (st) => JSON.stringify({ version: 1, v: st.v, at: st.at, mine: st.mine, gone: st.gone });
  const filesOf = (st) => ({ [FILE]: { content: fileBody(st) } });

  async function findGist() {
    let best = null;
    for (let page = 1; page <= 10; page++) {
      const list = await api(`/gists?per_page=100&page=${page}`);
      list.forEach((g) => {
        if (g.description === DESC && g.files && g.files[FILE] && (!best || g.created_at < best.created_at)) best = g;
      });
      if (list.length < 100) break;
    }
    return best ? best.id : '';
  }
  async function createGist(st) {
    const g = await api('/gists', { method: 'POST', body: { description: DESC, public: false, files: filesOf(st) } });
    return g.id;
  }
  async function readGist(id) {
    const g = await api('/gists/' + id);
    const f = g.files && g.files[FILE];
    if (!f) throw new ApiError('notfound', 404);
    let text = f.content;
    if (f.truncated && f.raw_url) {
      try { text = await (await fetch(f.raw_url, { cache: 'no-store' })).text(); } catch (e) { throw new ApiError('network'); }
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') return { v: {}, at: {}, mine: [], gone: [] };
    return {
      v: data.v && typeof data.v === 'object' ? data.v : {},
      at: data.at && typeof data.at === 'object' ? data.at : {},
      mine: Array.isArray(data.mine) ? data.mine : [],
      gone: Array.isArray(data.gone) ? data.gone : []
    };
  }

  // ---------- 一次同步 ----------
  let running = false, again = false, verified = false, timer = null, backoff = 0, retryTimer = null;
  let state = 'off', msg = '';

  async function runOnce() {
    let st = bridge().export();
    if (!cfg.gistId) {
      cfg.gistId = await findGist();
      if (!cfg.gistId) { cfg.gistId = await createGist(st); saveCfg(); verified = true; return; }
      saveCfg();
    } else if (!verified) {
      // 每次打开只核对一次：两台设备同时首次开启时可能各建了一个，统一用最早的那个
      const oldest = await findGist();
      verified = true;
      if (oldest && oldest !== cfg.gistId) { cfg.gistId = oldest; saveCfg(); }
    }
    verified = true;
    let remote;
    try { remote = await readGist(cfg.gistId); }
    catch (e) {
      if (e.kind !== 'notfound') throw e;
      cfg.gistId = await findGist() || await createGist(bridge().export());   // 云端文件被删了：重新找或重建
      saveCfg();
      remote = await readGist(cfg.gistId);
    }
    st = bridge().export();                         // 网络等待期间用户可能又改了，取最新的再合并
    const merged = merge(st, remote);
    if (sig(merged) !== sig(st)) {
      if (!bridge().apply(merged)) throw new ApiError('busy');
    }
    if (sig(merged) !== sig(remote)) {
      await api('/gists/' + cfg.gistId, { method: 'PATCH', body: { files: filesOf(merged) } });
    }
  }

  async function sync() {
    if (!cfg.token || !bridge()) return;
    if (running) { again = true; return; }
    if (bridge().isPlaying()) { schedule(4000); return; }   // 播放时不打断，停下后再同步
    running = true;
    clearTimeout(retryTimer);
    setState('syncing');
    try {
      await runOnce();
      cfg.last = Date.now(); saveCfg();
      backoff = 0;
      setState('ok');
    } catch (e) {
      if (e.kind === 'auth') { setState('auth'); }
      else if (e.kind === 'limit') { setState('error', '请求太频繁，稍后自动重试'); retry(10 * 60 * 1000); }
      else if (e.kind === 'busy') { setState('error', '正在播放，稍后同步'); retry(5000); }
      else if (e.kind === 'network') { setState('error', '网络不通，恢复后自动重试'); retry(backoff = Math.min(300000, (backoff || 15000) * 2)); }
      else { setState('error', '同步失败（' + (e.status || '未知') + '），稍后重试'); retry(backoff = Math.min(300000, (backoff || 15000) * 2)); }
    } finally {
      running = false;
    }
    if (again) { again = false; schedule(800); }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => sync(), ms); }
  function retry(ms) { clearTimeout(retryTimer); retryTimer = setTimeout(() => sync(), ms); }

  // ---------- 界面 ----------
  function fmt(t) {
    if (!t) return '';
    const d = new Date(t), p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function setState(next, text) {
    state = next; msg = text || '';
    render();
  }
  function render() {
    const on = !!cfg.token;
    if (!$('cloudOn')) return;
    $('cloudOn').hidden = !on;
    $('cloudOff').hidden = on;
    const label = !on ? '未开启'
      : state === 'syncing' ? '同步中…'
        : state === 'auth' ? '令牌失效'
          : state === 'error' ? '未同步'
            : '已同步';
    $('cloudState').textContent = label;
    $('cloudState').dataset.state = on ? state : 'off';
    let line = '';
    if (state === 'auth') line = 'GitHub 不认这个令牌（可能过期或被删）。点“更换令牌”重新填一个。';
    else if (state === 'error') line = msg;
    else if (on && cfg.last) line = '上次同步：' + fmt(cfg.last);
    $('cloudMsg').textContent = line;
  }
  const say = (t) => { if ($('cloudMsg')) $('cloudMsg').textContent = t; };

  function wire() {
    if (!$('cloudOff')) return;
    $('cloudToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('cloudEnable').click(); });
    $('cloudEnable').addEventListener('click', async () => {
      const token = $('cloudToken').value.trim();
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) { say('令牌格式不对：应是 ghp_ 或 github_pat_ 开头的一长串字符'); return; }
      cfg = { token, gistId: '', last: 0 };
      verified = false;
      $('cloudToken').value = '';
      saveCfg();
      render();
      await sync();
    });
    $('cloudNow').addEventListener('click', () => { verified = false; sync(); });
    $('cloudChange').addEventListener('click', () => {
      cfg.token = ''; saveCfg(); state = 'off'; render();       // 保留 gistId，换新令牌后仍接回同一份数据
      $('cloudToken').focus();
    });
    $('cloudOff2').addEventListener('click', () => {
      cfg = { token: '', gistId: '', last: 0 }; saveCfg(); state = 'off'; render();
    });
  }

  // ---------- 触发时机 ----------
  const b = bridge();
  if (b) b.changed = () => { if (cfg.token) schedule(2500); };      // 改完停 2.5 秒再同步，不逐次打接口
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cfg.token) schedule(500); });
  window.addEventListener('online', () => { if (cfg.token) schedule(500); });
  setInterval(() => { if (cfg.token && !document.hidden && !running) sync(); }, 120000);   // 开着不动时也定期拉取别的设备的改动

  // 给曲谱页的“云端谱库”用：同一个令牌、另一个秘密 Gist；令牌本身不交出去
  window.CloudApi = {
    hasToken: () => !!cfg.token,
    call: api,
    songsGist: () => cfg.songsGist || '',
    setSongsGist: (id) => { cfg.songsGist = id; saveCfg(); }
  };

  wire();
  render();
  if (cfg.token) schedule(1200);
})();
