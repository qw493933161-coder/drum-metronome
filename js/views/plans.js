// Practice plan list + full-screen section editor overlay.
(function (root) {
  const RM = root.RhythmMath;
  const ACCENT_LABEL = ['静', '弱', '中', '强'];

  const View = {
    plans: [],
    patterns: [],

    mount(container) {
      this.container = container;
      container.addEventListener('click', (e) => this._onListClick(e));
    },

    async onShow() {
      this.plans = await Storage.getPlans();
      this.patterns = await Storage.getPatterns();
      this.render();
    },
    onHide() {},

    render() {
      const c = this.container;
      c.innerHTML = `
        ${this.plans.map(p => `
          <div class="card row-between" data-open="${p.id}">
            <div>
              <div class="title">${UI.escapeHtml(p.name)}</div>
              <div class="subtitle">${p.sections.length} 个段落${p.loop ? ' · 循环播放' : ''}</div>
            </div>
            <div class="row gap-8">
              <button class="btn-secondary" data-dup="${p.id}">复制</button>
              <button class="btn-danger" data-del="${p.id}">删除</button>
            </div>
          </div>
        `).join('')}
        ${!this.plans.length ? '<div class="empty-tip">还没有练习计划\n点击下方按钮创建一个吧</div>' : ''}
        <div style="height:12px;"></div>
        <button class="btn-primary play-fab" data-create>+ 新建练习计划</button>
      `;
    },

    async _onListClick(e) {
      const create = e.target.closest('[data-create]');
      const dup = e.target.closest('[data-dup]');
      const del = e.target.closest('[data-del]');
      const open = e.target.closest('[data-open]');
      if (create) {
        const plan = Storage.newPlan({});
        await Storage.savePlan(plan);
        this._openEditor(plan.id);
      } else if (dup) {
        const src = await Storage.getPlan(dup.dataset.dup);
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = Storage.uid();
        copy.name = src.name + ' 副本';
        copy.sections.forEach(s => { s.id = Storage.uid(); });
        await Storage.savePlan(copy);
        this.plans = await Storage.getPlans();
        this.render();
      } else if (del) {
        const plan = await Storage.getPlan(del.dataset.del);
        if (confirm(`确定删除「${plan.name}」吗？`)) {
          await Storage.deletePlan(del.dataset.del);
          this.plans = await Storage.getPlans();
          this.render();
        }
      } else if (open) {
        this._openEditor(open.dataset.open);
      }
    },

    async _openEditor(id) {
      const plan = await Storage.getPlan(id);
      const close = UI.openOverlay(this._editorHtml(plan), () => this.onShow());
      this._wireEditor(plan);
    },

    _editorHtml(plan) {
      return `
        ${UI.overlayHeaderHtml(`<input class="overlay-title-input" id="plan-name-input" value="${UI.escapeHtml(plan.name)}">`)}
        <div class="overlay-body" id="plan-editor-body"></div>
      `;
    },

    _wireEditor(plan) {
      const nameInput = document.getElementById('plan-name-input');
      nameInput.addEventListener('blur', () => { plan.name = nameInput.value || '未命名计划'; Storage.savePlan(plan); });

      const body = document.getElementById('plan-editor-body');
      const save = () => { Storage.savePlan(plan); renderBody(); };

      const patternOptions = (selectedId) => ['<option value="">无（纯节拍）</option>']
        .concat(this.patterns.map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${UI.escapeHtml(p.name)}</option>`)).join('');

      const renderBody = () => {
        body.innerHTML = `
          <div class="card row-between">
            <div class="subtitle">播放到最后一段后循环整个计划</div>
            <label class="switch"><input type="checkbox" id="plan-loop" ${plan.loop ? 'checked' : ''}><span class="track"></span></label>
          </div>
          ${plan.sections.map((s, idx) => sectionHtml(s, idx, plan.sections.length)).join('')}
          <div class="card" style="text-align:center;color:var(--accent);cursor:pointer;" id="add-section">+ 添加段落</div>
        `;
        wire();
      };

      const sectionHtml = (s, idx, total) => `
        <div class="card section-card" data-sidx="${idx}">
          <div class="row-between">
            <input class="text-input sec-name" value="${UI.escapeHtml(s.name)}" style="flex:1;">
            <div class="row gap-8">
              <button class="mini-btn" data-move="-1" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button class="mini-btn" data-move="1" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
              <button class="mini-btn" data-del-section>✕</button>
            </div>
          </div>
          <div class="row-between" style="margin-top:14px;">
            <div class="subtitle">速度渐变（本段内线性加速/减速）</div>
            <label class="switch"><input type="checkbox" class="sec-ramp" ${s.isRamp ? 'checked' : ''}><span class="track"></span></label>
          </div>
          ${!s.isRamp ? `
            <div class="field-row"><span class="field-label">BPM</span><input type="number" class="text-input num-input sec-bpm" value="${s.bpm}"></div>
          ` : `
            <div class="field-row"><span class="field-label">起始</span><input type="number" class="text-input num-input sec-bpm-from" value="${s.bpmFrom}">
            <span class="field-label">目标</span><input type="number" class="text-input num-input sec-bpm-to" value="${s.bpmTo}"></div>
          `}
          <div class="row-between" style="margin-top:12px;">
            <div class="row gap-8">
              <span class="field-label">拍号</span>
              <button class="mini-btn" data-beats="-1">-</button>
              <span style="width:60px;text-align:center;">${s.beatsPerBar}/${s.noteValue}</span>
              <button class="mini-btn" data-beats="1">+</button>
            </div>
            <div class="row gap-8">
              <button class="pill ${s.noteValue === 4 ? 'active' : ''}" data-note="4">4分</button>
              <button class="pill ${s.noteValue === 8 ? 'active' : ''}" data-note="8">8分</button>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">重复小节数</span>
            <button class="mini-btn" data-bars="-1">-</button>
            <span style="width:50px;text-align:center;">${s.bars}</span>
            <button class="mini-btn" data-bars="1">+</button>
          </div>
          <div style="margin-top:14px;">
            <div class="field-label">重音型</div>
            <div class="row wrap gap-8 sec-cells" style="margin-top:8px;">
              ${s.accentPattern.map((lvl, i) => `<div class="beat-cell level-${lvl}" data-cell="${i}">${ACCENT_LABEL[lvl]}</div>`).join('')}
            </div>
          </div>
          <div class="row-between" style="margin-top:14px;">
            <div class="subtitle">随机静音训练</div>
            <label class="switch"><input type="checkbox" class="sec-mute" ${s.randomMute.enabled ? 'checked' : ''}><span class="track"></span></label>
          </div>
          ${s.randomMute.enabled ? `
            <div class="subtitle" style="margin-top:8px;">静音概率：${Math.round(s.randomMute.probability * 100)}%</div>
            <input type="range" min="0" max="100" value="${Math.round(s.randomMute.probability * 100)}" class="sec-mute-prob">
          ` : ''}
          <div class="row-between" style="margin-top:14px;">
            <span class="field-label">同步鼓谱型</span>
            <select class="sec-pattern">${patternOptions(s.drumPatternId)}</select>
          </div>
        </div>
      `;

      const wire = () => {
        document.getElementById('plan-loop').addEventListener('change', (e) => { plan.loop = e.target.checked; Storage.savePlan(plan); });
        document.getElementById('add-section').addEventListener('click', () => {
          const last = plan.sections[plan.sections.length - 1];
          plan.sections.push(Storage.newSection({
            name: '段落 ' + (plan.sections.length + 1),
            beatsPerBar: last ? last.beatsPerBar : 4,
            noteValue: last ? last.noteValue : 4,
            bpm: last ? Math.round(last.bpm) : 100
          }));
          save();
        });

        body.querySelectorAll('.section-card').forEach(card => {
          const idx = Number(card.dataset.sidx);
          const s = plan.sections[idx];

          card.querySelector('.sec-name').addEventListener('blur', (e) => { s.name = e.target.value || '段落'; Storage.savePlan(plan); });
          card.querySelector('.sec-ramp').addEventListener('change', (e) => { s.isRamp = e.target.checked; save(); });
          card.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => {
            const dir = Number(btn.dataset.move);
            const t = idx + dir;
            if (t < 0 || t >= plan.sections.length) return;
            const arr = plan.sections;
            const tmp = arr[idx]; arr[idx] = arr[t]; arr[t] = tmp;
            save();
          }));
          card.querySelector('[data-del-section]').addEventListener('click', () => {
            if (plan.sections.length <= 1) { UI.toast('至少保留一个段落'); return; }
            if (confirm(`确定删除「${s.name}」吗？`)) { plan.sections.splice(idx, 1); save(); }
          });

          const bpmInput = card.querySelector('.sec-bpm');
          if (bpmInput) bpmInput.addEventListener('blur', (e) => { s.bpm = clamp(Number(e.target.value) || 100, 20, 300); Storage.savePlan(plan); });
          const bpmFrom = card.querySelector('.sec-bpm-from');
          if (bpmFrom) bpmFrom.addEventListener('blur', (e) => { s.bpmFrom = clamp(Number(e.target.value) || 80, 20, 300); Storage.savePlan(plan); });
          const bpmTo = card.querySelector('.sec-bpm-to');
          if (bpmTo) bpmTo.addEventListener('blur', (e) => { s.bpmTo = clamp(Number(e.target.value) || 120, 20, 300); Storage.savePlan(plan); });

          card.querySelectorAll('[data-beats]').forEach(btn => btn.addEventListener('click', () => {
            const delta = Number(btn.dataset.beats);
            const beatsPerBar = clamp(s.beatsPerBar + delta, 1, 12);
            s.accentPattern = RM.defaultAccentPattern(beatsPerBar).map((v, i) => i < s.accentPattern.length ? s.accentPattern[i] : v);
            s.beatsPerBar = beatsPerBar;
            save();
          }));
          card.querySelectorAll('[data-note]').forEach(btn => btn.addEventListener('click', () => { s.noteValue = Number(btn.dataset.note); save(); }));
          card.querySelectorAll('[data-bars]').forEach(btn => btn.addEventListener('click', () => { s.bars = clamp(s.bars + Number(btn.dataset.bars), 1, 64); save(); }));

          card.querySelectorAll('[data-cell]').forEach(cell => cell.addEventListener('click', () => {
            const i = Number(cell.dataset.cell);
            s.accentPattern[i] = (s.accentPattern[i] + 1) % 4;
            save();
          }));

          card.querySelector('.sec-mute').addEventListener('change', (e) => { s.randomMute.enabled = e.target.checked; save(); });
          const muteProb = card.querySelector('.sec-mute-prob');
          if (muteProb) muteProb.addEventListener('change', (e) => { s.randomMute.probability = Number(e.target.value) / 100; Storage.savePlan(plan); });

          card.querySelector('.sec-pattern').addEventListener('change', (e) => { s.drumPatternId = e.target.value; Storage.savePlan(plan); });
        });
      };

      renderBody();
    }
  };

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  root.PlansView = View;
}(typeof window !== 'undefined' ? window : globalThis));
