// 曲谱页：用 alphaTab（MPL-2.0，见 vendor/alphatab/）打开 Guitar Pro / MusicXML 谱，
// 渲染成谱面并在播放时高亮跟随。谱文件存在本机 IndexedDB；开了云同步后，会同步到你自己账号下的另一个秘密 Gist（见下面“云端谱库”）。
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
      display: {
        layoutMode: window.alphaTab.LayoutMode.Page,
        scale: pref.scale,
        // 第二声部（比如底鼓）默认画成浅灰，和印刷的鼓谱不一样；这里改成黑色，小节号也调淡
        resources: { secondaryGlyphColor: 'rgb(0,0,0)', barNumberColor: 'rgb(90,90,90)', staffLineColor: 'rgb(110,110,110)' }
      },
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
  //   云端没有而本地标了 synced → 别的设备删了，本地也删；本地没标 synced → 还没上传，去上传；
  //   本地删除的记在 GONE_KEY 里，下次同步时从云端删掉。
  const SONG_DESC = 'drum-metronome-songs（练习谱文件，请勿删除）';
  const GONE_KEY = 'metronome-song-gone';
  const MAX_CLOUD = 700 * 1024;      // 单个谱超过这个大小不上传
  const readGone = () => { try { return JSON.parse(localStorage.getItem(GONE_KEY)) || []; } catch (e) { return []; } };
  const writeGone = (a) => { try { localStorage.setItem(GONE_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } };
  const toB64 = (buf) => { const u = new Uint8Array(buf); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); };
  const fromB64 = (t) => { const b = atob(t); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  let cloudBusy = false, cloudAgain = false;

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
    if (cloudBusy) { cloudAgain = true; return; }
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
        const remote = {};
        for (const [fn, f] of Object.entries(g.files || {})) {
          if (!/^s-.+[.]json$/.test(fn)) continue;
          try {
            const text = f.truncated && f.raw_url ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
            const o = JSON.parse(text);
            if (o && typeof o.id === 'string' && typeof o.data === 'string') remote[o.id] = o;
          } catch (e) { /* 坏文件跳过 */ }
        }
        const gone = readGone();
        const patch = {};
        let local = await dbAll();
        for (const r of local) {                                   // 别的设备删了 → 本机也删
          if (r.synced && !remote[r.id]) {
            await dbDel(r.id); removed++;
            if (curId === r.id) { stop(); curId = ''; $('songBody').hidden = true; $('songTitle').textContent = '曲谱'; }
          }
        }
        local = await dbAll();
        const uploaded = [];
        for (const r of local) {                                   // 本机新增 → 上传
          if (r.synced) continue;
          if (r.data.byteLength > MAX_CLOUD) { skipped++; continue; }
          patch['s-' + r.id + '.json'] = { content: JSON.stringify({ v: 1, id: r.id, name: r.name, added: r.added, data: toB64(r.data) }) };
          uploaded.push(r);
        }
        gone.forEach((id) => { if (remote[id]) patch['s-' + id + '.json'] = null; });   // 本机删了 → 云端也删
        if (Object.keys(patch).length) await A.call('/gists/' + gid, { method: 'PATCH', body: { files: patch } });
        for (const r of uploaded) await dbPut(Object.assign({}, r, { synced: true }));
        writeGone([]);
        const have = new Set(local.map((r) => r.id));
        for (const o of Object.values(remote)) {                   // 云端新增 → 下载
          if (have.has(o.id) || gone.includes(o.id)) continue;
          await dbPut({ id: o.id, name: String(o.name || '未命名').slice(0, 60), data: fromB64(o.data), added: Number(o.added) || Date.now(), synced: true });
          added++;
        }
        cloudSay('谱文件已同步' + (added ? '，新增 ' + added + ' 份' : '') + (removed ? '，移除 ' + removed + ' 份' : '') + (skipped ? '（' + skipped + ' 份太大没上传）' : ''));
        renderList();
      }
    } catch (e) {
      cloudSay(e && e.kind === 'auth' ? '令牌失效，请在设置里更换' : e && e.kind === 'network' ? '网络不通，谱文件暂未同步' : '谱文件同步失败，稍后再试');
    } finally {
      cloudBusy = false;
    }
    if (redo) { cloudSync(true); return; }
    if (cloudAgain) { cloudAgain = false; cloudSync(); }
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
      cloudSync();
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
