// 曲谱页：用 alphaTab（MPL-2.0，见 vendor/alphatab/）打开 Guitar Pro / MusicXML 谱，
// 渲染成谱面并在播放时高亮跟随。谱文件存在本机 IndexedDB；开了云同步后，会同步到你自己账号下的另一个秘密 Gist（见下面“云端谱库”）。
// 只在第一次进入“曲谱”页时才加载 alphaTab（约 1 MB），不拖慢其它页面。
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PREF_KEY = 'metronome-song-v1';
  const BASE = new URL('vendor/alphatab/', location.href).href;
  const SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25];

  let pref = { last: '', scale: 1 };
  // 要跨设备一致的偏好：每份谱各自的速度、节拍点击、鼓声、伴奏、循环
  const sp = () => (window.SongBridge && window.SongBridge.pref()) || { speeds: {}, click: false, drums: true, band: true, loop: false };
  const setSp = (p) => { if (window.SongBridge) window.SongBridge.setPref(p); };
  const curSpeed = () => (curId && sp().speeds[curId]) || 1;
  let oldPref = {};
  try { oldPref = JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { /* ignore */ }
  if (typeof oldPref.last === 'string') pref.last = oldPref.last;
  if (Number.isFinite(oldPref.scale)) pref.scale = oldPref.scale;
  const savePref = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (e) { /* ignore */ } };

  // ---------- 本机存谱（IndexedDB） ----------
  const DB = 'metronome-songs';
  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction('songs', mode);
      const r = fn(t.objectStore('songs'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  };
  const dbAll = () => tx('readonly', (st) => st.getAll());
  const dbGet = (id) => tx('readonly', (st) => st.get(id));
  const dbPut = (rec) => tx('readwrite', (st) => st.put(rec));
  const dbDel = (id) => tx('readwrite', (st) => st.delete(id));

  // ---------- alphaTab ----------
  let api = null, loading = null, score = null, curId = '', readyPlay = false, playingNow = false;
  let loadFailed = false;

  function loadLib() {
    if (window.alphaTab) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = BASE + 'alphaTab.min.js';
      el.onload = resolve;
      el.onerror = () => { loading = null; reject(new Error('lib')); };
      document.head.appendChild(el);
    });
    return loading;
  }

  const isDrumTrack = (t) => t.staves.some((st) => st.isPercussion);
  const say = (t) => { $('songMsg').textContent = t || ''; };

  function ensureApi() {
    if (api) return;
    api = new window.alphaTab.AlphaTabApi($('songHost'), {
      core: { scriptFile: BASE + 'alphaTab.min.js', fontDirectory: BASE + 'font/', useWorkers: true },
      display: {
        layoutMode: window.alphaTab.LayoutMode.Page,
        scale: pref.scale,
        // 第二声部（比如底鼓）默认画成浅灰，和印刷的鼓谱不一样；这里改成黑色，小节号也调淡
        resources: { secondaryGlyphColor: 'rgb(0,0,0)', barNumberColor: 'rgb(90,90,90)', staffLineColor: 'rgb(110,110,110)' }
      },
      player: { enablePlayer: true, soundFont: BASE + 'soundfont/sonivox.sf2', scrollElement: $('songScroll'), enableCursor: true }
    });
    api.scoreLoaded.on((sc) => { if (loadFailed) return; score = sc; onScore(); refreshPlay(); });
    api.renderFinished.on(() => { $('songScroll').classList.remove('busy'); });
    api.playerReady.on(() => { if (loadFailed) return; readyPlay = true; applyPlayerPrefs(); say(''); refreshPlay(); });
    api.playerStateChanged.on((e) => { playingNow = e.state === 1; if (!playingNow && window.KeepAlive) window.KeepAlive.off(); if (!playingNow && window.AppUpdate) setTimeout(window.AppUpdate.tryReload, 300); refreshPlay(); });
    api.error.on(() => failLoad());
    readyPlay = false;
  }

  function failLoad() {
    stop();
    loadFailed = true;
    score = null;
    readyPlay = false;
    $('songBody').hidden = true; // 旧谱不能以新文件的标题继续显示或播放
    $('songScroll').classList.remove('busy');
    say('打开失败：这个文件可能不是有效的乐谱，或格式暂不支持，请重新选择谱文件');
    refreshPlay();
  }

  function onScore() {
    if (!score) return;
    const tracks = score.tracks;
    const drum = tracks.findIndex(isDrumTrack);
    const shown = drum >= 0 ? drum : 0;
    const sel = $('songTrack');
    sel.innerHTML = '';
    tracks.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = (isDrumTrack(t) ? '鼓：' : '') + (t.name || `声部 ${i + 1}`);
      sel.appendChild(o);
    });
    sel.value = String(shown);
    const bars = score.masterBars.length;
    $('loopFrom').max = $('loopTo').max = String(bars);
    $('loopFrom').value = '1';
    $('loopTo').value = String(Math.min(bars, 4));
    $('songTrackRow').hidden = tracks.length < 2;
    $('songDesc').textContent = [score.artist, score.tempo ? `${score.tempo} BPM` : ''].filter(Boolean).join(' · ') +
      (drum < 0 ? '（没找到鼓轨，显示的是第一个声部）' : '');
    api.renderTracks([tracks[shown]]);
    applyPlayerPrefs();
  }

  function applyPlayerPrefs() {
    if (!api) return;
    const p = sp();
    const vol = (window.SongBridge && window.SongBridge.volumes()) || { click: 1, drum: 1 };
    api.playbackSpeed = curSpeed();
    api.isLooping = p.loop || !!loopRange;
    api.masterVolume = vol.drum;
    api.metronomeVolume = p.click ? vol.click : 0;
    // 开了倒计时就用一小节的预备拍，跟着谱的速度
    api.countInVolume = (window.SongBridge && window.SongBridge.countIn()) ? vol.click : 0;
    // 声画校准往右调（延后）时，谱面光标和高亮也跟着延后
    const d = window.SongBridge ? window.SongBridge.avDelayMs() : 0;
    document.documentElement.style.setProperty('--song-av-delay', d + 'ms');
    if (score) {
      const drums = score.tracks.filter(isDrumTrack), others = score.tracks.filter((t) => !isDrumTrack(t));
      if (drums.length) api.changeTrackMute(drums, !p.drums);
      if (others.length) api.changeTrackMute(others, !p.band);
    }
  }

  function refreshPlay() {
    if (!window.SongBridge || window.SongBridge.mode() !== 'song') return;
    const label = playingNow ? '■ 停止' : (readyPlay || !score ? '▶ 开始' : '音色加载中…');
    ['play', 'songFullPlay'].forEach((id) => { const b = $(id); b.textContent = label; b.classList.toggle('running', playingNow); });
  }

  // ---------- 曲谱列表 ----------
  async function renderList() {
    const list = await dbAll().catch(() => []);
    const host = $('songList');
    host.innerHTML = '';
    if (!list.length) { host.innerHTML = '<div class="mine-empty">还没有打开过谱</div>'; return; }
    list.sort((a, b) => b.added - a.added).forEach((r) => {
      const row = document.createElement('div');
      row.className = 'g-item mine' + (r.id === curId ? ' active' : '');
      row.dataset.id = r.id;
      const nm = document.createElement('span');
      nm.className = 'g-name';
      nm.textContent = r.name;
      const btns = document.createElement('span');
      btns.className = 'mine-btns';
      const del = document.createElement('button');
      del.className = 'mine-del';
      del.dataset.del = r.id;
      del.setAttribute('aria-label', '删除');
      del.textContent = '✕';
      btns.appendChild(del);
      row.append(nm, btns);
      host.appendChild(row);
    });
  }

  async function openRecord(rec) {
    say('正在加载…');
    try { await loadLib(); } catch (e) { say('播放器组件没加载出来，检查一下网络后重试'); return; }
    ensureApi();
    stop();
    loadFailed = false;
    score = null;
    curId = rec.id;
    pref.last = rec.id; savePref();
    $('songTitle').textContent = rec.name;
    $('songFullTitle').textContent = rec.name;
    loopRange = null;
    syncControls();
    $('songDesc').textContent = '';
    $('songBody').hidden = false;
    $('songScroll').classList.add('busy');
    $('songScroll').scrollTop = 0;
    readyPlay = !!api.isReadyForPlayback;
    say(readyPlay ? '' : '音色加载中，几秒后可以播放…');
    try { if (api.load(new Uint8Array(rec.data)) === false) failLoad(); } catch (e) { failLoad(); }
    renderList();
    refreshPlay();
  }

  async function addFile(file) {
    if (!file) return;
    if (!/[.](gp|gp3|gp4|gp5|gpx|musicxml|xml|mxl|atex|alphatex)$/i.test(file.name)) { say('这不是谱文件：请选 .gp / .gp5 / .gpx / .musicxml 结尾的文件'); return; }
    if (file.size > 20 * 1024 * 1024) { say('文件太大了（超过 20 MB）'); return; }
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || '未命名',
      data: await file.arrayBuffer(),
      added: Date.now()
    };
    await dbPut(rec);
    await openRecord(rec);
    cloudSync();
  }

  function stop() {
    if (api && playingNow) api.stop();
    playingNow = false;
  }

  // ---------- 云端谱库：谱文件放在你自己账号下的另一个秘密 Gist，多台设备共用 ----------
  // 每个谱一个文件 s-<id>.json（内含 base64）。本地记录带 synced 标记：
  //   同一个已确认的 syncedGist 中明确缺少文件 → 别的设备删了；换库或旧记录缺少来源时优先保留本机。
  //   本地删除的记在 GONE_KEY 里，下次同步时从云端删掉。
  const SONG_DESC = 'drum-metronome-songs（练习谱文件，请勿删除）';
  const GONE_KEY = 'metronome-song-gone';
  const MAX_CLOUD = 700 * 1024;      // 单个谱超过这个大小不上传
  const readGone = () => { try { const a = JSON.parse(localStorage.getItem(GONE_KEY)); return Array.isArray(a) ? a.filter((id) => typeof id === 'string') : []; } catch (e) { return []; } };
  const writeGone = (a) => { try { localStorage.setItem(GONE_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } };
  const toB64 = (buf) => { const u = new Uint8Array(buf); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); };
  const fromB64 = (t) => { const b = atob(t); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  let cloudBusy = false, cloudAgain = false;
  let cloudRetry = null;
  const playbackBusy = () => playingNow || !!(window.SyncBridge && window.SyncBridge.isPlaying());
  function requireIdle() { if (playbackBusy()) throw new Error('playing'); }
  function retryWhenIdle() { clearTimeout(cloudRetry); cloudRetry = setTimeout(() => cloudSync(), 4000); }

  const cloudOn = () => !!(window.CloudApi && window.CloudApi.hasToken());
  function cloudSay(t) { const el = $('songCloud'); if (el) el.textContent = t; }

  async function findSongsGist() {
    for (let page = 1; page <= 10; page++) {
      const list = await window.CloudApi.call('/gists?per_page=100&page=' + page);
      const hit = list.filter((g) => g.description === SONG_DESC).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    return '';
  }
  async function cloudSync(retried) {
    if (!cloudOn()) { cloudSay('开启设置里的“云同步”后，谱文件也能在多台设备间共用。'); return; }
    if (playbackBusy()) { cloudSay('播放结束后同步谱文件'); retryWhenIdle(); return; }
    if (cloudBusy) { cloudAgain = true; return; }
    clearTimeout(cloudRetry);
    cloudBusy = true;
    cloudSay('谱文件同步中…');
    let added = 0, removed = 0, skipped = 0, redo = false;
    try {
      const A = window.CloudApi;
      let gid = A.songsGist();
      if (!gid) {
        gid = await findSongsGist();
        if (!gid) gid = (await A.call('/gists', { method: 'POST', body: { description: SONG_DESC, public: false, files: { '_readme.txt': { content: '鼓手节拍器的谱文件同步库，请勿删除。' } } } })).id;
        A.setSongsGist(gid);
      }
      let g;
      try { g = await A.call('/gists/' + gid); }
      catch (e) { if (e.kind === 'notfound' && !retried) { A.setSongsGist(''); redo = true; } else throw e; }
      if (!redo) {
        if (!g.files || typeof g.files !== 'object' || g.truncated) throw new Error('incomplete');
        const remote = Object.create(null);
        // 内容损坏的云端文件：按文件名记下编号，当作“云端还在”（不删本机），也不下载；
        // 本机若有完好副本，下面的上传步骤会自动把它覆盖修好。下载失败则整轮取消，下次再试。
        const broken = new Set();
        for (const [fn, f] of Object.entries(g.files || {})) {
          const m = /^s-(.+)[.]json$/.exec(fn);
          if (!m) continue;
          requireIdle();
          let text = f.content;
          if (f.truncated) {
            if (!f.raw_url) throw new Error('incomplete');
            const response = await fetch(f.raw_url, { cache: 'no-store' });
            if (!response.ok) throw new Error('download');
            text = await response.text();
          }
          try {
            const o = JSON.parse(text);
            if (!o || typeof o.id !== 'string' || fn !== 's-' + o.id + '.json' || typeof o.data !== 'string' ||
              o.data.length > Math.ceil(MAX_CLOUD / 3) * 4) throw new Error('invalid');
            o.buffer = fromB64(o.data);
            if (o.buffer.byteLength > MAX_CLOUD) throw new Error('invalid');
            remote[o.id] = o;
          } catch (e) { broken.add(m[1]); }
        }
        const gone = readGone();
        const patch = {};
        let local = await dbAll();
        requireIdle();
        for (const r of local) {                                   // 别的设备删了 → 本机也删
          requireIdle();
          if (r.synced && r.syncedGist === gid && !remote[r.id] && !broken.has(r.id)) {
            await dbDel(r.id); removed++;
            if (curId === r.id) { stop(); curId = ''; $('songBody').hidden = true; $('songTitle').textContent = '曲谱'; }
          }
        }
        local = await dbAll();
        const uploaded = [];
        for (const r of local) {                                   // 本机新增 → 上传
          requireIdle();
          if (remote[r.id]) {
            if (r.syncedGist !== gid) await dbPut(Object.assign({}, r, { synced: true, syncedGist: gid }));
            continue;
          }
          if (r.data.byteLength > MAX_CLOUD) { skipped++; continue; }
          patch['s-' + r.id + '.json'] = { content: JSON.stringify({ v: 1, id: r.id, name: r.name, added: r.added, data: toB64(r.data) }) };
          uploaded.push(r);
        }
        gone.forEach((id) => { if (remote[id] || broken.has(id)) patch['s-' + id + '.json'] = null; });   // 本机删了 → 云端也删
        requireIdle();
        if (Object.keys(patch).length) await A.call('/gists/' + gid, { method: 'PATCH', body: { files: patch } });
        for (const r of uploaded) {
          requireIdle();
          const current = await dbGet(r.id);
          if (current) await dbPut(Object.assign({}, current, { synced: true, syncedGist: gid }));
          else { writeGone([...new Set(readGone().concat(r.id))]); cloudAgain = true; }
        }
        // 网络等待期间可能又删了谱，只清除这一轮已经处理过的删除记录。
        writeGone(readGone().filter((id) => !gone.includes(id)));
        const have = new Set(local.map((r) => r.id));
        for (const o of Object.values(remote)) {                   // 云端新增 → 下载
          requireIdle();
          if (have.has(o.id) || gone.includes(o.id) || readGone().includes(o.id)) continue;
          await dbPut({ id: o.id, name: String(o.name || '未命名').slice(0, 60), data: o.buffer, added: Number(o.added) || Date.now(), synced: true, syncedGist: gid });
          added++;
        }
        const repaired = [...broken].filter((id) => uploaded.some((r) => r.id === id)).length;
        const lost = broken.size - repaired - gone.filter((id) => broken.has(id)).length;
        cloudSay('谱文件已同步' + (added ? '，新增 ' + added + ' 份' : '') + (removed ? '，移除 ' + removed + ' 份' : '') + (skipped ? '（' + skipped + ' 份太大没上传）' : '') +
          (repaired ? '，修复了 ' + repaired + ' 份损坏的云端谱' : '') + (lost > 0 ? '；云端有 ' + lost + ' 份谱已损坏，已跳过' : ''));
        renderList();
      }
    } catch (e) {
      if (e.message === 'playing') { cloudSay('播放结束后同步谱文件'); retryWhenIdle(); }
      else cloudSay(e && e.kind === 'auth' ? '令牌失效，请在设置里更换' : e && e.kind === 'network' ? '网络不通，谱文件暂未同步' : '谱文件未能完整读取或同步，本机曲谱已保留，请稍后再试');
    } finally {
      cloudBusy = false;
    }
    if (redo) { cloudSync(true); return; }
    if (cloudAgain) { cloudAgain = false; cloudSync(); }
  }

  // ---------- 界面事件 ----------
  function syncControls() {
    const p = sp();
    const v = String(curSpeed());
    $('songSpeed').value = v;
    $('songSpeed2').value = v;
    $('songLoop').checked = p.loop || !!loopRange;
    $('songClick').checked = p.click;
    $('songDrums').checked = p.drums;
    $('songBand').checked = p.band;
    $('songScaleVal').textContent = Math.round(pref.scale * 100) + '%';
  }

  // ---------- 按小节号循环 ----------
  let loopRange = null;
  function setLoop() {
    if (!api || !score) return;
    const n = score.masterBars.length;
    let a = Math.round(Number($('loopFrom').value)) || 1, b = Math.round(Number($('loopTo').value)) || a;
    a = Math.max(1, Math.min(n, a)); b = Math.max(a, Math.min(n, b));
    $('loopFrom').value = String(a); $('loopTo').value = String(b);
    const mb = score.masterBars;
    const startTick = mb[a - 1].start, endTick = mb[b - 1].start + mb[b - 1].calculateDuration();
    loopRange = { startTick, endTick };
    api.playbackRange = loopRange;
    api.isLooping = true;
    try {
      const track = score.tracks[Number($('songTrack').value) || 0];
      const bars = track.staves[0].bars;
      const first = bars[a - 1].voices[0].beats[0];
      const lastBeats = bars[b - 1].voices[0].beats;
      api.highlightPlaybackRange(first, lastBeats[lastBeats.length - 1]);
    } catch (e) { /* 只是画选区，失败不影响循环 */ }
    api.tickPosition = startTick;
    syncControls();
    say('循环第 ' + a + (b > a ? ' 到 ' + b : '') + ' 小节，点“取消”恢复整首');
  }
  function clearLoop() {
    loopRange = null;
    if (api) {
      api.playbackRange = null;
      try { api.clearPlaybackRangeHighlight(); } catch (e) { /* ignore */ }
      applyPlayerPrefs();
    }
    syncControls();
    say('');
  }

  // ---------- 全屏看谱 ----------
  function enterFull() {
    if (!curId) { say('先选一份谱文件'); return; }
    document.body.classList.add('song-full');
    relayout();
  }
  function exitFull() {
    if (!document.body.classList.contains('song-full')) return;
    document.body.classList.remove('song-full');
    if (window.AppOrient) window.AppOrient.release();
    relayout();
  }
  // 谱面宽度变了要重新排版（alphaTab 只在窗口变化时自己排）
  let relayoutTimer = null;
  function relayout() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => { if (api && score) api.render(); }, 250);
  }
  window.addEventListener('resize', () => { if (document.body.classList.contains('song-full')) relayout(); });

  const setSpeed = (v) => {
    if (curId) setSp({ speeds: Object.assign({}, sp().speeds, { [curId]: v }) });
    if (api) api.playbackSpeed = v;
    syncControls();
  };
  function wire() {
    ['songSpeed', 'songSpeed2'].forEach((id) => SPEEDS.forEach((v) => {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = Math.round(v * 100) + '%';
      $(id).appendChild(o);
    }));
    $('songFull').addEventListener('click', enterFull);
    $('songRot').addEventListener('click', () => { enterFull(); if (curId && window.AppOrient) window.AppOrient.lock(); });
    $('songFullRot').addEventListener('click', () => { if (window.AppOrient) window.AppOrient.toggle(); });
    $('songFullExit').addEventListener('click', exitFull);
    $('songFullPlay').addEventListener('click', () => window.SongUI.toggle());
    $('songSpeed2').addEventListener('change', (e) => setSpeed(Number(e.target.value)));
    $('loopSet').addEventListener('click', setLoop);
    $('loopClear').addEventListener('click', clearLoop);
    $('songFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      try { await addFile(f); } catch (err) { say('保存失败：浏览器存储空间可能不够'); }
    });
    $('songList').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        if (!(await window.AppDialog.confirm('删除这份谱？（开了云同步的话，其他设备上也会一起删除）', '删除'))) return;
        const old = await dbGet(del.dataset.del);
        await dbDel(del.dataset.del);
        if (old && old.synced) writeGone(readGone().concat([del.dataset.del]));
        if (curId === del.dataset.del) { stop(); curId = ''; $('songBody').hidden = true; $('songTitle').textContent = '曲谱'; }
        renderList();
        cloudSync();
        return;
      }
      const row = e.target.closest('.g-item');
      if (row) { const rec = await dbGet(row.dataset.id); if (rec) openRecord(rec); }
    });
    $('songCloudBtn').addEventListener('click', () => cloudSync());
    $('songSpeed').addEventListener('change', (e) => setSpeed(Number(e.target.value)));
    $('songLoop').addEventListener('change', (e) => {
      const loop = e.target.checked;
      setSp({ loop });
      if (!loop && loopRange) clearLoop();
      applyPlayerPrefs();
      syncControls();
    });
    $('songClick').addEventListener('change', (e) => { setSp({ click: e.target.checked }); applyPlayerPrefs(); });
    $('songDrums').addEventListener('change', (e) => { setSp({ drums: e.target.checked }); applyPlayerPrefs(); });
    $('songBand').addEventListener('change', (e) => { setSp({ band: e.target.checked }); applyPlayerPrefs(); });
    $('songTrack').addEventListener('change', (e) => { if (score && api) { stop(); api.renderTracks([score.tracks[Number(e.target.value)]]); } });
    document.querySelectorAll('[data-sscale]').forEach((b) => b.addEventListener('click', () => {
      pref.scale = Math.min(1.6, Math.max(0.6, Math.round((pref.scale + Number(b.dataset.sscale)) * 100) / 100));
      savePref(); syncControls();
      if (api) { api.settings.display.scale = pref.scale; api.updateSettings(); api.render(); }
    }));
  }

  // metronome.js 通过它控制曲谱页
  window.SongUI = {
    async enter() {
      syncControls();
      renderList();
      cloudSync();
      if (!curId && pref.last) { const rec = await dbGet(pref.last).catch(() => null); if (rec) openRecord(rec); }
      refreshPlay();
    },
    leave() { stop(); exitFull(); },
    prefsChanged() { syncControls(); applyPlayerPrefs(); },
    cloudNow() { lastCloud = Date.now(); cloudSync(); },
    playing: () => playingNow,
    async toggle() {
      if (loadFailed) { say('打开失败，请重新选择有效的谱文件'); return; }
      if (!api || !score) { say('先选一份谱文件'); return; }
      if (!readyPlay) { say('音色还在加载，稍等几秒'); return; }
      applyPlayerPrefs();
      if (!playingNow && window.KeepAlive) window.KeepAlive.on(`曲谱 · ${$('songTitle').textContent}`);   // 点击当下启动后台保活
      api.playPause();
    }
  };

  // 页面在后台时加载的话 alphaTab 会等到可见才排谱；回到前台时如果还没排出来就补排一次
  const rerender = () => { if (api && score && !$('songHost').querySelector('svg')) api.render(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rerender(); });
  window.SongUI.rerender = rerender;

  let lastCloud = 0;
  const cloudSoon = () => { if (cloudOn() && Date.now() - lastCloud > 60000) { lastCloud = Date.now(); cloudSync(); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cloudSoon(); });
  setTimeout(cloudSoon, 3000);

  wire();
  syncControls();
  if (window.SongBridge && window.SongBridge.mode() === 'song') window.SongUI.enter();   // 上次停在曲谱页
})();
