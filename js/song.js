// 曲谱页：用 alphaTab（MPL-2.0，见 vendor/alphatab/）打开 Guitar Pro / MusicXML 谱，
// 渲染成谱面并在播放时高亮跟随。谱文件只存在本机 IndexedDB，不进云同步、不上传。
// 只在第一次进入“曲谱”页时才加载 alphaTab（约 1 MB），不拖慢其它页面。
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PREF_KEY = 'metronome-song-v1';
  const BASE = new URL('vendor/alphatab/', location.href).href;
  const SPEEDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25];

  let pref = { last: '', speed: 1, scale: 1, click: false, drums: true, band: true, loop: false };
  try { Object.assign(pref, JSON.parse(localStorage.getItem(PREF_KEY)) || {}); } catch (e) { /* ignore */ }
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
      display: { layoutMode: window.alphaTab.LayoutMode.Page, scale: pref.scale },
      player: { enablePlayer: true, soundFont: BASE + 'soundfont/sonivox.sf2', scrollElement: $('songScroll'), enableCursor: true }
    });
    api.scoreLoaded.on((sc) => { score = sc; onScore(); });
    api.renderFinished.on(() => { $('songScroll').classList.remove('busy'); });
    api.playerReady.on(() => { readyPlay = true; applyPlayerPrefs(); say(''); refreshPlay(); });
    api.playerStateChanged.on((e) => { playingNow = e.state === 1; refreshPlay(); });
    api.error.on((e) => { say('打开失败：这个文件可能不是有效的乐谱，或格式暂不支持'); void e; $('songScroll').classList.remove('busy'); });
    readyPlay = false;
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
    $('songTrackRow').hidden = tracks.length < 2;
    $('songDesc').textContent = [score.artist, score.tempo ? `${score.tempo} BPM` : ''].filter(Boolean).join(' · ') +
      (drum < 0 ? '（没找到鼓轨，显示的是第一个声部）' : '');
    api.renderTracks([tracks[shown]]);
    applyPlayerPrefs();
  }

  function applyPlayerPrefs() {
    if (!api) return;
    api.playbackSpeed = pref.speed;
    api.isLooping = pref.loop;
    api.metronomeVolume = pref.click ? 1 : 0;
    // 开了倒计时就用一小节的预备拍，跟着谱的速度
    api.countInVolume = (window.SongBridge && window.SongBridge.countIn()) ? 1 : 0;
    if (score) {
      const drums = score.tracks.filter(isDrumTrack), others = score.tracks.filter((t) => !isDrumTrack(t));
      if (drums.length) api.changeTrackMute(drums, !pref.drums);
      if (others.length) api.changeTrackMute(others, !pref.band);
    }
  }

  function refreshPlay() {
    if (!window.SongBridge || window.SongBridge.mode() !== 'song') return;
    const b = $('play');
    b.textContent = playingNow ? '■ 停止' : (readyPlay || !score ? '▶ 开始' : '音色加载中…');
    b.classList.toggle('running', playingNow);
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
    curId = rec.id;
    pref.last = rec.id; savePref();
    $('songTitle').textContent = rec.name;
    $('songDesc').textContent = '';
    $('songBody').hidden = false;
    $('songScroll').classList.add('busy');
    $('songScroll').scrollTop = 0;
    readyPlay = !!api.isReadyForPlayback;
    try { api.load(new Uint8Array(rec.data)); } catch (e) { say('打开失败：这个文件可能不是有效的乐谱'); $('songScroll').classList.remove('busy'); }
    say(readyPlay ? '' : '音色加载中，几秒后可以播放…');
    renderList();
    refreshPlay();
  }

  async function addFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { say('文件太大了（超过 20 MB）'); return; }
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || '未命名',
      data: await file.arrayBuffer(),
      added: Date.now()
    };
    await dbPut(rec);
    await openRecord(rec);
  }

  function stop() {
    if (api && playingNow) api.stop();
    playingNow = false;
  }

  // ---------- 界面事件 ----------
  function syncControls() {
    $('songSpeed').value = String(pref.speed);
    $('songLoop').checked = pref.loop;
    $('songClick').checked = pref.click;
    $('songDrums').checked = pref.drums;
    $('songBand').checked = pref.band;
    $('songScaleVal').textContent = Math.round(pref.scale * 100) + '%';
  }
  function wire() {
    SPEEDS.forEach((v) => {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = Math.round(v * 100) + '%';
      $('songSpeed').appendChild(o);
    });
    $('songFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      try { await addFile(f); } catch (err) { say('保存失败：浏览器存储空间可能不够'); }
    });
    $('songList').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        if (!window.confirm('从这台设备删除这份谱？')) return;
        await dbDel(del.dataset.del);
        if (curId === del.dataset.del) { stop(); curId = ''; $('songBody').hidden = true; $('songTitle').textContent = '曲谱'; }
        renderList();
        return;
      }
      const row = e.target.closest('.g-item');
      if (row) { const rec = await dbGet(row.dataset.id); if (rec) openRecord(rec); }
    });
    $('songSpeed').addEventListener('change', (e) => { pref.speed = Number(e.target.value); savePref(); if (api) api.playbackSpeed = pref.speed; });
    $('songLoop').addEventListener('change', (e) => { pref.loop = e.target.checked; savePref(); applyPlayerPrefs(); });
    $('songClick').addEventListener('change', (e) => { pref.click = e.target.checked; savePref(); applyPlayerPrefs(); });
    $('songDrums').addEventListener('change', (e) => { pref.drums = e.target.checked; savePref(); applyPlayerPrefs(); });
    $('songBand').addEventListener('change', (e) => { pref.band = e.target.checked; savePref(); applyPlayerPrefs(); });
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
      if (!curId && pref.last) { const rec = await dbGet(pref.last).catch(() => null); if (rec) openRecord(rec); }
      refreshPlay();
    },
    leave() { stop(); },
    async toggle() {
      if (!api || !score) { say('先选一份谱文件'); return; }
      if (!readyPlay) { say('音色还在加载，稍等几秒'); return; }
      applyPlayerPrefs();
      api.playPause();
    }
  };

  // 页面在后台时加载的话 alphaTab 会等到可见才排谱；回到前台时如果还没排出来就补排一次
  const rerender = () => { if (api && score && !$('songHost').querySelector('svg')) api.render(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rerender(); });
  window.SongUI.rerender = rerender;

  wire();
  syncControls();
  if (window.SongBridge && window.SongBridge.mode() === 'song') window.SongUI.enter();   // 上次停在曲谱页
})();
