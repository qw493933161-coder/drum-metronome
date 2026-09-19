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
    mode: ['groove', 'pad', 'combo'].includes(saved.mode) ? saved.mode : 'metro',
    combo: Array.isArray(saved.combo) ? saved.combo : null,
    ctab: ['long', 'six', 'trip', 'sync'].includes(saved.ctab) ? saved.ctab : 'long',
    cclick: saved.cclick !== false,
    avOffset: Number.isFinite(saved.avOffset) ? Math.max(-80, Math.min(500, Math.round(saved.avOffset))) : 0,
    mine: Array.isArray(saved.mine) ? saved.mine.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.seq)) : [],
    curMine: typeof saved.curMine === 'string' ? saved.curMine : null,
    hist: Array.isArray(saved.hist) ? saved.hist.filter((x) => typeof x === 'string').slice(-30) : [],
    rbars: [2, 4, 6, 8].includes(saved.rbars) ? saved.rbars : 4,
    rdiff: ['basic', 'adv', 'trip'].includes(saved.rdiff) ? saved.rdiff : 'basic',
    groove: typeof saved.groove === 'string' ? saved.groove : 'rock-q',
    gclick: saved.gclick !== false,
    pad: typeof saved.pad === 'string' ? saved.pad : 'single8',
    pclick: saved.pclick !== false,
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
    // ---- 摇滚 ----
    { id: 'rock-q', cat: '摇滚', level: '入门', name: '四分踩镲摇滚', beats: 4, spb: 4,
      desc: '踩镲每拍一下，底鼓 1、3 拍，军鼓 2、4 拍。先把手脚分开打稳。',
      hh: [0, 4, 8, 12], sn: [4, 12], bd: [0, 8] },
    { id: 'rock-8', cat: '摇滚', level: '基础', name: '八分踩镲摇滚', beats: 4, spb: 4,
      desc: '最经典的摇滚节奏：踩镲每半拍一下，底鼓 1、3，军鼓 2、4。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 8] },
    { id: 'rock-open', cat: '摇滚', level: '基础', name: '八分摇滚 + 尾拍开镲', beats: 4, spb: 4,
      desc: '八分摇滚，最后一拍的“&”换成开镲，常用来给下一小节“起势”。',
      hh: [0, 2, 4, 6, 8, 10, 12], hho: [14], sn: [4, 12], bd: [0, 8] },
    { id: 'rock-k1', cat: '摇滚', level: '基础', name: '摇滚变奏：底鼓 1、3、3&', beats: 4, spb: 4,
      desc: '在八分摇滚的第 3 拍后面多一脚底鼓（3 &），手不变，只练脚。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 8, 10] },
    { id: 'rock-k2', cat: '摇滚', level: '基础', name: '摇滚变奏：底鼓 1、1&、3', beats: 4, spb: 4,
      desc: '第 1 拍连踩两脚（1 和 1&），第 3 拍一脚；手仍是八分踩镲加 2、4 军鼓。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 2, 8] },
    { id: 'rock-k3', cat: '摇滚', level: '基础', name: '摇滚变奏：底鼓 1、3、4&', beats: 4, spb: 4,
      desc: '小节末多一脚底鼓（4&），听起来有往前推的感觉。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 8, 14] },
    { id: 'half', cat: '摇滚', level: '基础', name: '半速节奏 Half-time', beats: 4, spb: 4,
      desc: '军鼓落在第 3 拍，听起来更慢更厚重，速度其实没变。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [8], bd: [0] },
    { id: 'rock-16', cat: '摇滚', level: '进阶', name: '十六分踩镲摇滚', beats: 4, spb: 4,
      desc: '踩镲每个十六分音符都打，右手要一直匀速，底鼓 1、3，军鼓 2、4。',
      hh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], sn: [4, 12], bd: [0, 8] },
    { id: 'rock-16k', cat: '摇滚', level: '进阶', name: '十六分踩镲 + 加底鼓', beats: 4, spb: 4,
      desc: '十六分踩镲摇滚上再加底鼓 1、3、3&，右手匀速，脚要独立。',
      hh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], sn: [4, 12], bd: [0, 8, 10] },

    // ---- 流行 · 嘻哈 · 放克 ----
    { id: 'pop', cat: '流行 · 嘻哈 · 放克', level: '基础', name: '流行摇滚', beats: 4, spb: 4,
      desc: '在八分摇滚的基础上，第 2 拍的“&”多加一脚底鼓。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 6, 8] },
    { id: 'hiphop', cat: '流行 · 嘻哈 · 放克', level: '基础', name: '嘻哈 Boom-bap', beats: 4, spb: 4,
      desc: '八分踩镲，底鼓 1、3&，军鼓 2、4。速度放慢（70 到 90 BPM）更有味道。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [4, 12], bd: [0, 10] },
    { id: 'funk', cat: '流行 · 嘻哈 · 放克', level: '进阶', name: '放克基础 Funk', beats: 4, spb: 4,
      desc: '十六分踩镲，底鼓 1、3&，军鼓 2、4。踩镲要匀，脚和军鼓要准。',
      hh: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], sn: [4, 12], bd: [0, 10] },

    // ---- 舞曲 · 雷鬼 ----
    { id: 'disco', cat: '舞曲 · 雷鬼', level: '基础', name: '迪斯科 Disco', beats: 4, spb: 4,
      desc: '底鼓每拍都踩，军鼓 2、4，闭镲在每拍上，开镲在每拍的“&”。',
      hh: [0, 4, 8, 12], hho: [2, 6, 10, 14], sn: [4, 12], bd: [0, 4, 8, 12] },
    { id: 'reggae', cat: '舞曲 · 雷鬼', level: '基础', name: '雷鬼 One Drop', beats: 4, spb: 4,
      desc: '底鼓和军鼓一起落在第 3 拍，第 1 拍留空，踩镲八分音符。空着的第 1 拍要在心里数。',
      hh: [0, 2, 4, 6, 8, 10, 12, 14], sn: [8], bd: [8] },

    // ---- 拍号与摇摆 ----
    { id: 'waltz', cat: '拍号与摇摆', level: '基础', name: '华尔兹 3/4 拍', beats: 3, spb: 4,
      desc: '每小节只有 3 拍：底鼓 1，军鼓 2、3，踩镲每拍一下。',
      hh: [0, 4, 8], sn: [4, 8], bd: [0] },
    { id: 'waltz8', cat: '拍号与摇摆', level: '基础', name: '华尔兹（八分踩镲）', beats: 3, spb: 4,
      desc: '3/4 拍加上八分踩镲：底鼓 1，军鼓 2、3，比四分踩镲更有动感。',
      hh: [0, 2, 4, 6, 8, 10], sn: [4, 8], bd: [0] },
    { id: 'shuffle', cat: '拍号与摇摆', level: '进阶', name: '蓝调 Shuffle（三连音）', beats: 4, spb: 3,
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
  function snare(t, vol = 1) {
    noiseHit(t, 1500, 0.7 * vol, 0.16);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 190;
    g.gain.setValueAtTime(0.45 * vol, t);
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

  // ---------- 鼓垫练习：单一军鼓/鼓垫音，手序 R/L，'>' 为重音，'.' 为休止 ----------
  const PADS = [
    // ---- 单击 ----
    { id: 'single4', cat: '单击', level: '入门', name: '单击（四分）', beats: 4, spb: 4,
      desc: '最慢的单击：左右手轮流各打一下，每拍一下。先练棍子的高度和声音，让左右一样。',
      seq: 'R . . . L . . . R . . . L . . .' },
    { id: 'single8', cat: '单击', level: '入门', name: '单击（八分）', beats: 4, spb: 2,
      desc: '左右手交替，每半拍一下。先让左右手的高度、力度、声音完全一样。',
      seq: 'R L R L R L R L' },
    { id: 'single16', cat: '单击', level: '入门', name: '单击（十六分）', beats: 4, spb: 4,
      desc: '同样左右交替，速度翻倍。放松手腕，让棍子自己弹起来。',
      seq: 'R L R L R L R L R L R L R L R L' },
    { id: 'lead-left', cat: '单击', level: '入门', name: '单击（左手起手）', beats: 4, spb: 4,
      desc: '同样的十六分单击，但从左手开始。两只手都要能“带头”。',
      seq: 'L R L R L R L R L R L R L R L R' },
    { id: 'single3', cat: '单击', level: '基础', name: '单击（三连音）', beats: 4, spb: 3,
      desc: '每拍三下，左右手交替，所以每拍起手的手都在换（右左右 / 左右左）。',
      seq: 'R L R L R L R L R L R L' },
    { id: 'single-rest1', cat: '单击', level: '基础', name: '单击（十六分，打一拍休一拍）', beats: 4, spb: 4,
      desc: '打四下，休一拍，再打四下。休止的那一拍心里继续数，手不要动，下一拍准时进。',
      seq: 'R L R L . . . . R L R L . . . .' },
    { id: 'single-rest2', cat: '单击', level: '基础', name: '单击（十六分，打两拍休两拍）', beats: 4, spb: 4,
      desc: '连续打两拍，再休两拍。休得越久越容易“抢拍”，用节拍参考音来校准。',
      seq: 'R L R L R L R L . . . . . . . .' },

    // ---- 双击 ----
    { id: 'double8', cat: '双击', level: '基础', name: '双击（八分）', beats: 4, spb: 2,
      desc: '每只手连打两下：右右左左。先慢，第二下靠棍子反弹，不要用力砸。',
      seq: 'R R L L R R L L' },
    { id: 'double16', cat: '双击', level: '基础', name: '双击（十六分）', beats: 4, spb: 4,
      desc: '每只手连打两下，第二下靠棍子的反弹，别用力砸。',
      seq: 'R R L L R R L L R R L L R R L L' },
    { id: 'double-left', cat: '双击', level: '基础', name: '双击（左手起手）', beats: 4, spb: 4,
      desc: '从左手开始的双击：左左右右。',
      seq: 'L L R R L L R R L L R R L L R R' },

    // ---- 复合 Paradiddle ----
    { id: 'para8', cat: '复合 Paradiddle', level: '基础', name: '单复合（八分，慢速入门）', beats: 4, spb: 2,
      desc: '右左右右 左右左左，每组第一下重音。先用八分音符把手序背熟。',
      seq: 'R> L R R L> R L L' },
    { id: 'para', cat: '复合 Paradiddle', level: '基础', name: '单复合 Paradiddle', beats: 4, spb: 4,
      desc: '右左右右 左右左左，每组第一下重音。所有复合类练习的基础。',
      seq: 'R> L R R L> R L L R> L R R L> R L L' },
    { id: 'para-left', cat: '复合 Paradiddle', level: '基础', name: '单复合（左手起手）', beats: 4, spb: 4,
      desc: '左右左左 右左右右，从左手开始，重音在每组第一下。',
      seq: 'L> R L L R> L R R L> R L L R> L R R' },
    { id: 'para-inv', cat: '复合 Paradiddle', level: '进阶', name: '反向复合 Inverted', beats: 4, spb: 4,
      desc: '右左左右 左右右左：把单复合的双击挪到中间，换手的位置变了。',
      seq: 'R L L R L R R L R L L R L R R L' },
    { id: 'para-2', cat: '复合 Paradiddle', level: '进阶', name: '双复合 Double Paradiddle', beats: 4, spb: 3,
      desc: '右左右左右右 左右左右左左，三连音一组 6 下，每组第一下重音。',
      seq: 'R> L R L R R L> R L R L L' },
    { id: 'para-3', cat: '复合 Paradiddle', level: '进阶', name: '三复合 Triple Paradiddle', beats: 4, spb: 4,
      desc: '每组 8 下：右左右左右左右右，接着左右左右左右左左。',
      seq: 'R> L R L R L R R L> R L R L R L L' },
    { id: 'para-dd', cat: '复合 Paradiddle', level: '进阶', name: '复合双击 Paradiddle-diddle', beats: 4, spb: 3,
      desc: '右左右右左左 左右左左右右，三连音每拍两下换手，第一下重音。',
      seq: 'R> L R R L L L> R L L R R' },

    // ---- 滚奏 ----
    { id: 'roll5', cat: '滚奏', level: '进阶', name: '五击滚奏 Five-stroke roll', beats: 4, spb: 4,
      desc: '右右左左 + 右（重音落在第 2 拍），下一组左右互换。前四下是双击，最后一下落稳。',
      seq: 'R R L L R> . . . L L R R L> . . .' },
    { id: 'triple3', cat: '滚奏', level: '进阶', name: '三击（三连音）', beats: 4, spb: 3,
      desc: '每只手连续打三下，每拍换手。练手指的连续弹跳，三下要一样匀。',
      seq: 'R R R L L L R R R L L L' },

    // ---- 重音练习 ----
    { id: 'acc1', cat: '重音练习', level: '基础', name: '十六分单击：重音在 1', beats: 4, spb: 4,
      desc: '每拍第一下重音，其余轻。重音要高抬棍，轻音要低，高低差拉开。',
      seq: 'R> L R L R> L R L R> L R L R> L R L' },
    { id: 'acc-e', cat: '重音练习', level: '进阶', name: '十六分单击：重音在 e', beats: 4, spb: 4,
      desc: '重音挪到每拍的第二下（e），全落在左手。重音位置一变，节奏感就变了。',
      seq: 'R L> R L R L> R L R L> R L R L> R L' },
    { id: 'acc-and', cat: '重音练习', level: '进阶', name: '十六分单击：重音在 &', beats: 4, spb: 4,
      desc: '重音在每拍的第三下（&），全落在右手，听起来像反拍。',
      seq: 'R L R> L R L R> L R L R> L R L R> L' },
    { id: 'acc-a', cat: '重音练习', level: '进阶', name: '十六分单击：重音在 a', beats: 4, spb: 4,
      desc: '重音在每拍的最后一下（a），全落在左手，紧贴下一拍，最容易抢拍。',
      seq: 'R L R L> R L R L> R L R L> R L R L>' },
    { id: 'acc-1and', cat: '重音练习', level: '进阶', name: '十六分单击：重音在 1 和 &', beats: 4, spb: 4,
      desc: '每拍两个重音，全落在右手，左手都是轻音。',
      seq: 'R> L R> L R> L R> L R> L R> L R> L R> L' },
    { id: 'acc-ea', cat: '重音练习', level: '进阶', name: '十六分单击：重音在 e 和 a', beats: 4, spb: 4,
      desc: '每拍两个重音，全落在左手，右手都是轻音。',
      seq: 'R L> R L> R L> R L> R L> R L> R L> R L>' },
    { id: 'acc-trip', cat: '重音练习', level: '进阶', name: '三连音单击：每拍第一下重音', beats: 4, spb: 3,
      desc: '三连音单击，每拍第一下重音，重音的手每拍在换（右、左、右、左）。',
      seq: 'R> L R L> R L R> L R L> R L' },

    // ---- 综合 ----
    { id: 'mix-sd', cat: '综合', level: '进阶', name: '单击 + 双击 交替', beats: 4, spb: 4,
      desc: '第 1、3 拍打单击，第 2、4 拍打双击，两种手法交替切换，速度不能变。',
      seq: 'R L R L R R L L R L R L R R L L' },
    { id: 'mix-168', cat: '综合', level: '进阶', name: '十六分与八分交替', beats: 4, spb: 4,
      desc: '第 1、3 拍十六分（4 下），第 2、4 拍八分（2 下），练速度切换时的稳定。',
      seq: 'R L R L R . L . R L R L R . L .' }
  ];
  PADS.forEach((p) => {
    p.hits = p.seq.split(/\s+/).map((tok) => {
      if (tok === '.') return null;
      const m = /^([RL])(>?)$/.exec(tok);
      return { h: m[1], a: m[2] === '>' };
    });
    if (p.hits.length !== p.beats * p.spb) console.error('pad length mismatch', p.id, p.hits.length);
  });

  function schedulePad() {
    const ex = PADS.find((x) => x.id === s.pad) || PADS[0];
    const total = ex.beats * ex.spb;
    const horizon = ctx.currentTime + 0.12;
    while (nextTime < horizon) {
      if (gstep >= total) gstep = 0;
      const hit = ex.hits[gstep];
      if (hit) snare(nextTime, hit.a ? 1 : 0.62);
      if (s.pclick && gstep % ex.spb === 0) tone(nextTime, gstep === 0 ? 0 : 1, 0.45);
      queue.push({ t: nextTime, groove: true, step: gstep });
      nextTime += 60 / s.bpm / ex.spb;
      gstep++;
    }
  }

  function lightGroove(step) { moveScoreCursor(step); }

  const tick = () => {
    if (s.mode === 'groove') scheduleGroove();
    else if (s.mode === 'pad') schedulePad();
    else if (s.mode === 'combo') scheduleCombo();
    else schedule();
  };

  // UI follows the audio clock via setInterval (rAF can stall when a tab isn't painting)
  // 声音从"安排的时间"到耳朵还要经过设备输出延迟（手机几十毫秒，蓝牙耳机上百毫秒），
  // 高亮按"听到的时间"走：自动扣除设备报告的延迟，再加上用户手动校准的偏移
  function autoLatency() { return ctx ? (ctx.outputLatency || ctx.baseLatency || 0) : 0; }
  function visualLag() { return autoLatency() + s.avOffset / 1000; }
  function drain() {
    const now = ctx.currentTime - visualLag();
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
    if (s.mode === 'combo' && !s.combo.length) {
      $('cHint').textContent = '先从下面选几个时值放进来，再点开始';
      return;
    }
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
    $('gLegend').innerHTML = LEGEND_GROOVE;
    const host = $('gScore');
    host.innerHTML = scoreSvg(g);
    setCursor('inline', host.firstElementChild);
  }
  // 分组列表：内容多了以后按类别折叠，当前选中项所在的类别自动展开
  const openCats = { groove: new Set(), pad: new Set(), combo: new Set() };
  function renderGrouped(host, key, items, activeIdx, makeItem) {
    host.innerHTML = '';
    const cats = [];
    items.forEach((it, i) => {
      let c = cats.find((x) => x.name === it.cat);
      if (!c) { c = { name: it.cat, idxs: [] }; cats.push(c); }
      c.idxs.push(i);
    });
    const open = openCats[key];
    if (activeIdx >= 0) open.add(items[activeIdx].cat);
    if (!open.size && cats.length) open.add(cats[0].name);
    cats.forEach((c) => {
      const wrap = document.createElement('div');
      wrap.className = 'g-group' + (open.has(c.name) ? ' open' : '');
      const head = document.createElement('button');
      head.className = 'g-cat';
      head.dataset.cat = c.name;
      head.innerHTML = `<span>${c.name}</span><small>${c.idxs.length}</small>`;
      const body = document.createElement('div');
      body.className = 'g-items';
      c.idxs.forEach((i) => body.appendChild(makeItem(items[i], i)));
      wrap.append(head, body);
      host.appendChild(wrap);
    });
  }
  [['gList', 'groove'], ['pList', 'pad'], ['cPresets', 'combo']].forEach(([id, key]) =>
    $(id).addEventListener('click', (e) => {
      const head = e.target.closest('.g-cat');
      if (!head) return;
      const set = openCats[key], name = head.dataset.cat;
      if (set.has(name)) set.delete(name); else set.add(name);
      head.parentElement.classList.toggle('open', set.has(name));
    }));

  function renderGrooveList() {
    renderGrouped($('gList'), 'groove', GROOVES, GROOVES.findIndex((x) => x.id === s.groove), (g) => {
      const b = document.createElement('button');
      b.className = 'g-item' + (g.id === s.groove ? ' active' : '');
      b.dataset.id = g.id;
      b.innerHTML = `<span class="g-name">${g.name}</span><span class="g-level lv-${g.level}">${g.level}</span>`;
      return b;
    });
  }
  function applyMode() {
    $('viewMetro').hidden = s.mode !== 'metro';
    $('viewGroove').hidden = s.mode !== 'groove';
    $('viewPad').hidden = s.mode !== 'pad';
    $('viewCombo').hidden = s.mode !== 'combo';
    document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.mode));
    if (s.mode === 'groove') { renderGroove(); renderGrooveList(); }
    if (s.mode === 'pad') { renderPad(); renderPadList(); }
    if (s.mode === 'combo') renderCombo();
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

  // ---------- 鼓垫谱（单线谱）：符头在线上，符干朝上，'>' 重音，下方 R/L 手序 ----------
  function drawVoice(o) {
    const { beats, spb, left, sw, set, headsAt, beamY, restCY, accents } = o;
    const X = (st) => left + (st + 0.5) * sw;
    const stemX = (st) => X(st) + 4.6;
    const beamRectY = (level) => beamY + (level - 1) * 5;
    let s2 = '';
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
              s2 += `<rect x="${stemX(it[i].st) - 0.7}" y="${y}" width="${stemX(it[next].st) - stemX(it[i].st) + 1.4}" height="3" fill="currentColor"/>`;
            } else if (!(prev !== undefined && it[prev].e.beams >= level)) {
              const right = next !== undefined;
              s2 += `<rect x="${right ? stemX(it[i].st) - 0.7 : stemX(it[i].st) - 6.7}" y="${y}" width="7.4" height="3" fill="currentColor"/>`;
            }
          });
        }
      });
      it.forEach((x, i) => {
        const cx = X(x.st);
        if (x.e.rest) {
          const mid = left + (x.st + x.e.dur / 2) * sw;
          s2 += `<g transform="translate(0 ${restCY - 27.5})">${restGlyph(mid, x.e)}</g>`;
          return;
        }
        const hs = headsAt(x.st);
        hs.forEach((h) => {
          s2 += `<ellipse cx="${cx}" cy="${h.y}" rx="4.8" ry="3.5" transform="rotate(-20 ${cx} ${h.y})" fill="currentColor"/>`;
        });
        s2 += `<line x1="${stemX(x.st)}" y1="${hs[0].y - 1}" x2="${stemX(x.st)}" y2="${beamY}" stroke="currentColor" stroke-width="1.5"/>`;
        if (x.e.beams >= 1 && !grouped.has(i)) {
          for (let level = 0; level < x.e.beams; level++) {
            s2 += `<path d="M${stemX(x.st)} ${beamY + level * 5} q 7 4 5 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
          }
        }
        if (x.e.dots) s2 += `<circle cx="${cx + 9.5}" cy="${hs[0].y - 3}" r="1.6" fill="currentColor"/>`;
        if (accents && accents.has(x.st)) {
          const ay = beamY - 9;
          s2 += `<path d="M${cx - 4.6} ${ay - 3.6} L${cx + 4.6} ${ay} L${cx - 4.6} ${ay + 3.6}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
      });
      if (tuplet) {
        const x1 = X(b * spb) - 7, x2 = X((b + 1) * spb - 1) + 8, mid = (x1 + x2) / 2;
        const by = beamY - 10 - (accents ? 14 : 0);
        s2 += `<path d="M${x1} ${by + 4} V${by} H${mid - 6} M${mid + 6} ${by} H${x2} V${by + 4}" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
        s2 += `<text x="${mid}" y="${by + 4.6}" text-anchor="middle" font-size="14" font-weight="700" font-style="italic" font-family="serif" fill="currentColor">${tuplet}</text>`;
      }
    }
    return s2;
  }

  function padSvg(ex) {
    const beats = ex.beats, spb = ex.spb, total = beats * spb;
    const lineY = 74, left = 58, sw = total <= 12 ? 26 : 22;
    const W = left + total * sw + 18, H = 132;
    const X = (st) => left + (st + 0.5) * sw;
    let s2 = `<line x1="8" y1="${lineY}" x2="${W - 8}" y2="${lineY}" stroke="currentColor" stroke-width="1.2"/>`;
    s2 += `<rect x="14" y="${lineY - 9}" width="3.2" height="18" fill="currentColor"/><rect x="21" y="${lineY - 9}" width="3.2" height="18" fill="currentColor"/>`;
    s2 += `<text x="42" y="${lineY - 1.5}" text-anchor="middle" font-size="16" font-weight="700" font-family="serif" fill="currentColor">${beats}</text>`;
    s2 += `<text x="42" y="${lineY + 15.5}" text-anchor="middle" font-size="16" font-weight="700" font-family="serif" fill="currentColor">4</text>`;
    s2 += `<line x1="${W - 13}" y1="${lineY - 9}" x2="${W - 13}" y2="${lineY + 9}" stroke="currentColor" stroke-width="1.2"/><rect x="${W - 10}" y="${lineY - 9}" width="3" height="18" fill="currentColor"/>`;
    for (let b = 1; b < beats; b++) {
      const gx = left + b * spb * sw;
      s2 += `<line x1="${gx}" y1="20" x2="${gx}" y2="${H - 18}" stroke="currentColor" stroke-width="1" stroke-dasharray="2 4" opacity=".22"/>`;
    }
    const set = new Set(), accents = new Set();
    ex.hits.forEach((h, i) => { if (h) { set.add(i); if (h.a) accents.add(i); } });
    s2 += drawVoice({ beats, spb, left, sw, set, accents, beamY: lineY - 34, restCY: lineY, headsAt: () => [{ y: lineY }] });
    ex.hits.forEach((h, i) => {
      if (!h) return;
      s2 += `<text x="${X(i)}" y="${lineY + 26}" text-anchor="middle" font-size="${h.a ? 15 : 13}" font-weight="700" fill="${h.h === 'R' ? '#d8452a' : '#3b4fd6'}">${h.h}</text>`;
    });
    const labels = spb === 4 ? ['', 'e', '&', 'a'] : spb === 3 ? ['', 'trip', 'let'] : ['', '&'];
    for (let i = 0; i < total; i++) {
      const k = i % spb;
      s2 += k === 0
        ? `<text x="${X(i)}" y="${H - 5}" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">${i / spb + 1}</text>`
        : `<text x="${X(i)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">${labels[k]}</text>`;
    }
    s2 += `<rect class="cur" x="0" y="20" width="${sw}" height="${H - 18 - 20}" rx="4" fill="#ff6b4a" opacity="0"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" data-left="${left}" data-sw="${sw}" style="width:100%;height:auto;display:block">${s2}</svg>`;
  }

  // ---------- 鼓垫练习界面 ----------
  function renderPad() {
    const ex = PADS.find((x) => x.id === s.pad) || PADS[0];
    $('pTitle').textContent = ex.name;
    $('pDesc').textContent = ex.desc;
    $('pClick').checked = s.pclick;
    $('pLegend').innerHTML = LEGEND_PAD;
    const host = $('pScore');
    host.innerHTML = padSvg(ex);
    setCursor('inline', host.firstElementChild);
  }
  function renderPadList() {
    renderGrouped($('pList'), 'pad', PADS, PADS.findIndex((x) => x.id === s.pad), (p) => {
      const b = document.createElement('button');
      b.className = 'g-item' + (p.id === s.pad ? ' active' : '');
      b.dataset.id = p.id;
      b.innerHTML = `<span class="g-name">${p.name}</span><span class="g-level lv-${p.level}">${p.level}</span>`;
      return b;
    });
  }
  $('pList').addEventListener('click', (e) => {
    const item = e.target.closest('.g-item');
    if (!item) return;
    s.pad = item.dataset.id;
    save();
    renderPad();
    renderPadList();
  });
  $('pClick').addEventListener('change', (e) => { s.pclick = e.target.checked; save(); });

  // ---------- 变速练习：把不同时值拼成一串，按 4/4 自动分小节 ----------
  // 时间单位 = 1/12 拍：十六分=3，八分=6，四分=12，三连音八分=4；一小节 = 48
  const BAR = 48;
  const NOTE_PROPS = {
    48: { hollow: 1, nostem: 1 }, 36: { hollow: 1, dots: 1 }, 24: { hollow: 1 }, 18: { dots: 1 },
    12: {}, 9: { beams: 1, dots: 1 }, 6: { beams: 1 }, 3: { beams: 2 }
  };
  const REST_DURS = [48, 24, 12, 6, 3];
  const N = (d) => ({ k: 'n', d }), R = (d) => ({ k: 'r', d }), C = (b) => ({ k: 'c', b });
  const figUnits = (f) => (f.k === 'c' ? 12 : f.d);

  function figEvents(f, st) {
    if (f.k === 'c') {
      const mult = 12 / f.b.length;
      const { ev, tuplet } = rhythmEvents(f.b);
      return ev.map((e) => ({ st: st + e.start * mult, dur: e.dur * mult, rest: !!e.rest, beams: e.beams, dots: e.dots, tup: tuplet }));
    }
    if (f.k === 'r') {
      return [{ st, dur: f.d, rest: true, beams: f.d >= 12 ? 0 : f.d >= 6 ? 1 : 2, dots: 0, shape: f.d === 48 ? 'whole' : f.d === 24 ? 'half' : '', tup: 0 }];
    }
    const p = NOTE_PROPS[f.d] || {};
    return [{ st, dur: f.d, rest: false, beams: p.beams || 0, dots: p.dots || 0, hollow: !!p.hollow, nostem: !!p.nostem, tup: 0 }];
  }

  function layoutCombo(seq) {
    const bars = [];
    let cur = [], used = 0;
    seq.forEach((f, idx) => {
      cur.push({ f, idx }); used += figUnits(f);
      if (used >= BAR) { bars.push(cur); cur = []; used = 0; }
    });
    if (cur.length) bars.push(cur);
    const rows = bars.map((items) => {
      let st = 0;
      const events = [], slots = [];
      items.forEach(({ f, idx }) => {
        events.push(...figEvents(f, st));
        slots.push({ idx, st, u: figUnits(f) });
        st += figUnits(f);
      });
      return { events, slots, used: st };
    });
    return { rows, used };   // used = 最后一小节已占用的单位（0 表示刚好写满）
  }

  function sanitizeCombo(seq) {
    const out = [];
    let used = 0;
    (Array.isArray(seq) ? seq : []).forEach((f) => {
      const ok = f && ((f.k === 'n' && NOTE_PROPS[f.d]) || (f.k === 'r' && REST_DURS.includes(f.d)) ||
        (f.k === 'c' && typeof f.b === 'string' && /^[01]+$/.test(f.b) && (f.b.length === 3 || f.b.length === 4)));
      if (!ok) return;
      const u = figUnits(f);
      if (used + u > BAR) return;
      out.push(f);
      used += u;
      if (used === BAR) used = 0;
    });
    return out;
  }

  // 通用：把一串事件画成一行五线（单线）谱，按拍分组连音线，三连音自动加括号
  function drawEvents(o) {
    const { events, left, uw, lineY, beamY, bracketY } = o;
    const X = (st) => left + st * uw + 6;
    const stemX = (st) => X(st) + 4.6;
    const beamRectY = (level) => beamY + (level - 1) * 5;
    let out = '';

    const groups = [];
    let run = [];
    events.forEach((e, i) => {
      const ok = !e.rest && e.beams >= 1;
      if (ok && (!run.length || Math.floor(events[run[run.length - 1]].st / 12) === Math.floor(e.st / 12))) run.push(i);
      else {
        if (run.length >= 2) groups.push(run);
        run = ok ? [i] : [];
      }
    });
    if (run.length >= 2) groups.push(run);
    const grouped = new Set(groups.flat());
    groups.forEach((gr) => {
      for (let level = 1; level <= 3; level++) {
        gr.forEach((i, k) => {
          if (events[i].beams < level) return;
          const next = gr[k + 1], prev = gr[k - 1];
          const y = beamRectY(level);
          if (next !== undefined && events[next].beams >= level) {
            out += `<rect x="${stemX(events[i].st) - 0.7}" y="${y}" width="${stemX(events[next].st) - stemX(events[i].st) + 1.4}" height="3" fill="currentColor"/>`;
          } else if (!(prev !== undefined && events[prev].beams >= level)) {
            const right = next !== undefined;
            out += `<rect x="${right ? stemX(events[i].st) - 0.7 : stemX(events[i].st) - 6.7}" y="${y}" width="7.4" height="3" fill="currentColor"/>`;
          }
        });
      }
    });

    events.forEach((e, i) => {
      if (e.rest) {
        const cx = left + (e.st + Math.min(e.dur, 12) / 2) * uw + 2;
        if (e.shape === 'half') out += `<rect x="${cx - 6}" y="${lineY - 4.5}" width="12" height="4.5" fill="currentColor"/>`;
        else if (e.shape === 'whole') out += `<rect x="${cx - 6}" y="${lineY}" width="12" height="4.5" fill="currentColor"/>`;
        else out += `<g transform="translate(0 ${lineY - 27.5})">${restGlyph(cx, e)}</g>`;
        return;
      }
      const cx = X(e.st);
      if (e.hollow) {
        const rx = e.nostem ? 5.6 : 4.8;
        out += `<ellipse cx="${cx}" cy="${lineY}" rx="${rx}" ry="3.6" transform="rotate(-20 ${cx} ${lineY})" fill="none" stroke="currentColor" stroke-width="1.7"/>`;
      } else {
        out += `<ellipse cx="${cx}" cy="${lineY}" rx="4.8" ry="3.5" transform="rotate(-20 ${cx} ${lineY})" fill="currentColor"/>`;
      }
      if (!e.nostem) out += `<line x1="${stemX(e.st)}" y1="${lineY - 1}" x2="${stemX(e.st)}" y2="${beamY}" stroke="currentColor" stroke-width="1.5"/>`;
      if (e.beams >= 1 && !grouped.has(i)) {
        for (let level = 0; level < e.beams; level++) {
          out += `<path d="M${stemX(e.st)} ${beamY + level * 5} q 7 4 5 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
        }
      }
      if (e.dots) out += `<circle cx="${cx + 9.5}" cy="${lineY - 3}" r="1.6" fill="currentColor"/>`;
    });

    const tup = {};
    events.forEach((e) => {
      if (!e.tup) return;
      const beat = Math.floor(e.st / 12);
      const t = tup[beat] || (tup[beat] = { n: e.tup, a: e.st, b: e.st });
      t.a = Math.min(t.a, e.st); t.b = Math.max(t.b, e.st);
    });
    Object.values(tup).forEach((t) => {
      const x1 = X(t.a) - 7, x2 = X(t.b) + 8, mid = (x1 + x2) / 2, by = bracketY;
      out += `<path d="M${x1} ${by + 4} V${by} H${mid - 6} M${mid + 6} ${by} H${x2} V${by + 4}" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
      out += `<text x="${mid}" y="${by + 4.6}" text-anchor="middle" font-size="14" font-weight="700" font-style="italic" font-family="serif" fill="currentColor">${t.n}</text>`;
    });
    return out;
  }

  // 选择板上的小图标：一个图形（或一串图形）的记谱
  function miniFig(figsOrOne) {
    const list = Array.isArray(figsOrOne) ? figsOrOne : [figsOrOne];
    let st = 0;
    const events = [];
    list.forEach((f) => { events.push(...figEvents(f, st)); st += figUnits(f); });
    const uw = events.length > 1 ? Math.min(5.4, Math.max(70 / st, 3.4)) : Math.min(5.4, 70 / st);
    const left = 6, lineY = 50, W = Math.round(left * 2 + Math.max(st * uw, 26) + 10);
    const body = drawEvents({ events, left, uw, lineY, beamY: 18, bracketY: 6 });
    return `<svg viewBox="0 0 ${W} 64" width="${Math.round(W * 0.8)}" height="51" aria-hidden="true"><line x1="2" y1="${lineY}" x2="${W - 2}" y2="${lineY}" stroke="currentColor" stroke-width="1" opacity=".35"/>${body}</svg>`;
  }

  // 多小节谱面：perRow 个小节一行（竖屏 1、横屏全屏 2）；editable 时每个图形上盖一块可点区域
  const CUW = 6.4, CLEFT = 58, CRH = 112;
  function comboSvg(layout, opts) {
    const perRow = (opts && opts.perRow) || 1;
    const editable = !opts || opts.editable !== false;
    const bars = layout.rows.slice();
    if (editable && layout.used === 0) bars.push({ events: [], slots: [], used: 0 });
    if (!bars.length) bars.push({ events: [], slots: [], used: 0 });
    const nRows = Math.ceil(bars.length / perRow);
    const W = CLEFT + perRow * BAR * CUW + 18, H = nRows * CRH + 6;
    let s2 = '';
    let hits = '';
    for (let r = 0; r < nRows; r++) {
      const top = r * CRH, lineY = top + 68, beamY = lineY - 34;
      const rowBars = bars.slice(r * perRow, r * perRow + perRow);
      const xEnd = CLEFT + rowBars.length * BAR * CUW + 6;
      s2 += `<line x1="8" y1="${lineY}" x2="${xEnd}" y2="${lineY}" stroke="currentColor" stroke-width="1.2"/>`;
      s2 += `<rect x="14" y="${lineY - 9}" width="3.2" height="18" fill="currentColor"/><rect x="21" y="${lineY - 9}" width="3.2" height="18" fill="currentColor"/>`;
      if (r === 0) {
        s2 += `<text x="42" y="${lineY - 1.5}" text-anchor="middle" font-size="16" font-weight="700" font-family="serif" fill="currentColor">4</text>`;
        s2 += `<text x="42" y="${lineY + 15.5}" text-anchor="middle" font-size="16" font-weight="700" font-family="serif" fill="currentColor">4</text>`;
      }
      rowBars.forEach((bar, k) => {
        const gb = r * perRow + k;
        const left = CLEFT + k * BAR * CUW;
        const xBar = left + BAR * CUW + 3;
        const isFinal = gb === bars.length - 1;
        if (editable && isFinal && bar.used < BAR) {
          s2 += `<rect x="${left + bar.used * CUW}" y="${top + 16}" width="${(BAR - bar.used) * CUW}" height="${CRH - 34}" rx="6" fill="currentColor" opacity=".06"/>`;
        }
        s2 += `<line x1="${xBar}" y1="${lineY - 9}" x2="${xBar}" y2="${lineY + 9}" stroke="currentColor" stroke-width="1.2"/>`;
        if (isFinal) s2 += `<rect x="${xBar + 3}" y="${lineY - 9}" width="3" height="18" fill="currentColor"/>`;
        s2 += `<text x="${left + 2}" y="${top + 22}" font-size="11" fill="currentColor" opacity=".55">${gb + 1}</text>`;
        for (let b = 1; b < 4; b++) {
          const gx = left + b * 12 * CUW;
          s2 += `<line x1="${gx}" y1="${top + 18}" x2="${gx}" y2="${top + CRH - 26}" stroke="currentColor" stroke-width="1" stroke-dasharray="2 4" opacity=".22"/>`;
        }
        for (let b = 0; b < 4; b++) {
          s2 += `<text x="${left + b * 12 * CUW + 6}" y="${lineY + 34}" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" opacity=".7">${b + 1}</text>`;
        }
        s2 += `<g>${drawEvents({ events: bar.events, left, uw: CUW, lineY, beamY, bracketY: beamY - 10 })}</g>`;
        if (editable) {
          bar.slots.forEach((sl) => {
            hits += `<rect class="hit" data-idx="${sl.idx}" x="${left + sl.st * CUW}" y="${lineY - 46}" width="${sl.u * CUW}" height="84" fill="rgba(0,0,0,0.001)" style="cursor:pointer"/>`;
          });
        }
      });
    }
    s2 += `<rect class="cur" x="0" y="0" width="${3 * CUW}" height="${CRH - 34}" rx="4" fill="#ff6b4a" opacity="0" pointer-events="none"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" data-combo="1" data-left="${CLEFT}" data-uw="${CUW}" data-rh="${CRH}" data-per="${perRow}" style="width:100%;height:auto;display:block">${s2}${hits}</svg>`;
  }

  let comboCache = null;
  function comboTimeline() {
    const L = layoutCombo(s.combo);
    const hits = new Set();
    L.rows.forEach((row, b) => row.events.forEach((e) => { if (!e.rest) hits.add(b * BAR + e.st); }));
    comboCache = { hits, total: Math.max(1, L.rows.length) * BAR };
    return comboCache;
  }
  function scheduleCombo() {
    const c = comboCache || comboTimeline();
    const horizon = ctx.currentTime + 0.12;
    while (nextTime < horizon) {
      if (gstep >= c.total) gstep = 0;
      if (c.hits.has(gstep)) snare(nextTime, 0.9);
      if (s.cclick && gstep % 12 === 0) tone(nextTime, gstep % BAR === 0 ? 0 : 1, 0.45);
      queue.push({ t: nextTime, groove: true, step: gstep });
      nextTime += 60 / s.bpm / 12;
      gstep++;
    }
  }

  const PALETTE = {
    long: [N(48), N(36), N(24), N(18), N(12), N(9), N(6), N(3), R(48), R(24), R(12), R(6), R(3)],
    six: catalog(4).map((i) => i.bits).filter((b) => b !== '0000' && b !== '1000').map(C),
    trip: catalog(3).map((i) => i.bits).filter((b) => b !== '000' && b !== '100').map(C),
    // 切分：音从后半拍起、跨过拍线（一次放进去的是一串图形）
    sync: [
      C('1101'),                           // 十六分 + 八分 + 十六分（十六分切分）
      [N(6), N(12), N(6)],                 // 八分 + 四分 + 八分
      [R(6), N(12), N(6)],                 // 八分休止 + 四分 + 八分（后半拍起的四分）
      [N(6), N(12), N(12), N(6)],          // 八分 + 四分 + 四分 + 八分（连续切分）
      [N(6), N(24), N(6)],                 // 八分 + 二分 + 八分
      [R(6), N(24), N(6)],                 // 八分休止 + 二分 + 八分
      [N(9), N(9), N(6)],                  // 附点八分 + 附点八分 + 八分（3+3+2）
      [N(18), N(18), N(12)]                // 附点四分 + 附点四分 + 四分（3+3+2 八分单位）
    ]
  };
  const asList = (item) => (Array.isArray(item) ? item : [item]);
  const listUnits = (list) => list.reduce((a, f) => a + figUnits(f), 0);
  const TAB_NAMES = { long: '长音 · 休止', six: '十六分组合', trip: '三连音', sync: '切分' };
  // 用简写写谱：w 全音符 dh 附点二分 h 二分 dq 附点四分 q 四分 de 附点八分 e 八分 s 十六分；
  // 加 r 是休止（wr hr qr er sr）；cXXXX 是一拍十六分组合（1 打 0 不打），tXXX 是一拍三连音；| 只是分小节的标记
  const TOK = { w: N(48), dh: N(36), h: N(24), dq: N(18), q: N(12), de: N(9), e: N(6), s: N(3), wr: R(48), hr: R(24), qr: R(12), er: R(6), sr: R(3) };
  function P(str) {
    return str.split(/\s+/).filter((t) => t && t !== '|').map((t) => {
      if (/^c[01]{4}$/.test(t) || /^t[01]{3}$/.test(t)) return C(t.slice(1));
      if (!TOK[t]) throw new Error('未知记号 ' + t);
      return JSON.parse(JSON.stringify(TOK[t]));
    });
  }
  const preset = (cat, level, name, str) => ({ cat, level, name, seq: P(str) });

  const COMBO_PRESETS = [
    // ---- 入门时值 ----
    preset('入门时值', '入门', '二分 + 四分 + 前八后十六 | 全音符', 'h q c1011 | w'),
    preset('入门时值', '入门', '基础一：四分音符与二分音符', 'q q q q | h q q | q q h | w'),
    preset('入门时值', '入门', '基础二：八分音符', 'c1010 c1010 c1010 c1010 | q c1010 q c1010 | c1010 q c1010 q | h c1010 c1010'),
    preset('入门时值', '入门', '基础三：十六分音符', 'c1111 c1111 c1111 c1111 | q c1111 q c1111 | c1111 c1010 c1111 c1010 | c1111 q c1010 q'),
    preset('入门时值', '基础', '基础四：四分、八分、十六分混合', 'q c1010 c1111 q | c1111 q c1010 c1111 | c1010 c1010 c1111 q | q c1111 c1010 c1010'),

    // ---- 一拍组合（十六分）----
    preset('一拍组合', '基础', '四分、八分、十六分递进 | 前八后十六 / 前十六后八交替', 'q c1010 c1111 qr | c1011 c1110 c1011 c1110'),
    preset('一拍组合', '基础', '组合一：前八后十六 / 前十六后八', 'c1011 c1011 c1011 c1011 | c1110 c1110 c1110 c1110 | c1011 c1110 c1011 c1110 | c1110 c1011 c1110 c1011'),
    preset('一拍组合', '基础', '组合二：附点八分与十六分', 'c1001 c1001 c1001 c1001 | c1100 c1100 c1100 c1100 | c1001 c1100 c1001 c1100 | c1101 c1101 c1101 c1101'),
    preset('一拍组合', '进阶', '组合三：后半拍与空拍', 'c0010 c0010 c0010 c0010 | c0100 c0100 c0100 c0100 | c0001 c0001 c0001 c0001 | c0011 c0110 c0101 c0111'),
    preset('一拍组合', '进阶', '组合四：综合读谱', 'q c1111 q c1011 | c1010 c1110 c1111 c1001 | c1101 c1011 c1111 q | c1001 c1100 c1010 c1111'),

    // ---- 附点 ----
    preset('附点', '基础', '附点节奏：附点四分+八分 | 附点二分+四分', 'dq e dq e | dh q'),
    preset('附点', '基础', '附点二：附点四分、二分混合', 'dq e dq e | dh q | dq e q q | h dq e'),
    preset('附点', '进阶', '附点三：附点八分 + 十六分', 'de s de s de s de s | q de s q q'),

    // ---- 切分 ----
    preset('切分', '入门', '切分入门：十六分 + 八分 + 十六分', 'c1101 c1101 c1101 c1101 | q c1101 q c1101 | c1101 q c1101 q | c1101 c1101 h'),
    preset('切分', '基础', '切分一：八分+四分+八分 | 后半拍起的四分、二分', 'e q e e q e | er q e h'),
    preset('切分', '进阶', '切分二：十六分切分 | 连续切分', 'c1101 c1101 c1101 c1101 | e q q e q'),
    preset('切分', '基础', '切分三：后半拍起', 'er q e er q e | er h e q | e q e e q e | q e q e q'),
    preset('切分', '进阶', '切分四：十六分切分与八分切分', 'c1101 q c1101 q | c1011 c1101 c1011 c1101 | e q e c1101 c1101 | c0110 c0110 c0110 c0110'),
    preset('切分', '基础', '跳拍练习：1 2 X 4（空第 3 拍）', 'q q qr q | q q qr q | c1010 c1010 qr q | c1111 c1111 qr q'),

    // ---- 三连音 ----
    preset('三连音', '基础', '三连音混合 | 摇摆八分', 't111 t111 q q | t101 t101 t101 t101'),
    preset('三连音', '基础', '三连音入门', 't111 t111 t111 t111 | q t111 q t111 | t111 q t111 q | t111 t111 h'),
    preset('三连音', '进阶', '摇摆八分读谱（Shuffle）', 't101 t101 t101 t101 | q t101 q t101 | t101 t101 t110 t011 | t111 t101 t111 t101'),
    preset('三连音', '进阶', '三连音缺音', 't110 t011 t010 t001 | t110 t110 t011 t011 | t101 t010 t101 t001 | t111 t110 t011 t111'),

    // ---- 休止 ----
    preset('休止', '入门', '休止入门', 'q qr q qr | qr q qr q | q q hr | h qr q'),
    preset('休止', '基础', '休止符组合', 'q qr q qr | h qr c1011'),
    preset('休止', '基础', '休止二：空拍与半小节休止', 'qr q qr q | q qr q qr | hr h | c1111 qr c1010 qr'),
    preset('休止', '进阶', '休止三：八分休止与后半拍', 'er e er e er e er e | e er e er e er e er | q er e er e q | er e q er e q'),

    // ---- 老师谱 ----
    // 老师手绘谱（照片识读版）：看清的拍已录入，没看清的先空成四分休止，点谱面上的那一拍替换即可
    preset('老师谱', '基础', '老师练习谱（识读版，空拍待补）',
      'q c1111 q c1011 | c1010 c1110 c1111 c1001 | c1101 qr c1111 q | qr qr c1111 q | qr qr qr qr | qr qr qr qr')
  ];
  COMBO_PRESETS.forEach((p) => {
    const units = p.seq.reduce((a, f) => a + (f.k === 'c' ? 12 : f.d), 0);
    if (units % 48 !== 0) console.error('preset not whole bars', p.name, units);
  });
  s.combo = sanitizeCombo(s.combo && s.combo.length ? s.combo : COMBO_PRESETS[0].seq);

  // 横屏（宽度 ≥ 640）每行排 2 小节，竖屏 1 小节
  const wideMq = window.matchMedia('(min-width: 640px)');
  const comboPerRow = () => (wideMq.matches ? 2 : 1);
  function renderComboScore(layout) {
    const host = $('cSvgHost');
    host.innerHTML = comboSvg(layout || layoutCombo(s.combo), { perRow: comboPerRow(), editable: true });
    setCursor('inline', host.firstElementChild);
  }

  function comboChanged() {
    comboCache = null;
    save();
    renderCombo();
  }
  function renderCombo() {
    const layout = layoutCombo(s.combo);
    renderComboScore(layout);
    renderMine();
    renderStatus();
    const remaining = layout.used === 0 ? BAR : BAR - layout.used;
    $('cRemain').textContent = `当前小节还能放 ${remaining / 12} 拍`;
    $('cHint').textContent = s.combo.length ? '' : '先从下面选几个时值放进来';
    $('cClick').checked = s.cclick;

    const segs = (el, items, current, attr) => {
      el.innerHTML = '';
      items.forEach(([k, label]) => {
        const b = document.createElement('button');
        b.dataset[attr] = k;
        b.className = String(k) === String(current) ? 'on' : '';
        b.textContent = label;
        el.appendChild(b);
      });
    };
    segs($('cTabs'), Object.keys(TAB_NAMES).map((k) => [k, TAB_NAMES[k]]), s.ctab, 'tab');
    segs($('rBars'), [2, 4, 6, 8].map((n) => [n, `${n} 小节`]), s.rbars, 'n');
    segs($('rDiff'), Object.keys(RAND_LEVELS).map((k) => [k, RAND_LEVELS[k]]), s.rdiff, 'lv');

    const pal = $('cPalette');
    pal.innerHTML = '';
    PALETTE[s.ctab].forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.i = i;
      b.disabled = listUnits(asList(f)) > remaining;
      b.innerHTML = miniFig(f);
      pal.appendChild(b);
    });
    renderGrouped($('cPresets'), 'combo', COMBO_PRESETS, -1, (p, i) => {
      const b = document.createElement('button');
      b.className = 'g-item';
      b.dataset.i = i;
      b.innerHTML = `<span class="g-name">${p.name}</span><span class="g-level lv-${p.level}">${p.level}</span>`;
      return b;
    });
  }
  $('cTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    s.ctab = b.dataset.tab;
    save();
    renderCombo();
  });
  // 所有会改动谱子的操作都走 commit：先把改动前的样子存进历史，"撤销"就能一步步退回
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function commit(nextSeq, opts) {
    s.hist = (s.hist || []).concat([JSON.stringify({ seq: s.combo, cur: s.curMine })]).slice(-30);
    s.combo = nextSeq;
    if (opts && 'cur' in opts) s.curMine = opts.cur;
    comboChanged();
  }
  let flashTimer = null;
  function flash(msg) {
    $('cStatus').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(renderStatus, 2600);
  }
  function renderStatus() {
    const cur = s.mine.find((m) => m.id === s.curMine);
    let text = '';
    if (cur) text = JSON.stringify(cur.seq) === JSON.stringify(s.combo) ? `「${cur.name}」已保存` : `「${cur.name}」有修改，点“保存”更新`;
    else if (s.combo.length) text = '这一页还没保存，点“保存”存下来';
    $('cStatus').textContent = text;
  }
  function renderMine() {
    const host = $('cMine');
    host.innerHTML = '';
    if (!s.mine.length) {
      host.innerHTML = '<div class="mine-empty">还没有保存的谱</div>';
      return;
    }
    s.mine.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'g-item mine' + (m.id === s.curMine ? ' active' : '');
      row.dataset.id = m.id;
      const bars = layoutCombo(sanitizeCombo(m.seq)).rows.length;
      row.innerHTML = `<span class="g-name">${m.name.replace(/[<>&]/g, '')}<small>${bars} 小节</small></span><button class="mine-del" data-del="${m.id}" aria-label="删除">✕</button>`;
      host.appendChild(row);
    });
  }
  function saveAs() {
    if (!s.combo.length) { flash('先拼好内容再保存'); return; }
    const def = `我的练习 ${s.mine.length + 1}`;
    const name = window.prompt('给这一页谱起个名字', def);
    if (name === null) return;
    const m = { id: Date.now().toString(36), name: name.trim() || def, seq: clone(s.combo) };
    s.mine.unshift(m);
    s.curMine = m.id;
    comboChanged();
    flash(`已保存「${m.name}」`);
  }

  $('cPalette').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    commit(s.combo.concat(clone(asList(PALETTE[s.ctab][Number(b.dataset.i)]))));
  });
  $('cUndo').addEventListener('click', () => {
    const last = (s.hist || []).pop();
    if (!last) { flash('没有可以撤销的操作了'); return; }
    const prev = JSON.parse(last);
    s.combo = sanitizeCombo(prev.seq);
    s.curMine = prev.cur;
    comboChanged();
  });
  $('cClear').addEventListener('click', () => { if (s.combo.length) commit([], { cur: null }); });
  $('cPresets').addEventListener('click', (e) => {
    const b = e.target.closest('.g-item');
    if (b) commit(sanitizeCombo(COMBO_PRESETS[Number(b.dataset.i)].seq), { cur: null });
  });
  $('cSave').addEventListener('click', () => {
    const m = s.mine.find((x) => x.id === s.curMine);
    if (!m) { saveAs(); return; }
    if (!s.combo.length) { flash('内容是空的，没有保存'); return; }
    m.seq = clone(s.combo);
    comboChanged();
    flash(`已保存「${m.name}」`);
  });
  $('cSaveAs').addEventListener('click', saveAs);
  $('cMine').addEventListener('click', (e) => {
    const del = e.target.closest('.mine-del');
    if (del) {
      const m = s.mine.find((x) => x.id === del.dataset.del);
      if (m && window.confirm(`删除「${m.name}」吗？`)) {
        s.mine = s.mine.filter((x) => x.id !== m.id);
        if (s.curMine === m.id) s.curMine = null;
        comboChanged();
      }
      return;
    }
    const row = e.target.closest('.mine');
    if (!row) return;
    const m = s.mine.find((x) => x.id === row.dataset.id);
    if (m) commit(sanitizeCombo(m.seq), { cur: m.id });
  });
  $('cClick').addEventListener('change', (e) => { s.cclick = e.target.checked; save(); });

  // 点谱面上的某一拍：换成同样长度的其他图形（小节不会被打乱）
  const restsFor = (u) => {
    const out = [];
    let left = u;
    REST_DURS.forEach((d) => { while (left >= d) { out.push(R(d)); left -= d; } });
    return left === 0 ? out : [];
  };
  function replaceOptions(fig) {
    const u = figUnits(fig);
    const opts = [];
    Object.values(PALETTE).forEach((list) => list.forEach((item) => {
      const figs = asList(item);
      if (listUnits(figs) === u && JSON.stringify(figs) !== JSON.stringify([fig])) opts.push(figs);
    }));
    if (!REST_DURS.includes(u)) { const rs = restsFor(u); if (rs.length) opts.push(rs); }
    return opts;
  }
  function openReplaceSheet(idx) {
    const fig = s.combo[idx];
    if (!fig) return;
    $('sheetTitle').textContent = `第 ${idx + 1} 个图形：换成（占 ${figUnits(fig) / 12} 拍）`;
    const list = $('sheetList');
    list.innerHTML = '';
    replaceOptions(fig).forEach((figs) => {
      const row = document.createElement('button');
      row.className = 'sheet-row';
      row.innerHTML = miniFig(figs);
      row.addEventListener('click', () => {
        const next = JSON.parse(JSON.stringify(s.combo));
        next.splice(idx, 1, ...JSON.parse(JSON.stringify(figs)));
        closeSheet();
        commit(next);
      });
      list.appendChild(row);
    });
    sheet.hidden = false;
  }
  $('cSvgHost').addEventListener('click', (e) => {
    const hit = e.target.closest('.hit');
    if (hit) openReplaceSheet(Number(hit.dataset.idx));
  });

  // 随机出一页：每拍从一拍组合里抽一个，每小节最多一拍休止
  const RAND_LEVELS = { basic: '基础', adv: '进阶', trip: '含三连音' };
  function randPool(level) {
    const w = (f, n) => ({ f, n });
    const basic = [w(N(12), 3), w(C('1010'), 3), w(C('1111'), 2), w(C('1011'), 2), w(C('1110'), 2), w(R(12), 1)];
    if (level === 'basic') return basic;
    const adv = [w(N(12), 2), w(R(12), 1)].concat(PALETTE.six.map((f) => w(f, 1)));
    if (level === 'adv') return adv;
    return adv.concat(PALETTE.trip.map((f) => w(f, 1)));
  }
  function randomSheet(bars, level) {
    const pool = randPool(level);
    const total = pool.reduce((a, p) => a + p.n, 0);
    const pick = () => {
      let r = Math.random() * total;
      for (const p of pool) { r -= p.n; if (r < 0) return p.f; }
      return pool[0].f;
    };
    const out = [];
    for (let b = 0; b < bars; b++) {
      let bar;
      do { bar = [pick(), pick(), pick(), pick()]; } while (bar.filter((f) => f.k === 'r').length > 1);
      bar.forEach((f) => out.push(JSON.parse(JSON.stringify(f))));
    }
    return out;
  }
  $('rBars').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { s.rbars = Number(b.dataset.n); save(); renderCombo(); }
  });
  $('rDiff').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { s.rdiff = b.dataset.lv; save(); renderCombo(); }
  });
  $('rGo').addEventListener('click', () => commit(randomSheet(s.rbars, s.rdiff), { cur: null }));

  const LEGEND_GROOVE ='<span><b>×</b> 踩镲（线上方）</span><span><b>×</b>上带圈 开镲</span><span><b>●</b> 军鼓（第 3 间）</span><span><b>●</b> 底鼓（第 1 间，符干朝下）</span>';
  const LEGEND_PAD = '<span><b>R</b> 右手　<b>L</b> 左手</span><span><b>&gt;</b> 重音</span><span>单线谱：符头都打在鼓垫上</span>';

  const LEGEND_COMBO = '<span>每行按屏幕宽度排 1 到 2 个小节</span><span>橙色竖条是当前播放位置</span>';

  // 高亮竖条：页面里的谱和全屏谱各有一条，同时移动
  let cursors = [];
  function setCursor(kind, svg) {
    cursors = cursors.filter((c) => c.kind !== kind);
    const el = svg && svg.querySelector('.cur');
    if (!el) return;
    const left = Number(svg.dataset.left);
    if (svg.dataset.combo) {
      const uw = Number(svg.dataset.uw), rh = Number(svg.dataset.rh), per = Number(svg.dataset.per);
      cursors.push({
        kind, el,
        move: (u) => {
          if (u < 0) { el.setAttribute('opacity', '0'); return; }
          const bar = Math.floor(u / BAR), off = u % BAR;
          el.setAttribute('x', left + (bar % per) * BAR * uw + off * uw);
          el.setAttribute('y', Math.floor(bar / per) * rh + 16);
          el.setAttribute('opacity', '0.3');
        }
      });
    } else {
      const sw = Number(svg.dataset.sw);
      cursors.push({
        kind, el,
        move: (step) => {
          if (step < 0) { el.setAttribute('opacity', '0'); return; }
          el.setAttribute('x', left + step * sw);
          el.setAttribute('opacity', '0.28');
        }
      });
    }
  }
  function moveScoreCursor(step) { cursors.forEach((c) => c.move(step)); }

  function renderScore() {
    if (s.mode === 'combo') {
      const layout = layoutCombo(s.combo);
      $('scoreTitle').textContent = '变速练习';
      $('scoreSub').textContent = `${layout.rows.length} 小节 · 4/4 拍`;
      $('scoreLegend').innerHTML = LEGEND_COMBO;
      const host = $('scoreSvgHost');
      host.innerHTML = comboSvg(layout, { perRow: comboPerRow(), editable: false });
      setCursor('overlay', host.firstElementChild);
      return;
    }
    const isPad = s.mode === 'pad';
    const g = isPad ? (PADS.find((x) => x.id === s.pad) || PADS[0]) : (GROOVES.find((x) => x.id === s.groove) || GROOVES[0]);
    $('scoreTitle').textContent = g.name;
    $('scoreSub').textContent = `${g.level} · ${g.beats}/4 拍`;
    $('scoreLegend').innerHTML = isPad ? LEGEND_PAD : LEGEND_GROOVE;
    const host = $('scoreSvgHost');
    host.innerHTML = isPad ? padSvg(g) : scoreSvg(g);
    setCursor('overlay', host.firstElementChild);
  }
  ['openScore', 'openPadScore', 'openComboScore'].forEach((id) =>
    $(id).addEventListener('click', () => { renderScore(); $('score').hidden = false; }));
  // 转屏（宽度跨过 640）时重排：横屏每行 2 小节，竖屏 1 小节
  const onWideChange = () => {
    if (s.mode !== 'combo') return;
    renderComboScore();
    if (!$('score').hidden) renderScore();
  };
  if (wideMq.addEventListener) wideMq.addEventListener('change', onWideChange);
  else wideMq.addListener(onWideChange);
  window.addEventListener('resize', onWideChange);
  window.addEventListener('orientationchange', onWideChange);
  $('scoreClose').addEventListener('click', () => { $('score').hidden = true; });
  $('scorePlay').addEventListener('click', () => (playing ? stop() : start()));
  document.querySelectorAll('[data-sbpm]').forEach((btn) =>
    btn.addEventListener('click', () => setBpm(s.bpm + Number(btn.dataset.sbpm))));

  // 声画同步校准：高亮比声音早就把数值调大，蓝牙耳机通常要 150 到 250 毫秒
  function renderAv() {
    $('avSlider').value = s.avOffset;
    $('avVal').textContent = `${s.avOffset > 0 ? '+' : ''}${s.avOffset} ms`;
    const auto = Math.round(autoLatency() * 1000);
    $('avTip').textContent = (ctx ? `设备报告的输出延迟 ${auto} ms，已自动补偿。` : '开始播放后会显示设备报告的输出延迟，并自动补偿。') +
      '如果高亮比声音早，把数值调大；比声音晚，调小。';
  }
  $('avSlider').addEventListener('input', (e) => { s.avOffset = Number(e.target.value); save(); renderAv(); });
  $('syncBox').addEventListener('toggle', renderAv);

  renderAll();
  renderPlay();
  applyMode();
  renderAv();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
})();
