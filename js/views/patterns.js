// Drum pattern (kick/snare/hihat step grid) list + editor overlay with preview playback.
(function (root) {
  const TRACKS = ['hihat', 'snare', 'kick'];
  const TRACK_LABEL = { hihat: 'Hi-Hat', snare: 'Snare', kick: 'Kick' };

  const View = {
    patterns: [],

    mount(container) {
      this.container = container;
      container.addEventListener('click', (e) => this._onListClick(e));
    },

    async onShow() {
      this.patterns = await Storage.getPatterns();
      this.render();
    },
    onHide() { this._stopPreview(); },

    render() {
      const c = this.container;
      c.innerHTML = `
        ${this.patterns.map(p => `
          <div class="card row-between" data-open="${p.id}">
            <div>
              <div class="title">${UI.escapeHtml(p.name)}</div>
              <div class="subtitle">${p.stepsPerBar} 步 / 小节</div>
            </div>
            <div class="row gap-8">
              <button class="btn-secondary" data-dup="${p.id}">复制</button>
              <button class="btn-danger" data-del="${p.id}">删除</button>
            </div>
          </div>
        `).join('')}
        ${!this.patterns.length ? '<div class="empty-tip">还没有鼓谱型\n点击下方按钮创建一个吧</div>' : ''}
        <div style="height:12px;"></div>
        <button class="btn-primary play-fab" data-create>+ 新建鼓谱型</button>
      `;
    },

    async _onListClick(e) {
      const create = e.target.closest('[data-create]');
      const dup = e.target.closest('[data-dup]');
      const del = e.target.closest('[data-del]');
      const open = e.target.closest('[data-open]');
      if (create) {
        const pattern = Storage.newPattern('新鼓谱型 ' + (this.patterns.length + 1), 16);
        await Storage.savePattern(pattern);
        this._openEditor(pattern.id);
      } else if (dup) {
        const src = await Storage.getPattern(dup.dataset.dup);
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = Storage.uid();
        copy.name = src.name + ' 副本';
        await Storage.savePattern(copy);
        this.patterns = await Storage.getPatterns();
        this.render();
      } else if (del) {
        const pattern = await Storage.getPattern(del.dataset.del);
        if (confirm(`确定删除「${pattern.name}」吗？`)) {
          await Storage.deletePattern(del.dataset.del);
          this.patterns = await Storage.getPatterns();
          this.render();
        }
      } else if (open) {
        this._openEditor(open.dataset.open);
      }
    },

    async _openEditor(id) {
      const pattern = await Storage.getPattern(id);
      UI.openOverlay(this._editorHtml(pattern), () => { this._stopPreview(); this.onShow(); });
      this._wireEditor(pattern);
    },

    _editorHtml(pattern) {
      return `
        ${UI.overlayHeaderHtml(`<input class="overlay-title-input" id="pat-name-input" value="${UI.escapeHtml(pattern.name)}">`)}
        <div class="overlay-body" id="pat-editor-body"></div>
      `;
    },

    _wireEditor(pattern) {
      this._engine = null;
      this._previewBpm = 120;
      const nameInput = document.getElementById('pat-name-input');
      nameInput.addEventListener('blur', () => { pattern.name = nameInput.value || '未命名鼓谱型'; Storage.savePattern(pattern); });

      const body = document.getElementById('pat-editor-body');
      const save = () => { Storage.savePattern(pattern); renderBody(); };

      const renderBody = () => {
        body.innerHTML = `
          <div class="card row-between">
            <div class="subtitle">每小节步数（细分）</div>
            <div class="row gap-8">
              ${[8, 12, 16, 24, 32].map(n => `<button class="pill ${pattern.stepsPerBar === n ? 'active' : ''}" data-steps="${n}">${n}${n === 12 ? '(3连音)' : n === 24 ? '(6连音)' : ''}</button>`).join('')}
            </div>
          </div>
          <div class="card">
            ${TRACKS.map(t => `
              <div class="grid-row">
                <span class="grid-label">${TRACK_LABEL[t]}</span>
                <div class="grid-cells" data-track="${t}">
                  ${pattern.tracks[t].map((on, i) => `<div class="grid-cell ${on ? 'on-' + t : ''} ${i % (pattern.stepsPerBar / 4) === 0 ? 'beat-start' : ''}" data-idx="${i}"></div>`).join('')}
                </div>
              </div>
            `).join('')}
            <button class="btn-danger" id="pat-clear" style="margin-top:12px;">清空</button>
          </div>
          <div class="card">
            <div class="row-between"><div class="title">预览播放速度</div><div class="subtitle" id="preview-bpm-label">${this._previewBpm} BPM</div></div>
            <input type="range" min="40" max="220" value="${this._previewBpm}" id="preview-bpm">
          </div>
          <button class="btn-primary play-fab" id="pat-play">${this._engine && this._engine.running ? '■ 停止预览' : '▶ 预览播放'}</button>
        `;
        wire();
      };

      const wire = () => {
        body.querySelectorAll('[data-steps]').forEach(btn => btn.addEventListener('click', () => {
          const steps = Number(btn.dataset.steps);
          resampleSteps(pattern, steps);
          const wasPlaying = this._engine && this._engine.running;
          this._stopPreview();
          save();
          if (wasPlaying) this._startPreview(pattern);
        }));

        TRACKS.forEach(t => {
          body.querySelector(`.grid-cells[data-track="${t}"]`).addEventListener('click', (e) => {
            const cell = e.target.closest('[data-idx]');
            if (!cell) return;
            const idx = Number(cell.dataset.idx);
            pattern.tracks[t][idx] = pattern.tracks[t][idx] ? 0 : 1;
            Storage.savePattern(pattern);
            cell.classList.toggle('on-' + t);
          });
        });

        body.querySelector('#pat-clear').addEventListener('click', () => {
          if (!confirm('确定清空当前所有节拍吗？')) return;
          TRACKS.forEach(t => { pattern.tracks[t] = new Array(pattern.stepsPerBar).fill(0); });
          save();
        });

        const bpmSlider = body.querySelector('#preview-bpm');
        bpmSlider.addEventListener('input', (e) => {
          this._previewBpm = Number(e.target.value);
          body.querySelector('#preview-bpm-label').textContent = this._previewBpm + ' BPM';
          if (this._engine && this._engine.running) { this._stopPreview(); this._startPreview(pattern); }
        });

        body.querySelector('#pat-play').addEventListener('click', async () => {
          if (this._engine && this._engine.running) {
            this._stopPreview();
          } else {
            const state = await AudioEngine.resume();
            if (state !== 'running') { UI.toast('音频未解锁，请先点开头的“点击开始”'); return; }
            this._startPreview(pattern);
          }
          body.querySelector('#pat-play').textContent = (this._engine && this._engine.running) ? '■ 停止预览' : '▶ 预览播放';
        });
      };

      renderBody();
      this._gridHost = body;
    },

    _startPreview(pattern) {
      const section = {
        id: 'preview', name: '预览', isRamp: false, bpm: this._previewBpm,
        beatsPerBar: pattern.stepsPerBar, noteValue: 4, bars: Infinity,
        accentPattern: new Array(pattern.stepsPerBar).fill(0),
        randomMute: { enabled: false, probability: 0 },
        drumPatternId: pattern.id
      };
      Storage.getPrefs().then(prefs => AudioEngine.setVolume('pattern', prefs.patternVolume));
      this._engine = new Engine({
        sections: [section], loop: true,
        patternsById: { [pattern.id]: pattern },
        onStep: (info) => {
          if (!this._gridHost) return;
          TRACKS.forEach(t => {
            this._gridHost.querySelectorAll(`.grid-cells[data-track="${t}"] [data-idx]`).forEach((el, i) => {
              el.classList.toggle('cursor', i === info.stepIndex);
            });
          });
        }
      });
      this._engine.start();
    },
    _stopPreview() {
      if (this._engine) { this._engine.stop(); this._engine = null; }
    }
  };

  function resampleSteps(pattern, steps) {
    const scale = steps / pattern.stepsPerBar;
    TRACKS.forEach(track => {
      const oldArr = pattern.tracks[track];
      const newArr = new Array(steps).fill(0);
      if (scale >= 1) {
        for (let i = 0; i < oldArr.length; i++) if (oldArr[i]) newArr[Math.round(i * scale)] = 1;
      } else {
        for (let i = 0; i < steps; i++) newArr[i] = oldArr[Math.round(i / scale)] ? 1 : 0;
      }
      pattern.tracks[track] = newArr;
    });
    pattern.stepsPerBar = steps;
  }

  root.PatternsView = View;
}(typeof window !== 'undefined' ? window : globalThis));
