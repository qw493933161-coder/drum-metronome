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
  const stampOf = (side, k) => side && side.at && Number.isFinite(side.at[k]) && side.at[k] >= 0 ? side.at[k] : 0;
  const created = (id) => parseInt(String(id).slice(0, 8), 36) || 0;
  function normalize(side) {
    side = side && typeof side === 'object' ? side : {};
    return {
      v: side.v && typeof side.v === 'object' && !Array.isArray(side.v) ? side.v : {},
      at: side.at && typeof side.at === 'object' && !Array.isArray(side.at) ? side.at : {},
      mine: (Array.isArray(side.mine) ? side.mine : []).filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.seq))
        .map((m) => ({ ...m, updated: Number.isFinite(m.updated) && m.updated > 0 ? m.updated : 1 })),
      gone: (Array.isArray(side.gone) ? side.gone : []).filter((g) => g && typeof g.id === 'string' && Number.isFinite(g.at) && g.at >= 0)
    };
  }
  const rank = (value) => value === undefined ? '~' : JSON.stringify(canon(value));

  function mergeFields(group, L, R, v, at) {
    const fields = window.SyncBridge && window.SyncBridge.fields;
    if (!fields) return false; // 旧版主脚本仍可按原有整组方式合并
    const le = fields.entries(group, L.v[group]), re = fields.entries(group, R.v[group]);
    const keys = new Set([...Object.keys(le), ...Object.keys(re)]), prefix = '@' + group + '/';
    [L, R].forEach((side) => Object.keys(side.at).forEach((k) => {
      if (k.startsWith(prefix)) { try { keys.add(decodeURIComponent(k.slice(prefix.length))); } catch (e) { /* 忽略坏字段 */ } }
    }));
    const result = Object.create(null);
    keys.forEach((key) => {
      const stamp = fields.stampKey(group, key);
      const time = (side, entries) => Number.isFinite(side.at[stamp]) ? stampOf(side, stamp)
        : Object.hasOwn(entries, key) ? stampOf(side, group) : -1;
      const lt = time(L, le), rt = time(R, re);
      const winner = rt > lt || (rt === lt && rank(re[key]) > rank(le[key])) ? re : le;
      if (Object.hasOwn(winner, key)) result[key] = winner[key];
      if (Math.max(lt, rt) >= 0) at[stamp] = Math.max(lt, rt);
    });
    if (group === 'tempos') v[group] = result;
    else {
      const speeds = Object.create(null), prefs = {};
      Object.keys(result).forEach((k) => { if (k.startsWith('speed:')) speeds[k.slice(6)] = result[k]; else prefs[k] = result[k]; });
      v[group] = { ...prefs, speeds };
    }
    at[group] = Math.max(stampOf(L, group), stampOf(R, group));
    return true;
  }

  function merge(L, R, now = Date.now()) {
    L = normalize(L); R = normalize(R);
    const v = {}, at = {}, done = new Set();
    const keys = Object.keys(L.v || {});      // 以本机认识的项为准，云端多出来的旧项直接丢弃
    keys.forEach((k) => {
      if (done.has(k)) return;
      if ((k === 'tempos' || k === 'songPref') && mergeFields(k, L, R, v, at)) { done.add(k); return; }
      const group = GROUPS.find((g) => g.includes(k)) || [k];
      const has = (side) => group.every((g) => side.v && g in side.v);
      const top = (side) => Math.max(0, ...group.map((g) => stampOf(side, g)));
      let win;
      if (!has(R)) win = L;
      else if (!has(L)) win = R;
      else win = top(R) > top(L) || (top(R) === top(L) && rank(group.map((g) => R.v[g])) > rank(group.map((g) => L.v[g]))) ? R : L;
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
      if (!cur || m.updated > cur.updated || (m.updated === cur.updated && rank(m) > rank(cur))) best.set(m.id, m);
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
      const o = Object.create(null);
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

  window.SyncCore = { merge, sig, normalize };

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
      try { const response = await fetch(f.raw_url, { cache: 'no-store' }); if (!response.ok) throw new Error('download'); text = await response.text(); } catch (e) { throw new ApiError('network'); }
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.v || typeof data.v !== 'object') throw new ApiError('invalid');
    return normalize(data);
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
    // 设置标题旁边也显示同步状态，不用展开就知道有没有同步上
    const chip = $('syncChip');
    if (chip) { chip.textContent = on ? '· ' + label : '· 云同步未开启'; chip.dataset.state = on ? state : 'off'; }
  }
  const say = (t) => { if ($('cloudMsg')) $('cloudMsg').textContent = t; };

  function wire() {
    if (!$('cloudOff')) return;
    $('cloudToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('cloudEnable').click(); });
    $('cloudEnable').addEventListener('click', async () => {
      const token = $('cloudToken').value.trim();
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) { say('令牌格式不对：应是 ghp_ 或 github_pat_ 开头的一长串字符'); return; }
      cfg = { token, gistId: '', songsGist: '', last: 0 };
      verified = false;
      $('cloudToken').value = '';
      saveCfg();
      render();
      await sync();
    });
    $('cloudNow').addEventListener('click', () => { verified = false; sync(); });
    $('pairShow').addEventListener('click', showPairCode);
    $('pairScan').addEventListener('click', scanPairCode);
    $('pairClose').addEventListener('click', closePair);
    $('cloudChange').addEventListener('click', () => {
      cfg.token = ''; saveCfg(); state = 'off'; render();       // 保留 gistId，换新令牌后仍接回同一份数据
      $('cloudToken').focus();
    });
    $('cloudOff2').addEventListener('click', () => {
      cfg = { token: '', gistId: '', songsGist: '', last: 0 }; saveCfg(); state = 'off'; render();
    });
  }

  // ---------- 扫码配对：已开启的设备显示二维码，新设备用摄像头扫一下就接入同一份同步数据 ----------
  // 二维码里是令牌和两个 Gist 的编号，只在屏幕上显示、不上传、不写日志；两分钟后自动关掉。
  const PAIR_PREFIX = 'DRUMSYNC1:';
  let pairTimer = null, pairStream = null, pairLoop = null;
  const pairEl = (id) => $(id);
  function openPair(title, tip) {
    pairEl('pairTitle').textContent = title;
    pairEl('pairTip').textContent = tip;
    pairEl('pair').hidden = false;
  }
  function closePair() {
    clearTimeout(pairTimer);
    clearInterval(pairLoop); pairLoop = null;
    if (pairStream) { pairStream.getTracks().forEach((t) => t.stop()); pairStream = null; }
    const v = pairEl('pairVideo'); v.srcObject = null; v.hidden = true;
    const cv = pairEl('pairQr'); cv.hidden = true; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    pairEl('pair').hidden = true;
  }
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'vendor/qrcode/qrcode.js';
      el.onload = resolve; el.onerror = reject;
      document.head.appendChild(el);
    });
  }
  async function showPairCode() {
    if (!cfg.token) return;
    if (!cfg.gistId) { await sync(); }                 // 先确保云端已经建好，扫码的设备才能直接接上
    try { await loadQrLib(); } catch (e) { say('二维码组件没加载出来，检查网络后重试'); return; }
    const payload = PAIR_PREFIX + btoa(JSON.stringify({ t: cfg.token, g: cfg.gistId || '', s: cfg.songsGist || '' }));
    const qr = window.qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    const n = qr.getModuleCount(), quiet = 4, px = Math.max(3, Math.floor(520 / (n + quiet * 2)));
    const cv = pairEl('pairQr');
    cv.width = cv.height = (n + quiet * 2) * px;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) g.fillRect((col + quiet) * px, (r + quiet) * px, px, px);
    cv.hidden = false;
    openPair('用另一台设备扫这个码', '在另一台设备上打开 App → 设置 → 云同步 → “扫码加入同步”。这个码能读写你的同步数据，只给自己的设备扫，别拍照发给别人。两分钟后自动关闭。');
    clearTimeout(pairTimer);
    pairTimer = setTimeout(closePair, 120000);
  }
  function parsePair(text) {
    if (typeof text !== 'string' || !text.startsWith(PAIR_PREFIX)) return null;
    try {
      const o = JSON.parse(atob(text.slice(PAIR_PREFIX.length)));
      const idOk = (x) => x === '' || /^[0-9a-f]{8,64}$/i.test(x);
      if (!/^[A-Za-z0-9_]{20,255}$/.test(o.t) || !idOk(o.g || '') || !idOk(o.s || '')) return null;
      return { token: o.t, gistId: o.g || '', songsGist: o.s || '' };
    } catch (e) { return null; }
  }
  async function scanPairCode() {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say('这个浏览器不支持在 App 里扫码。请用 Chrome 打开，或者用下面粘贴令牌的方式。');
      return;
    }
    let detector;
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { say('这个浏览器不支持扫二维码，请用粘贴令牌的方式。'); return; }
    openPair('对准另一台设备上的二维码', '在已经开了同步的设备上：设置 → 云同步 → “添加设备”。');
    try {
      pairStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) {
      closePair();
      say('没能打开摄像头。请在浏览器里允许这个网站使用摄像头，再点一次“扫码加入同步”。');
      return;
    }
    const v = pairEl('pairVideo');
    v.srcObject = pairStream; v.hidden = false;
    try { await v.play(); } catch (e) { /* 部分浏览器需要再点一下，下面的检测照样进行 */ }
    let busy = false;
    pairLoop = setInterval(async () => {
      if (busy || v.readyState < 2) return;
      busy = true;
      try {
        const codes = await detector.detect(v);
        for (const code of codes) {
          const p = parsePair(code.rawValue);
          if (p) {
            closePair();
            cfg = { token: p.token, gistId: p.gistId, songsGist: p.songsGist, last: 0 };
            verified = false;
            saveCfg();
            render();
            say('已加入同步，正在拉取另一台设备的内容…');
            await sync();
            if (window.SongUI && window.SongUI.cloudNow) window.SongUI.cloudNow();
            return;
          }
          if (code.rawValue) pairEl('pairTip').textContent = '扫到的不是本 App 的配对码，请对准“添加设备”显示的二维码。';
        }
      } catch (e) { /* 单帧识别失败不要紧，继续扫 */ }
      busy = false;
    }, 250);
    clearTimeout(pairTimer);
    pairTimer = setTimeout(() => { closePair(); say('扫码超时，再点一次“扫码加入同步”。'); }, 120000);
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
