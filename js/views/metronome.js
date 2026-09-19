// Metronome view: quick mode (ad-hoc single tempo) + plan mode (plays a saved
// multi-section practice plan). Owns the one live Engine instance for the app.
(function (root) {
  const ACCENT_LABEL = ['静', '弱', '中', '强'];

  const View = {
    mode: 'quick',
    quick: null,
    patterns: [],
    plans: [],
    activePlan: null,
    playing: false,
    engine: null,
    beatCellEls: [],
    gridCellEls: [],
    tapTimes: [],

    mount(container) {
      this.container = container;
      container.addEventListener('click', (e) => this._onClick(e));
      container.addEventListener('input', (e) => this._onInput(e));
      container.addEventListener('change', (e) => this._onChange(e));
    },

    async onShow() {
      this.patterns = await Storage.getPatterns();
      this.plans = await Storage.getPlans();
      if (!this.playing) {
        this.quick = await Storage.getQuickState();
        this.render();
      }
    },

    onHide() {
      this._stopEngine();
      WakeLock.release();
    },

    render() {
      const c = this.container;
      c.innerHTML = `
        <div class="row" style="justify-content:center;gap:8px;margin:12px 0 4px;">
          <button class="pill ${this.mode === 'quick' ? 'active' : ''}" data-action="switchMode" data-mode="quick">快速模式</button>
          <button class="pill ${this.mode === 'plan' ? 'active' : ''}" data-action="switchMode" data-mode="plan">计划模式</button>
        </div>
        <div id="mode-panel"></div>
        <div id="grid-panel"></div>
        <div style="height:8px;"></div>
        <button id="play-btn" class="btn-primary play-fab" data-action="togglePlay">${this.playing ? '■ 停止' : '▶ 开始'}</button>
      `;
      this.mode === 'quick' ? this._renderQuick() : this._renderPlan();
      this._renderGrid();
    },

    _renderQuick() {
      const q = this.quick;
      const panel = this.container.querySelector('#mode-panel');
      const patternOptions = ['<option value="">无（纯节拍）</option>']
        .concat(this.patterns.map(p => `<option value="${p.id}" ${p.id === q.drumPatternId ? 'selected' : ''}>${UI.escapeHtml(p.name)}</option>`)).join('');
      panel.innerHTML = `
        <div class="card bpm-display">
          <div class="bpm-number" id="bpm-number">${Math.round(q.bpm)}</div>
          <div class="bpm-unit">BPM</div>
          <input type="range" min="20" max="300" value="${q.bpm}" data-bind="quick.bpm">
          <div class="row-between" style="margin-top:8px;gap:8px;">
            <button class="btn-secondary" data-action="bumpBpm" data-delta="-5" style="width:56px;">-5</button>
            <button class="btn-secondary" data-action="bumpBpm" data-delta="-1" style="width:56px;">-1</button>
            <button class="btn-primary" data-action="tapTempo" style="flex:1;">TAP 打拍</button>
            <button class="btn-secondary" data-action="bumpBpm" data-delta="1" style="width:56px;">+1</button>
            <button class="btn-secondary" data-action="bumpBpm" data-delta="5" style="width:56px;">+5</button>
          </div>
        </div>

        <div class="card">
          <div class="row-between">
            <div class="title">拍号</div>
            <div class="row gap-8">
              <button class="mini-btn" data-action="changeBeatsPerBar" data-delta="-1">-</button>
              <span style="width:70px;text-align:center;">${q.beatsPerBar} / ${q.noteValue}</span>
              <button class="mini-btn" data-action="changeBeatsPerBar" data-delta="1">+</button>
            </div>
          </div>
          <div class="row gap-8" style="margin-top:12px;">
            <button class="pill ${q.noteValue === 4 ? 'active' : ''}" data-action="setNoteValue" data-value="4">四分音符为一拍</button>
            <button class="pill ${q.noteValue === 8 ? 'active' : ''}" data-action="setNoteValue" data-value="8">八分音符为一拍</button>
          </div>
        </div>

        <div class="card">
          <div class="title">重音型（点击切换 静/弱/中/强）</div>
          <div class="row wrap gap-8" id="quick-beat-cells" style="margin-top:12px;"></div>
        </div>

        <div class="card">
          <div class="row-between">
            <div class="title">随机静音训练</div>
            <label class="switch"><input type="checkbox" data-action="toggleQuickMute" ${q.randomMute.enabled ? 'checked' : ''}><span class="track"></span></label>
          </div>
          ${q.randomMute.enabled ? `
            <div class="subtitle" style="margin-top:10px;">静音概率：${Math.round(q.randomMute.probability * 100)}%</div>
            <input type="range" min="0" max="100" value="${Math.round(q.randomMute.probability * 100)}" data-bind="quick.randomMute.probability">
          ` : ''}
        </div>

        <div class="card">
          <div class="row-between">
            <div class="title">同步鼓谱型</div>
            <select data-bind="quick.drumPatternId">${patternOptions}</select>
          </div>
        </div>
      `;
      this._renderBeatCells(panel.querySelector('#quick-beat-cells'), q.accentPattern, true);
    },

    _renderPlan() {
      const panel = this.container.querySelector('#mode-panel');
      const planOptions = ['<option value="">选择一个练习计划…</option>']
        .concat(this.plans.map(p => `<option value="${p.id}" ${this.activePlan && p.id === this.activePlan.id ? 'selected' : ''}>${UI.escapeHtml(p.name)}</option>`)).join('');
      panel.innerHTML = `
        <div class="card">
          <select data-action="pickPlan" style="width:100%;">${planOptions}</select>
          ${this.activePlan ? `<div class="subtitle" style="margin-top:8px;">${this.activePlan.sections.length} 个段落${this.activePlan.loop ? ' · 循环播放' : ''}</div>` : ''}
        </div>
        ${this.activePlan ? `
          <div class="card bpm-display">
            <div class="bpm-number" id="bpm-number">${Math.round(this._planBpm())}</div>
            <div class="bpm-unit" id="plan-section-label">BPM · ${UI.escapeHtml(this.activePlan.sections[0].name)}</div>
            <div class="subtitle" id="plan-bar-label" style="margin-top:6px;">&nbsp;</div>
            <div class="row wrap gap-8" id="plan-beat-cells" style="justify-content:center;margin-top:14px;"></div>
          </div>
        ` : `<div class="empty-tip">还没有练习计划\n去"练习计划"标签页新建一个吧</div>`}
      `;
      if (this.activePlan) this._renderBeatCells(panel.querySelector('#plan-beat-cells'), this.activePlan.sections[0].accentPattern, false);
    },

    _planBpm() {
      const s = this.activePlan.sections[0];
      return s.isRamp ? s.bpmFrom : s.bpm;
    },

    _renderBeatCells(host, accentPattern, editable) {
      if (!host) return;
      host.innerHTML = '';
      this.beatCellEls = accentPattern.map((level, idx) => {
        const el = document.createElement('div');
        el.className = `beat-cell level-${level}`;
        el.textContent = ACCENT_LABEL[level];
        if (editable) { el.dataset.action = 'toggleBeatCell'; el.dataset.idx = idx; }
        host.appendChild(el);
        return el;
      });
    },

    _renderGrid() {
      const host = this.container.querySelector('#grid-panel');
      let pattern = null;
      if (this.mode === 'quick' && this.quick.drumPatternId) pattern = this.patterns.find(p => p.id === this.quick.drumPatternId);
      else if (this.mode === 'plan' && this.activePlan) {
        const first = this.activePlan.sections[0];
        if (first && first.drumPatternId) pattern = this.patterns.find(p => p.id === first.drumPatternId);
      }
      if (!pattern) { host.innerHTML = ''; this.gridCellEls = []; return; }
      host.innerHTML = `<div class="card"><div class="title" style="margin-bottom:12px;">鼓谱同步显示</div>
        ${['hihat', 'snare', 'kick'].map(t => `
          <div class="grid-row">
            <span class="grid-label">${t === 'hihat' ? 'Hi-Hat' : t === 'snare' ? 'Snare' : 'Kick'}</span>
            <div class="grid-cells" data-track="${t}"></div>
          </div>`).join('')}
      </div>`;
      this.gridCellEls = { hihat: [], snare: [], kick: [] };
      ['hihat', 'snare', 'kick'].forEach(track => {
        const row = host.querySelector(`.grid-cells[data-track="${track}"]`);
        pattern.tracks[track].forEach((on, i) => {
          const cell = document.createElement('div');
          cell.className = `grid-cell ${on ? 'on-' + track : ''} ${i % (pattern.stepsPerBar / 4) === 0 ? 'beat-start' : ''}`;
          row.appendChild(cell);
          this.gridCellEls[track].push(cell);
        });
      });
    },

    // ---------- event handling ----------
    _onClick(e) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (this[action]) this[action](el, e);
    },
    _onInput(e) {
      const el = e.target.closest('[data-bind]');
      if (!el) return;
      this._handleBind(el, true);
    },
    _onChange(e) {
      const el = e.target.closest('[data-bind]');
      if (el) { this._handleBind(el, false); return; }
      const actionEl = e.target.closest('[data-action]');
      if (actionEl && actionEl.tagName === 'INPUT' && actionEl.type === 'checkbox') {
        if (this[actionEl.dataset.action]) this[actionEl.dataset.action](actionEl, e);
      }
    },
    _handleBind(el, isLive) {
      const path = el.dataset.bind; // e.g. quick.bpm | quick.randomMute.probability | quick.drumPatternId
      const parts = path.split('.');
      let value = el.type === 'range' ? Number(el.value) : el.value;
      if (path.endsWith('probability')) value = value / 100;
      const patch = {};
      let cursor = patch;
      for (let i = 1; i < parts.length - 1; i++) { cursor[parts[i]] = {}; cursor = cursor[parts[i]]; }
      cursor[parts[parts.length - 1]] = value;
      this._updateQuickDeep(patch);
      if (path === 'quick.bpm') {
        const disp = this.container.querySelector('#bpm-number');
        if (disp) disp.textContent = Math.round(value);
      }
      if (!isLive && path === 'quick.drumPatternId') this._renderGrid();
    },
    _updateQuickDeep(patch) {
      this.quick = deepMerge(this.quick, patch);
      Storage.saveQuickState(this.quick);
      if (this.mode === 'quick' && this.playing) this._restartQuickEngine();
    },

    switchMode(el) {
      const mode = el.dataset.mode;
      if (mode === this.mode) return;
      this._stopEngine();
      this.mode = mode;
      this.playing = false;
      this.render();
    },

    bumpBpm(el) {
      const delta = Number(el.dataset.delta);
      const bpm = Math.min(300, Math.max(20, Math.round(this.quick.bpm) + delta));
      this._updateQuickDeep({ bpm });
      this._renderQuick();
    },
    tapTempo() {
      const now = performance.now();
      this.tapTimes = this.tapTimes.filter(t => now - t < 2500);
      this.tapTimes.push(now);
      if (this.tapTimes.length >= 2) {
        const gaps = [];
        for (let i = 1; i < this.tapTimes.length; i++) gaps.push(this.tapTimes[i] - this.tapTimes[i - 1]);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const bpm = Math.min(300, Math.max(20, Math.round(60000 / avg)));
        this._updateQuickDeep({ bpm });
        this._renderQuick();
      }
      if (navigator.vibrate) navigator.vibrate(10);
    },
    changeBeatsPerBar(el) {
      const delta = Number(el.dataset.delta);
      const beatsPerBar = Math.min(12, Math.max(1, this.quick.beatsPerBar + delta));
      const accentPattern = RhythmMath.defaultAccentPattern(beatsPerBar)
        .map((v, i) => i < this.quick.accentPattern.length ? this.quick.accentPattern[i] : v);
      this._updateQuickDeep({ beatsPerBar, accentPattern });
      this._renderQuick();
    },
    setNoteValue(el) {
      this._updateQuickDeep({ noteValue: Number(el.dataset.value) });
      this._renderQuick();
    },
    toggleBeatCell(el) {
      const idx = Number(el.dataset.idx);
      const pattern = this.quick.accentPattern.slice();
      pattern[idx] = (pattern[idx] + 1) % 4;
      this._updateQuickDeep({ accentPattern: pattern });
      this._renderQuick();
    },
    toggleQuickMute(el) {
      this._updateQuickDeep({ randomMute: { enabled: el.checked, probability: this.quick.randomMute.probability } });
      this._renderQuick();
    },

    async pickPlan(el) {
      const id = el.value;
      this.activePlan = id ? await Storage.getPlan(id) : null;
      this._stopEngine();
      this.playing = false;
      this._renderPlan();
      this._renderGrid();
    },

    async togglePlay() {
      if (this.playing) {
        this._stopEngine();
        this.playing = false;
        this._syncPlayButton();
        return;
      }
      const state = await AudioEngine.resume();
      if (state !== 'running') { UI.toast('音频未解锁，请先点开头的“点击开始”'); return; }
      this._startEngine();
    },

    _patternsById() {
      const map = {};
      this.patterns.forEach(p => { map[p.id] = p; });
      return map;
    },

    _startEngine() {
      let sections, loop;
      if (this.mode === 'quick') {
        const q = this.quick;
        sections = [{
          id: 'quick', name: '快速节拍', isRamp: false, bpm: q.bpm,
          beatsPerBar: q.beatsPerBar, noteValue: q.noteValue, bars: Infinity,
          accentPattern: q.accentPattern, randomMute: q.randomMute, drumPatternId: q.drumPatternId
        }];
        loop = true;
      } else {
        if (!this.activePlan) { UI.toast('请先选择一个练习计划'); return; }
        sections = this.activePlan.sections;
        loop = this.activePlan.loop;
      }
      Storage.getPrefs().then(prefs => {
        AudioEngine.setVolume('click', prefs.clickVolume);
        AudioEngine.setVolume('pattern', prefs.patternVolume);
        this.engine = new Engine({
          sections, loop,
          patternsById: this._patternsById(),
          vibrationEnabled: prefs.vibrationEnabled,
          onBeat: (info) => this._onBeat(info),
          onStep: (info) => this._onStep(info),
          onSectionChange: (info) => this._onSectionChange(info),
          onFinish: () => { this.playing = false; this._syncPlayButton(); UI.toast('计划已完成'); WakeLock.release(); }
        });
        this.engine.start();
        WakeLock.acquire();
      });
      this.playing = true;
      this._syncPlayButton();
    },
    _restartQuickEngine() { this._stopEngine(); this._startEngine(); },
    _stopEngine() {
      if (this.engine) { this.engine.stop(); this.engine = null; }
    },
    _syncPlayButton() {
      const btn = this.container.querySelector('#play-btn');
      if (btn) btn.textContent = this.playing ? '■ 停止' : '▶ 开始';
    },

    _onBeat(info) {
      this.beatCellEls.forEach((el, i) => el.classList.toggle('current', i === info.beatIdx));
      const bpmEl = this.container.querySelector('#bpm-number');
      if (bpmEl) bpmEl.textContent = info.bpm;
      if (this.mode === 'plan') {
        const barLabel = this.container.querySelector('#plan-bar-label');
        if (barLabel) barLabel.textContent = info.bars === Infinity ? `第 ${info.barIdx + 1} 小节` : `第 ${info.barIdx + 1}/${info.bars} 小节`;
      }
    },
    _onStep(info) {
      if (!this.gridCellEls || !this.gridCellEls.hihat) return;
      ['hihat', 'snare', 'kick'].forEach(track => {
        this.gridCellEls[track].forEach((el, i) => el.classList.toggle('cursor', i === info.stepIndex));
      });
    },
    _onSectionChange(info) {
      if (this.mode !== 'plan') return;
      const label = this.container.querySelector('#plan-section-label');
      if (label) label.textContent = `BPM · ${info.section.name}`;
      const host = this.container.querySelector('#plan-beat-cells');
      this._renderBeatCells(host, info.section.accentPattern, false);
      this._renderGrid();
    }
  };

  function deepMerge(target, patch) {
    const out = Object.assign({}, target);
    Object.keys(patch).forEach(k => {
      if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && target[k] && typeof target[k] === 'object') {
        out[k] = deepMerge(target[k], patch[k]);
      } else {
        out[k] = patch[k];
      }
    });
    return out;
  }

  root.MetronomeView = View;
}(typeof window !== 'undefined' ? window : globalThis));
