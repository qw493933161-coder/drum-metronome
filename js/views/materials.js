// Score reference (import image/PDF, display only — no parsing/sync), play-along
// music (import audio, tap-tempo to log its BPM), and app-wide settings
// (volume mixer, vibration, JSON backup/restore).
(function (root) {
  const View = {
    scores: [],
    tracks: [],
    prefs: null,
    tapTimes: [],

    mount(container) {
      this.container = container;
      container.addEventListener('click', (e) => this._onClick(e));
      container.addEventListener('change', (e) => this._onChange(e));
      container.addEventListener('input', (e) => this._onInput(e));
    },

    async onShow() {
      this.scores = await Storage.getFiles('score');
      this.tracks = await Storage.getFiles('music');
      this.prefs = await Storage.getPrefs();
      this.render();
    },
    onHide() {
      const audio = document.getElementById('music-audio-el');
      if (audio) audio.pause();
    },

    render() {
      const c = this.container;
      c.innerHTML = `
        <div class="card">
          <div class="row-between">
            <div class="title">谱面参考</div>
            <label class="btn-secondary" style="cursor:pointer;">
              导入图片/PDF<input type="file" accept="image/*,application/pdf" id="score-file-input" style="display:none;">
            </label>
          </div>
          <div class="subtitle" style="margin-top:6px;">只做展示，不解析内容、不与节拍同步 —— 练习时放旁边自己看</div>
          ${this.scores.map(f => `
            <div class="file-list-item">
              <span data-view-score="${f.id}" style="cursor:pointer;">${UI.escapeHtml(f.name)}</span>
              <button class="btn-danger" data-del-score="${f.id}">删除</button>
            </div>
          `).join('')}
          ${!this.scores.length ? '<div class="empty-tip">还没有导入谱面</div>' : ''}
        </div>

        <div class="card">
          <div class="row-between">
            <div class="title">配乐练习</div>
            <label class="btn-secondary" style="cursor:pointer;">
              导入音乐<input type="file" accept="audio/*" id="music-file-input" style="display:none;">
            </label>
          </div>
          <audio id="music-audio-el" style="display:none;"></audio>
          ${this.tracks.map(f => `
            <div class="file-list-item">
              <div>
                <div>${UI.escapeHtml(f.name)}</div>
                <div class="subtitle">${f.bpm ? f.bpm + ' BPM' : '未定速'}</div>
              </div>
              <div class="row gap-8">
                <button class="btn-secondary" data-play-music="${f.id}">▶ 播放</button>
                <button class="btn-secondary" data-tap-music="${f.id}">TAP 定速</button>
                <button class="btn-danger" data-del-music="${f.id}">删除</button>
              </div>
            </div>
          `).join('')}
          ${!this.tracks.length ? '<div class="empty-tip">还没有导入音乐</div>' : ''}
        </div>

        <div class="card" id="settings-card">
          <div class="title" style="margin-bottom:10px;">音量与反馈</div>
          ${volumeRow('click', '节拍点声音', this.prefs.clickVolume)}
          ${volumeRow('pattern', '鼓谱型声音', this.prefs.patternVolume)}
          ${volumeRow('music', '配乐音量', this.prefs.musicVolume)}
          <div class="row-between" style="margin-top:14px;">
            <div class="subtitle">强拍振动反馈</div>
            <label class="switch"><input type="checkbox" id="vibration-toggle" ${this.prefs.vibrationEnabled ? 'checked' : ''}><span class="track"></span></label>
          </div>
        </div>

        <div class="card">
          <div class="title" style="margin-bottom:10px;">数据备份</div>
          <div class="subtitle">练习计划和鼓谱型都存在本设备浏览器里，换设备/清缓存会丢失。建议定期导出备份。</div>
          <div class="row gap-8" style="margin-top:12px;">
            <button class="btn-secondary" id="export-backup" style="flex:1;">导出备份</button>
            <label class="btn-secondary" style="flex:1;text-align:center;cursor:pointer;">
              导入备份<input type="file" accept="application/json" id="import-backup-input" style="display:none;">
            </label>
          </div>
        </div>
      `;
    },

    async _onChange(e) {
      if (e.target.id === 'score-file-input') return this._importFile(e.target, 'score');
      if (e.target.id === 'music-file-input') return this._importFile(e.target, 'music');
      if (e.target.id === 'import-backup-input') return this._importBackup(e.target);
      if (e.target.id === 'vibration-toggle') {
        this.prefs.vibrationEnabled = e.target.checked;
        await Storage.savePrefs(this.prefs);
      }
    },
    _onInput(e) {
      if (e.target.dataset.vol) {
        const key = e.target.dataset.vol;
        const value = Number(e.target.value) / 100;
        this.prefs[key + 'Volume'] = value;
        AudioEngine.setVolume(key, value);
        Storage.savePrefs(this.prefs);
        const audio = document.getElementById('music-audio-el');
        if (key === 'music' && audio) audio.volume = value;
      }
    },

    async _importFile(input, kind) {
      const file = input.files[0];
      if (!file) return;
      const MAX = 30 * 1024 * 1024;
      if (file.size > MAX) { UI.toast('文件太大了（超过 30MB），先压缩一下再试'); return; }
      await Storage.saveFile({ kind, name: file.name, type: file.type, blob: file });
      UI.toast('导入成功');
      this.onShow();
    },

    async _onClick(e) {
      const viewScore = e.target.closest('[data-view-score]');
      const delScore = e.target.closest('[data-del-score]');
      const playMusic = e.target.closest('[data-play-music]');
      const tapMusic = e.target.closest('[data-tap-music]');
      const delMusic = e.target.closest('[data-del-music]');
      const exportBtn = e.target.closest('#export-backup');

      if (viewScore) return this._viewScore(viewScore.dataset.viewScore);
      if (delScore) {
        if (confirm('确定删除这份谱面吗？')) { await Storage.deleteFile(delScore.dataset.delScore); this.onShow(); }
        return;
      }
      if (playMusic) return this._toggleMusic(playMusic.dataset.playMusic, playMusic);
      if (tapMusic) return this._tapMusicTempo(tapMusic.dataset.tapMusic);
      if (delMusic) {
        if (confirm('确定删除这首音乐吗？')) { await Storage.deleteFile(delMusic.dataset.delMusic); this.onShow(); }
        return;
      }
      if (exportBtn) return this._exportBackup();
    },

    async _viewScore(id) {
      const file = await Storage.getFile(id);
      const url = URL.createObjectURL(file.blob);
      const isPdf = (file.type || '').includes('pdf');
      UI.openOverlay(`
        ${UI.overlayHeaderHtml(`<div class="title">${UI.escapeHtml(file.name)}</div>`)}
        <div class="overlay-body score-viewer">
          ${isPdf ? `<embed src="${url}" type="application/pdf">` : `<img src="${url}" alt="${UI.escapeHtml(file.name)}">`}
        </div>
      `, () => URL.revokeObjectURL(url));
    },

    async _toggleMusic(id, btn) {
      const audio = document.getElementById('music-audio-el');
      if (audio.dataset.fileId === id && !audio.paused) {
        audio.pause();
        btn.textContent = '▶ 播放';
        return;
      }
      const file = await Storage.getFile(id);
      const url = URL.createObjectURL(file.blob);
      audio.src = url;
      audio.dataset.fileId = id;
      audio.volume = this.prefs.musicVolume;
      await audio.play();
      this.container.querySelectorAll('[data-play-music]').forEach(b => b.textContent = '▶ 播放');
      btn.textContent = '⏸ 暂停';
      this._activeMusicId = id;
    },

    _tapMusicTempo(id) {
      const now = performance.now();
      this.tapTimes = this.tapTimes.filter(t => now - t < 3000);
      this.tapTimes.push(now);
      if (navigator.vibrate) navigator.vibrate(8);
      if (this.tapTimes.length < 4) { UI.toast(`跟着鼓点再敲 ${4 - this.tapTimes.length} 下`); return; }
      const gaps = [];
      for (let i = 1; i < this.tapTimes.length; i++) gaps.push(this.tapTimes[i] - this.tapTimes[i - 1]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const bpm = Math.round(60000 / avg);
      Storage.getFile(id).then(f => { f.bpm = bpm; Storage.saveFile(f); this.onShow(); UI.toast(`定速成功：${bpm} BPM`); });
    },

    async _exportBackup() {
      const data = await Storage.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `drum-metronome-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },

    async _importBackup(input) {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await Storage.importBackup(data);
        UI.toast('备份已导入');
        this.onShow();
      } catch (e) {
        UI.toast('导入失败：文件格式不对');
      }
    }
  };

  function volumeRow(key, label, value) {
    return `
      <div style="margin-top:10px;">
        <div class="row-between"><span class="subtitle">${label}</span><span class="subtitle">${Math.round(value * 100)}%</span></div>
        <input type="range" min="0" max="100" value="${Math.round(value * 100)}" data-vol="${key}">
      </div>
    `;
  }

  root.MaterialsView = View;
}(typeof window !== 'undefined' ? window : globalThis));
