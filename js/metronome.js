(() => {
  const $ = (id) => document.getElementById(id);
  const LIMITS = { bpm: [20, 300], beats: [1, 16], subdiv: [1, 8] };
  const SUB_NAMES = {
    1: '无细分（四分）', 2: '八分音符', 3: '三连音', 4: '十六分音符',
    5: '五连音', 6: '六连音', 7: '七连音', 8: '三十二分音符'
  };
  const STORE_KEY = 'metronome-v2';

  // ---------- 节奏型目录：一拍切成 n 份后，哪几份发声（'1' 打 / '0' 不打）----------
  function catalog(n) {
    const zero = '0'.repeat(n);
    const c = (bits, name, short) => ({ bits, name, short: short || name });
    let list;
    if (n === 1) list = [c('1', '打', '打')];
    else if (n === 2) list = [c('11', '全打（八分）', '全打'), c('10', '只打正拍', '正拍'), c('01', '只打反拍', '反拍')];
    else if (n === 3) list = [
      c('111', '全打（三连音）', '全打'), c('101', '1 let：首尾（摇摆 / Shuffle）', '摇摆'),
      c('110', '1 trip：前两音', '前两音'), c('011', 'trip let：后两音', '后两音'),
      c('010', '只打中间音', '中间'), c('001', '只打末音', '末音'), c('100', '只打正拍', '正拍')
    ];
    else if (n === 4) list = [
      c('1111', '全打（十六分）', '全打'), c('1010', '1 &：八分音符', '八分'), c('1000', '只打正拍', '正拍'),
      c('1100', '1 e：十六分+附点八分', '1 e'), c('1001', '1 a：附点八分+十六分', '1 a'),
      c('1110', '1 e &：前十六后八', '前十六后八'), c('1011', '1 & a：前八后十六', '前八后十六'),
      c('1101', '1 e a：十六+八+十六', '1 e a'), c('0010', '&：只打反拍', '&'),
      c('0100', 'e：只打 e', 'e'), c('0001', 'a：只打 a', 'a'), c('0110', 'e &', 'e &'),
      c('0101', 'e a', 'e a'), c('0011', '& a：八分休止+两个十六分', '& a'), c('0111', 'e & a：十六分休止+三个十六分', 'e & a')
    ];
    else if (n === 6) list = [
      c('111111', '全打（六连音）', '全打'), c('101010', '三连音（隔一个打）', '三连音'),
      c('100100', '八分（1、4）', '八分'), c('100000', '只打正拍', '正拍')
    ];
    else if (n === 8) list = [
      c('11111111', '全打（三十二分）', '全打'), c('10101010', '十六分', '十六分'),
      c('10001000', '八分', '八分'), c('10000000', '只打正拍', '正拍')
    ];
    else list = [c('1'.repeat(n), '全打', '全打'), c('1' + '0'.repeat(n - 1), '只打正拍', '正拍')];
    list.push(c(zero, '休止（这一拍不打）', '休止'));
    return list;
  }

  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v)));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { /* ignore */ }
  const s = {
    bpm: clamp(saved.bpm || 100, LIMITS.bpm),
    beats: clamp(saved.beats || 4, LIMITS.beats),
    subdiv: clamp(saved.subdiv || 1, LIMITS.subdiv),
    ticks: saved.ticks !== false,
    cells: []
  };
  const zeros = () => '0'.repeat(s.subdiv);
  const validCell = (x) => typeof x === 'string' && x.length === s.subdiv && /^[01]+$/.test(x);
  s.cells = Array.from({ length: s.beats }, (_, i) => (saved.cells && validCell(saved.cells[i]) ? saved.cells[i] : zeros()));
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } };

  let ctx = null, out = null, schedTimer = null, drainTimer = null;
  let playing = false, nextTime = 0, pos = { beat: 0, sub: 0 }, queue = [];
  let blocks = [], dots = [], lit = null, wake = null, tapTimes = [];

  // ---------- audio: scheduled ahead on the AudioContext clock ----------
  const CLICK = [
    { type: 'sine', freq: 1600, gain: 0.9, dur: 0.05 },   // 0 bar downbeat (reference)
    { type: 'sine', freq: 1100, gain: 0.7, dur: 0.05 },   // 1 other beats (reference)
    { type: 'sine', freq: 1000, gain: 0.2, dur: 0.04 },   // 2 faint subdivision tick
    { type: 'triangle', freq: 520, gain: 0.85, dur: 0.09 } // 3 rhythm-pattern hit
  ];
  function tone(time, kind) {
    const c = CLICK[kind];
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = c.type;
    osc.frequency.value = c.freq;
    g.gain.setValueAtTime(c.gain, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + c.dur);
    osc.connect(g).connect(out);
    osc.start(time);
    osc.stop(time + c.dur + 0.02);
  }

  function schedule() {
    const horizon = ctx.currentTime + 0.12;
    while (nextTime < horizon) {
      if (pos.beat >= s.beats) pos.beat = 0;
      if (pos.sub >= s.subdiv) pos.sub = 0;
      if (pos.sub === 0) tone(nextTime, pos.beat === 0 ? 0 : 1);
      else if (s.ticks) tone(nextTime, 2);
      if (s.cells[pos.beat] && s.cells[pos.beat][pos.sub] === '1') tone(nextTime, 3);
      queue.push({ t: nextTime, beat: pos.beat, sub: pos.sub });
      nextTime += 60 / s.bpm / s.subdiv;
      if (++pos.sub >= s.subdiv) {
        pos.sub = 0;
        if (++pos.beat >= s.beats) pos.beat = 0;
      }
    }
  }

  // UI follows the audio clock via setInterval (rAF can stall when a tab isn't painting)
  function drain() {
    const now = ctx.currentTime;
    let due = null;
    while (queue.length && queue[0].t <= now) due = queue.shift();
    if (due) light(due.beat, due.sub);
  }

  function clearLit() {
    if (lit) {
      if (blocks[lit.beat]) blocks[lit.beat].classList.remove('on');
      if (dots[lit.beat] && dots[lit.beat][lit.sub]) dots[lit.beat][lit.sub].classList.remove('on');
    }
    lit = null;
  }
  function light(beat, sub) {
    clearLit();
    if (!blocks[beat]) return;
    blocks[beat].classList.add('on');
    if (dots[beat][sub]) dots[beat][sub].classList.add('on');
    lit = { beat, sub };
  }

  // ---------- transport ----------
  async function start() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    out = ctx.createGain();
    out.connect(ctx.destination);
    playing = true;
    pos = { beat: 0, sub: 0 };
    queue = [];
    nextTime = ctx.currentTime + 0.08;
    schedule();
    schedTimer = setInterval(schedule, 25);
    drainTimer = setInterval(drain, 15);
    acquireWake();
    renderPlay();
  }
  function stop() {
    playing = false;
    clearInterval(schedTimer);
    clearInterval(drainTimer);
    if (out) { out.disconnect(); out = null; }   // silences sounds already scheduled ahead
    queue = [];
    clearLit();
    releaseWake();
    renderPlay();
  }

  async function acquireWake() {
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
  }
  function releaseWake() {
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (playing && document.visibilityState === 'visible' && !wake) acquireWake();
  });

  // ---------- render ----------
  function renderPlay() {
    const b = $('play');
    b.textContent = playing ? '■ 停止' : '▶ 开始';
    b.classList.toggle('running', playing);
  }
  function renderValues() {
    $('bpm').textContent = s.bpm;
    $('bpmSlider').value = s.bpm;
    $('beatsVal').textContent = s.beats;
    $('subdivVal').textContent = s.subdiv;
    $('subdivHint').textContent = SUB_NAMES[s.subdiv];
    $('ticks').checked = s.ticks;
  }
  function strip(bits) {
    return '<span class="bits">' + [...bits].map((b) => `<i class="${b === '1' ? 'on' : ''}"></i>`).join('') + '</span>';
  }
  function renderBeats() {
    const host = $('beats');
    host.innerHTML = '';
    host.style.setProperty('--cols', s.beats <= 8 ? s.beats : Math.ceil(s.beats / 2));
    blocks = []; dots = []; lit = null;
    const anyHit = s.cells.some((c) => c.includes('1'));
    for (let b = 0; b < s.beats; b++) {
      const beat = document.createElement('div');
      beat.className = 'beat';
      beat.dataset.beat = b;
      const block = document.createElement('div');
      block.className = 'beat-block' + (anyHit && !s.cells[b].includes('1') ? ' rest' : '');
      const dotRow = document.createElement('div');
      dotRow.className = 'dots';
      const rowDots = [];
      for (let d = 0; d < s.subdiv; d++) {
        const dot = document.createElement('div');
        dot.className = 'dot' + (s.cells[b][d] === '1' ? ' hit' : '');
        dotRow.appendChild(dot);
        rowDots.push(dot);
      }
      beat.append(block, dotRow);
      host.appendChild(beat);
      blocks.push(block);
      dots.push(rowDots);
    }
  }
  function renderChips() {
    const host = $('chips');
    host.innerHTML = '';
    catalog(s.subdiv).forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (s.cells.every((c) => c === item.bits) ? ' active' : '');
      btn.dataset.bits = item.bits;
      btn.textContent = item.short;
      host.appendChild(btn);
    });
  }
  function renderAll() { renderValues(); renderBeats(); renderChips(); }

  // ---------- controls ----------
  function setBpm(v) { s.bpm = clamp(v, LIMITS.bpm); save(); renderValues(); }
  function setKey(key, v) {
    const before = s[key];
    s[key] = clamp(v, LIMITS[key]);
    if (s[key] === before) return;
    if (key === 'subdiv') {
      s.cells = Array.from({ length: s.beats }, zeros);      // patterns don't carry across resolutions
    } else {
      const last = s.cells[s.cells.length - 1] || zeros();
      s.cells = Array.from({ length: s.beats }, (_, i) => s.cells[i] || last);
    }
    save(); renderAll();
  }
  function applyAll(bits) {
    s.cells = Array.from({ length: s.beats }, () => bits);
    save(); renderBeats(); renderChips();
  }
  function applyBeat(beat, bits) {
    s.cells[beat] = bits;
    save(); renderBeats(); renderChips();
  }

  $('bpmSlider').addEventListener('input', (e) => setBpm(Number(e.target.value)));
  document.querySelectorAll('[data-bpm]').forEach((btn) =>
    btn.addEventListener('click', () => setBpm(s.bpm + Number(btn.dataset.bpm))));
  document.querySelectorAll('[data-key]').forEach((btn) =>
    btn.addEventListener('click', () => setKey(btn.dataset.key, s[btn.dataset.key] + Number(btn.dataset.d))));
  $('ticks').addEventListener('change', (e) => { s.ticks = e.target.checked; save(); });
  $('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) applyAll(chip.dataset.bits);
  });

  // tap a beat -> choose that beat's rhythm pattern
  const sheet = $('sheet');
  function openSheet(beat) {
    $('sheetTitle').textContent = `第 ${beat + 1} 拍的节奏型`;
    const list = $('sheetList');
    list.innerHTML = '';
    catalog(s.subdiv).forEach((item) => {
      const row = document.createElement('button');
      row.className = 'sheet-row' + (s.cells[beat] === item.bits ? ' active' : '');
      row.innerHTML = `<span>${item.name}</span>${strip(item.bits)}`;
      row.addEventListener('click', () => { applyBeat(beat, item.bits); closeSheet(); });
      list.appendChild(row);
    });
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; }
  $('beats').addEventListener('click', (e) => {
    const beat = e.target.closest('.beat');
    if (beat) openSheet(Number(beat.dataset.beat));
  });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

  $('tap').addEventListener('click', () => {
    const now = performance.now();
    tapTimes = tapTimes.filter((t) => now - t < 2500);
    tapTimes.push(now);
    if (tapTimes.length >= 2) {
      const gaps = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  });

  $('play').addEventListener('click', () => (playing ? stop() : start()));

  renderAll();
  renderPlay();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
})();
