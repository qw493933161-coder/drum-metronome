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
    mode: saved.mode === 'groove' ? 'groove' : 'metro',
    groove: typeof saved.groove === 'string' ? saved.groove : 'rock-q',
    gclick: saved.gclick !== false,
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
  function tone(time, kind, vol = 1) {
    const c = CLICK[kind];
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = c.type;
    osc.frequency.value = c.freq;
    g.gain.setValueAtTime(c.gain * vol, time);
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

  // ---------- 基础节奏：底鼓 / 军鼓 / 踩镲（合成音色），一小节 beats×spb 步 ----------
  // hh 闭镲、hho 开镲、sn 军鼓、bd 底鼓：都是小节内的步序号（0 起）
  const GROOVES = [
    { id: 'rock-q', level: '入门', name: '四分踩镲摇滚', beats: 4, spb: 4,
      desc: '踩镲每拍一下，底鼓 1、3 拍，军鼓 2、4 拍。先把手脚分开打稳。',
      hh: [0, 4, 8, 12], sn: [4, 12], bd: [0, 8] },
    { id: 'rock-8', level: '基础', name: '八分踩镲摇滚', beats: 4, spb: 4,
      desc: '最经典的摇滚节奏：踩镲每半拍一下，底鼓 1、3，军鼓 2、4。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 8] },
    { id: 'pop', level: '基础', name: '流行摇滚', beats: 4, spb: 4,
      desc: '在八分摇滚的基础上，第 2 拍的“&”多加一脚底鼓。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 6, 8] },
    { id: 'half', level: '基础', name: '半速节奏 Half-time', beats: 4, spb: 4,
      desc: '军鼓落在第 3 拍，听起来更慢更厚重，速度其实没变。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [8], bd: [0] },
    { id: 'disco', level: '基础', name: '迪斯科 Disco', beats: 4, spb: 4,
      desc: '底鼓每拍都踩，军鼓 2、4，闭镲在每拍上，开镲在每拍的“&”。',
      hh: [0, 4, 8, 12], hho: [2, 6, 10, 14], sn: [4, 12], bd: [0, 4, 8, 12] },
    { id: 'waltz', level: '基础', name: '华尔兹 3/4 拍', beats: 3, spb: 4,
      desc: '每小节只有 3 拍：底鼓 1，军鼓 2、3，踩镲每拍一下。',
      hh: [0, 4, 8], sn: [4, 8], bd: [0] },
    { id: 'rock-16', level: '进阶', name: '十六分踩镲摇滚', beats: 4, spb: 4,
      desc: '踩镲每个十六分音符都打，右手要一直匀速，底鼓 1、3，军鼓 2、4。',
      hh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], sn: [4, 12], bd: [0, 8] },
    { id: 'shuffle', level: '进阶', name: '蓝调 Shuffle（三连音）', beats: 4, spb: 3,
      desc: '每拍分成三份，踩镲打第 1、第 3 份，有“长短长短”的摇摆感；底鼓 1、3，军鼓 2、4。',
      hh: [0, 2, 3, 5, 6, 8, 9, 11], sn: [3, 9], bd: [0, 6] }
  ];

  let noiseBuf = null, gstep = 0;
  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.13);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.35);
  }
  function noiseHit(t, hp, gain, dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
  function snare(t) {
    noiseHit(t, 1500, 0.7, 0.16);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 190;
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.12);
  }
  const hat = (t, open) => noiseHit(t, 7000, open ? 0.35 : 0.3, open ? 0.28 : 0.05);

  function scheduleGroove() {
    const g = GROOVES.find((x) => x.id === s.groove) || GROOVES[0];
    const total = g.beats * g.spb;
    const horizon = ctx.currentTime + 0.12;
    while (nextTime < horizon) {
      if (gstep >= total) gstep = 0;
      const t = nextTime;
      if (g.hh.includes(gstep)) hat(t, false);
      if (g.hho && g.hho.includes(gstep)) hat(t, true);
      if (g.sn.includes(gstep)) snare(t);
      if (g.bd.includes(gstep)) kick(t);
      if (s.gclick && gstep % g.spb === 0) tone(t, gstep === 0 ? 0 : 1, 0.45);
      queue.push({ t, groove: true, step: gstep });
      nextTime += 60 / s.bpm / g.spb;
      gstep++;
    }
  }

  let gcols = [], glit = -1;
  function lightGroove(step) {
    if (glit >= 0 && gcols[glit]) gcols[glit].forEach((e) => e.classList.remove('cur'));
    glit = step;
    if (gcols[step]) gcols[step].forEach((e) => e.classList.add('cur'));
    moveScoreCursor(step);
  }

  const tick = () => (s.mode === 'groove' ? scheduleGroove() : schedule());

  // UI follows the audio clock via setInterval (rAF can stall when a tab isn't painting)
  function drain() {
    const now = ctx.currentTime;
    let due = null;
    while (queue.length && queue[0].t <= now) due = queue.shift();
    if (!due) return;
    if (due.groove) lightGroove(due.step);
    else light(due.beat, due.sub);
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
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    out = ctx.createGain();
    out.connect(ctx.destination);
    playing = true;
    pos = { beat: 0, sub: 0 };
    gstep = 0;
    queue = [];
    nextTime = ctx.currentTime + 0.08;
    tick();
    schedTimer = setInterval(tick, 25);
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
    lightGroove(-1);
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
    const sp = $('scorePlay');
    sp.textContent = b.textContent;
    sp.classList.toggle('running', playing);
  }
  function renderValues() {
    $('bpm').textContent = s.bpm;
    $('scoreBpm').textContent = s.bpm;
    $('bpmSlider').value = s.bpm;
    $('beatsVal').textContent = s.beats;
    $('subdivVal').textContent = s.subdiv;
    $('subdivHint').textContent = SUB_NAMES[s.subdiv];
    $('ticks').checked = s.ticks;
  }
  // ---------- 一拍的节奏记谱（SVG）：每个音持续到下一个音，末音持续到拍末 ----------
  const NOTE_VALUES = [ // [占一拍的比例, 符尾/连音线数, 附点数]
    [1, 0, 0], [0.75, 1, 1], [0.5, 1, 0], [0.375, 2, 1], [0.25, 2, 0], [0.1875, 3, 1], [0.125, 3, 0]
  ];
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const isPow2 = (x) => x > 0 && (x & (x - 1)) === 0;
  const nearestValue = (r) => NOTE_VALUES.reduce((best, v) => (Math.abs(v[0] - r) < Math.abs(best[0] - r) ? v : best));

  function rhythmEvents(bits) {
    const n = bits.length;
    const hits = [];
    [...bits].forEach((b, i) => { if (b === '1') hits.push(i); });
    const ev = [];
    if (!hits.length) ev.push({ rest: true, dur: n });
    else {
      if (hits[0] > 0) ev.push({ rest: true, dur: hits[0] });
      hits.forEach((h, i) => ev.push({ rest: false, dur: (i + 1 < hits.length ? hits[i + 1] : n) - h }));
    }
    const g = ev.reduce((acc, e) => gcd(acc, e.dur), n);
    const N = n / g;
    const tuplet = !isPow2(N);
    let base = 1;
    while (base * 2 <= N) base *= 2;
    const denom = tuplet ? base : N;
    let acc = 0;
    ev.forEach((e) => { const v = nearestValue(e.dur / g / denom); e.beams = v[1]; e.dots = v[2]; e.start = acc; acc += e.dur; });
    return { ev, tuplet: tuplet ? N : 0 };
  }

  // 休止符图形，以 (c, y≈27) 为中心，供 figure 与曲谱共用
  function restGlyph(c, e) {
    let s = '';
    if (e.beams === 0) {
      s += `<path d="M${c - 2} 16 L${c + 3} 22 L${c - 2.5} 28 L${c + 2} 33 q -4.5 1.5 -3 6.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else {
      const bottom = 37 + (e.beams - 1) * 3;
      s += `<path d="M${c + 3.5} 17 L${c - 1.5} ${bottom}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;
      for (let k = 0; k < e.beams; k++) {
        const cy = 22 + k * 6;
        s += `<circle cx="${c - 1.5 + (k ? -1.3 * k : 0)}" cy="${cy}" r="2" fill="currentColor"/>`;
        s += `<path d="M${c - 1.5 - 1.3 * k} ${cy} q 3.5 0 5 -3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
      }
    }
    if (e.dots) s += `<circle cx="${c + 7.5}" cy="27" r="1.5" fill="currentColor"/>`;
    return s;
  }

  function figure(bits, scale) {
    const { ev, tuplet } = rhythmEvents(bits);
    const SP = 15, HEAD_Y = 35, BEAM_Y = 13, H = 46;
    const pos = [];
    let x = 9;
    ev.forEach((e) => { pos.push(x); x += SP + (e.dots ? 5 : 0); });
    const W = x - SP + 13 + (ev[ev.length - 1].dots ? 5 : 0);
    const stemX = (i) => pos[i] + 4.2;
    let s = `<line x1="2" y1="${HEAD_Y}" x2="${W - 2}" y2="${HEAD_Y}" stroke="currentColor" stroke-width="1" opacity=".3"/>`;

    // beam groups: runs of consecutive notes (rests break them) that carry at least one beam
    const grouped = new Set();
    const groups = [];
    let run = [];
    ev.forEach((e, i) => {
      if (!e.rest && e.beams >= 1) run.push(i);
      else { if (run.length >= 2) groups.push(run); run = []; }
    });
    if (run.length >= 2) groups.push(run);
    groups.forEach((g) => g.forEach((i) => grouped.add(i)));

    groups.forEach((g) => {
      for (let level = 1; level <= 3; level++) {
        const y = BEAM_Y + (level - 1) * 4.6;
        g.forEach((i, k) => {
          if (ev[i].beams < level) return;
          const next = g[k + 1], prev = g[k - 1];
          if (next !== undefined && ev[next].beams >= level) {
            s += `<rect x="${stemX(i) - 0.7}" y="${y}" width="${stemX(next) - stemX(i) + 1.4}" height="2.6" fill="currentColor"/>`;
          } else if (!(prev !== undefined && ev[prev].beams >= level)) {
            const toRight = next !== undefined;
            s += `<rect x="${toRight ? stemX(i) - 0.7 : stemX(i) - 5.7}" y="${y}" width="6.4" height="2.6" fill="currentColor"/>`;
          }
        });
      }
    });

    ev.forEach((e, i) => {
      const c = pos[i];
      if (!e.rest) {
        s += `<ellipse cx="${c}" cy="${HEAD_Y}" rx="4.6" ry="3.4" transform="rotate(-20 ${c} ${HEAD_Y})" fill="currentColor"/>`;
        s += `<line x1="${stemX(i)}" y1="${HEAD_Y - 1}" x2="${stemX(i)}" y2="${BEAM_Y}" stroke="currentColor" stroke-width="1.5"/>`;
        if (e.beams >= 1 && !grouped.has(i)) {
          for (let level = 0; level < e.beams; level++) {
            const fy = BEAM_Y + level * 4.6;
            s += `<path d="M${stemX(i)} ${fy} q 7 4 5 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;
          }
        }
        if (e.dots) s += `<circle cx="${c + 9.5}" cy="${HEAD_Y - 3}" r="1.5" fill="currentColor"/>`;
      } else {
        s += restGlyph(c, e);
      }
    });

    if (tuplet) {
      const x1 = pos[0] - 5, x2 = pos[pos.length - 1] + 7, mid = (x1 + x2) / 2;
      s += `<path d="M${x1} 10 V7 H${mid - 5} M${mid + 5} 7 H${x2} V10" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
      s += `<text x="${mid}" y="10.4" text-anchor="middle" font-size="9.5" font-style="italic" fill="currentColor" font-family="serif">${tuplet}</text>`;
    }
    const k = scale || 0.85;
    return `<svg viewBox="0 0 ${W} ${H}" width="${Math.round(W * k)}" height="${Math.round(H * k)}" aria-hidden="true">${s}</svg>`;
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
      btn.setAttribute('aria-label', item.name);
      btn.title = item.name;
      btn.innerHTML = figure(item.bits, 0.85);
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
      row.setAttribute('aria-label', item.name);
      row.innerHTML = figure(item.bits, 1);
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

  // ---------- 基础节奏界面 ----------
  const LANES = [['踩镲', 'hh'], ['军鼓', 'sn'], ['底鼓', 'bd']];
  function renderGroove() {
    const g = GROOVES.find((x) => x.id === s.groove) || GROOVES[0];
    $('gTitle').textContent = g.name;
    $('gDesc').textContent = g.desc;
    $('gClick').checked = s.gclick;
    const total = g.beats * g.spb;
    const labels = g.spb === 4 ? ['', 'e', '&', 'a'] : ['', 'trip', 'let'];
    const host = $('gGrid');
    host.innerHTML = '';
    gcols = Array.from({ length: total }, () => []);
    glit = -1;

    const lane = (name) => {
      const row = document.createElement('div');
      row.className = 'lane';
      const label = document.createElement('span');
      label.className = 'lane-name';
      label.textContent = name;
      const cells = document.createElement('div');
      cells.className = 'cells';
      row.append(label, cells);
      host.appendChild(row);
      return cells;
    };
    const head = lane('');
    for (let i = 0; i < total; i++) {
      const k = i % g.spb;
      const sp = document.createElement('span');
      sp.className = 'cnt' + (k === 0 ? ' bs' : '');
      sp.textContent = k === 0 ? String(i / g.spb + 1) : labels[k];
      head.appendChild(sp);
    }
    LANES.forEach(([name, key]) => {
      const cells = lane(name);
      for (let i = 0; i < total; i++) {
        const open = key === 'hh' && g.hho && g.hho.includes(i);
        const on = g[key].includes(i) || open;
        const c = document.createElement('div');
        c.className = 'cell' + (i % g.spb === 0 ? ' bs' : '') + (on ? ` on-${key}` : '') + (open ? ' open' : '');
        cells.appendChild(c);
        gcols[i].push(c);
      }
    });
    host.dataset.n = total;
  }
  function renderGrooveList() {
    const host = $('gList');
    host.innerHTML = '';
    GROOVES.forEach((g) => {
      const b = document.createElement('button');
      b.className = 'g-item' + (g.id === s.groove ? ' active' : '');
      b.dataset.id = g.id;
      b.innerHTML = `<span class="g-name">${g.name}</span><span class="g-level lv-${g.level}">${g.level}</span>`;
      host.appendChild(b);
    });
  }
  function applyMode() {
    $('viewMetro').hidden = s.mode !== 'metro';
    $('viewGroove').hidden = s.mode !== 'groove';
    document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.mode));
    if (s.mode === 'groove') { renderGroove(); renderGrooveList(); }
  }
  $('seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.mode === s.mode) return;
    if (playing) stop();
    s.mode = btn.dataset.mode;
    save();
    applyMode();
  });
  $('gList').addEventListener('click', (e) => {
    const item = e.target.closest('.g-item');
    if (!item) return;
    s.groove = item.dataset.id;
    save();
    renderGroove();
    renderGrooveList();
  });
  $('gClick').addEventListener('change', (e) => { s.gclick = e.target.checked; save(); });

  // ---------- 鼓谱（五线谱）全屏界面 ----------
  // 谱线自下而上：踩镲 × 在第五线上方的间，军鼓在第 3 间，底鼓在第 1 间；
  // 手（踩镲+军鼓）符干朝上，脚（底鼓）符干朝下；每拍内按节奏自动连音线/休止符。
  function scoreSvg(g) {
    const beats = g.beats, spb = g.spb, total = beats * spb;
    const L = 8, top = 46, left = 58, sw = total <= 12 ? 26 : 22;
    const W = left + total * sw + 18, H = 138;
    const yHH = top - L / 2, ySN = top + 1.5 * L, yBD = top + 3.5 * L;
    const BEAM_UP = top - 4.4 * L, BEAM_DN = top + 7.4 * L;
    const X = (st) => left + (st + 0.5) * sw;
    let s = '';

    for (let i = 0; i < 5; i++) s += `<line x1="8" y1="${top + i * L}" x2="${W - 8}" y2="${top + i * L}" stroke="currentColor" stroke-width="1.1"/>`;
    s += `<rect x="14" y="${top + L}" width="3.2" height="${2 * L}" fill="currentColor"/><rect x="21" y="${top + L}" width="3.2" height="${2 * L}" fill="currentColor"/>`;
    s += `<text x="42" y="${top + L * 1.9}" text-anchor="middle" font-size="17" font-weight="700" font-family="serif" fill="currentColor">${beats}</text>`;
    s += `<text x="42" y="${top + L * 3.9}" text-anchor="middle" font-size="17" font-weight="700" font-family="serif" fill="currentColor">4</text>`;
    s += `<line x1="${W - 13}" y1="${top}" x2="${W - 13}" y2="${top + 4 * L}" stroke="currentColor" stroke-width="1.2"/><rect x="${W - 10}" y="${top}" width="3" height="${4 * L}" fill="currentColor"/>`;
    for (let b = 1; b < beats; b++) {
      const gx = left + b * spb * sw;
      s += `<line x1="${gx}" y1="${top - 4.6 * L}" x2="${gx}" y2="${H - 18}" stroke="currentColor" stroke-width="1" stroke-dasharray="2 4" opacity=".22"/>`;
    }

    const stepsOf = (...arrs) => { const set = new Set(); arrs.forEach((a) => (a || []).forEach((i) => set.add(i))); return set; };
    const headsAt = (st) => {
      const h = [];
      if (g.hh.includes(st)) h.push({ y: yHH, k: 'x' });
      if (g.hho && g.hho.includes(st)) h.push({ y: yHH, k: 'xo' });
      if (g.sn.includes(st)) h.push({ y: ySN, k: 'o' });
      return h;
    };
    const kickAt = () => [{ y: yBD, k: 'o' }];

    function voice(set, up, heads) {
      const beamY = up ? BEAM_UP : BEAM_DN;
      const stemX = (st) => X(st) + (up ? 4.6 : -4.6);
      const beamRectY = (level) => (up ? beamY + (level - 1) * 5 : beamY - 3 - (level - 1) * 5);
      for (let b = 0; b < beats; b++) {
        let bits = '';
        for (let k = 0; k < spb; k++) bits += set.has(b * spb + k) ? '1' : '0';
        const { ev, tuplet } = rhythmEvents(bits);
        const it = ev.map((e) => ({ e, st: b * spb + e.start }));

        const groups = [];
        let run = [];
        it.forEach((x, i) => {
          if (!x.e.rest && x.e.beams >= 1) run.push(i);
          else { if (run.length >= 2) groups.push(run); run = []; }
        });
        if (run.length >= 2) groups.push(run);
        const grouped = new Set(groups.flat());

        groups.forEach((gr) => {
          for (let level = 1; level <= 3; level++) {
            gr.forEach((i, k) => {
              if (it[i].e.beams < level) return;
              const next = gr[k + 1], prev = gr[k - 1];
              const y = beamRectY(level);
              if (next !== undefined && it[next].e.beams >= level) {
                s += `<rect x="${stemX(it[i].st) - 0.7}" y="${y}" width="${stemX(it[next].st) - stemX(it[i].st) + 1.4}" height="3" fill="currentColor"/>`;
              } else if (!(prev !== undefined && it[prev].e.beams >= level)) {
                const right = next !== undefined;
                s += `<rect x="${right ? stemX(it[i].st) - 0.7 : stemX(it[i].st) - 6.7}" y="${y}" width="7.4" height="3" fill="currentColor"/>`;
              }
            });
          }
        });

        it.forEach((x, i) => {
          const cx = X(x.st);
          if (x.e.rest) {
            const mid = left + (x.st + x.e.dur / 2) * sw;
            const cy = up ? top + 14 : top + 30;
            s += `<g transform="translate(0 ${cy - 27.5})">${restGlyph(mid, x.e)}</g>`;
            return;
          }
          const hs = heads(x.st);
          hs.forEach((h) => {
            if (h.k === 'o') {
              s += `<ellipse cx="${cx}" cy="${h.y}" rx="4.8" ry="3.5" transform="rotate(-20 ${cx} ${h.y})" fill="currentColor"/>`;
            } else {
              s += `<path d="M${cx - 3.7} ${h.y - 3.7} L${cx + 3.7} ${h.y + 3.7} M${cx - 3.7} ${h.y + 3.7} L${cx + 3.7} ${h.y - 3.7}" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
              if (h.k === 'xo') s += `<circle cx="${cx}" cy="${h.y - 9}" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
            }
          });
          const headYs = hs.map((h) => h.y);
          const from = up ? Math.max(...headYs) : Math.min(...headYs);
          s += `<line x1="${stemX(x.st)}" y1="${from}" x2="${stemX(x.st)}" y2="${beamY}" stroke="currentColor" stroke-width="1.5"/>`;
          if (x.e.beams >= 1 && !grouped.has(i)) {
            for (let level = 0; level < x.e.beams; level++) {
              const fy = up ? beamY + level * 5 : beamY - level * 5;
              s += `<path d="M${stemX(x.st)} ${fy} q 7 ${up ? 4 : -4} 5 ${up ? 12 : -12}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
            }
          }
          if (x.e.dots) s += `<circle cx="${cx + 9.5}" cy="${hs[0].y - 3}" r="1.6" fill="currentColor"/>`;
        });

        if (tuplet) {
          const x1 = X(b * spb) - 7, x2 = X((b + 1) * spb - 1) + 8, mid = (x1 + x2) / 2;
          const by = up ? beamY - 10 : beamY + 12;
          const d = up ? 4 : -4;
          s += `<path d="M${x1} ${by + d} V${by} H${mid - 6} M${mid + 6} ${by} H${x2} V${by + d}" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
          s += `<text x="${mid}" y="${by + 4.6}" text-anchor="middle" font-size="14" font-weight="700" font-style="italic" font-family="serif" fill="currentColor">${tuplet}</text>`;
        }
      }
    }

    voice(stepsOf(g.hh, g.hho, g.sn), true, headsAt);
    voice(stepsOf(g.bd), false, kickAt);

    const labels = spb === 4 ? ['', 'e', '&', 'a'] : ['', 'trip', 'let'];
    for (let i = 0; i < total; i++) {
      const k = i % spb;
      s += k === 0
        ? `<text x="${X(i)}" y="${H - 5}" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">${i / spb + 1}</text>`
        : `<text x="${X(i)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">${labels[k]}</text>`;
    }
    s += `<rect class="cur" x="0" y="${top - 4.8 * L}" width="${sw}" height="${H - 18 - (top - 4.8 * L)}" rx="4" fill="#ff6b4a" opacity="0"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" data-left="${left}" data-sw="${sw}" style="width:100%;height:auto;display:block">${s}</svg>`;
  }

  let scoreCursor = null, scoreGeom = null;
  function renderScore() {
    const g = GROOVES.find((x) => x.id === s.groove) || GROOVES[0];
    $('scoreTitle').textContent = g.name;
    $('scoreSub').textContent = `${g.level} · ${g.beats}/4 拍`;
    const host = $('scoreSvgHost');
    host.innerHTML = scoreSvg(g);
    const svg = host.firstElementChild;
    scoreCursor = svg.querySelector('.cur');
    scoreGeom = { left: Number(svg.dataset.left), sw: Number(svg.dataset.sw) };
  }
  function moveScoreCursor(step) {
    if (!scoreCursor) return;
    if (step < 0) { scoreCursor.setAttribute('opacity', '0'); return; }
    scoreCursor.setAttribute('x', scoreGeom.left + step * scoreGeom.sw);
    scoreCursor.setAttribute('opacity', '0.28');
  }
  $('openScore').addEventListener('click', () => { renderScore(); $('score').hidden = false; });
  $('scoreClose').addEventListener('click', () => { $('score').hidden = true; });
  $('scorePlay').addEventListener('click', () => (playing ? stop() : start()));
  document.querySelectorAll('[data-sbpm]').forEach((btn) =>
    btn.addEventListener('click', () => setBpm(s.bpm + Number(btn.dataset.sbpm))));

  renderAll();
  renderPlay();
  applyMode();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
})();
