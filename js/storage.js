// Domain layer on top of db.js: plans, drum patterns, quick-mode state, settings,
// and imported files (score references / music tracks). All async (IndexedDB).
(function (root) {
  const RM = root.RhythmMath;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function newSection(overrides) {
    const beatsPerBar = (overrides && overrides.beatsPerBar) || 4;
    return Object.assign({
      id: uid(),
      name: '段落',
      isRamp: false,
      bpm: 100,
      bpmFrom: 80,
      bpmTo: 120,
      beatsPerBar,
      noteValue: 4,
      bars: 4,
      accentPattern: RM.defaultAccentPattern(beatsPerBar),
      randomMute: { enabled: false, probability: 0.2 },
      drumPatternId: ''
    }, overrides || {});
  }

  function newPlan(overrides) {
    return Object.assign({
      id: uid(),
      name: '新练习计划',
      loop: false,
      sections: [newSection()],
      updatedAt: Date.now()
    }, overrides || {});
  }

  function newPattern(name, stepsPerBar) {
    const steps = stepsPerBar || 16;
    return {
      id: uid(),
      name: name || '新鼓谱型',
      stepsPerBar: steps,
      tracks: {
        kick: new Array(steps).fill(0),
        snare: new Array(steps).fill(0),
        hihat: new Array(steps).fill(0)
      },
      updatedAt: Date.now()
    };
  }

  const DEFAULT_QUICK = () => ({
    id: 'quick',
    bpm: 100,
    beatsPerBar: 4,
    noteValue: 4,
    accentPattern: RM.defaultAccentPattern(4),
    randomMute: { enabled: false, probability: 0.2 },
    drumPatternId: ''
  });

  const DEFAULT_SETTINGS = () => ({
    id: 'prefs',
    clickVolume: 0.9,
    patternVolume: 0.9,
    musicVolume: 0.7,
    vibrationEnabled: true
  });

  const Storage = {
    uid,
    newSection,
    newPlan,
    newPattern,

    async getPlans() {
      const plans = await DB.getAll('plans');
      return plans.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async getPlan(id) { return DB.get('plans', id); },
    async savePlan(plan) { plan.updatedAt = Date.now(); return DB.put('plans', plan); },
    async deletePlan(id) { return DB.delete('plans', id); },

    async getPatterns() {
      const patterns = await DB.getAll('patterns');
      return patterns.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async getPattern(id) { return DB.get('patterns', id); },
    async savePattern(pattern) { pattern.updatedAt = Date.now(); return DB.put('patterns', pattern); },
    async deletePattern(id) { return DB.delete('patterns', id); },

    async getQuickState() {
      const s = await DB.get('settings', 'quick');
      return Object.assign(DEFAULT_QUICK(), s || {});
    },
    async saveQuickState(state) {
      state.id = 'quick';
      return DB.put('settings', state);
    },

    async getPrefs() {
      const s = await DB.get('settings', 'prefs');
      return Object.assign(DEFAULT_SETTINGS(), s || {});
    },
    async savePrefs(prefs) {
      prefs.id = 'prefs';
      return DB.put('settings', prefs);
    },

    // ---- imported files (score reference images/PDFs, music tracks) ----
    async getFiles(kind) {
      const files = await DB.getAll('files');
      return files.filter(f => f.kind === kind).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    async getFile(id) { return DB.get('files', id); },
    async saveFile(file) {
      file.id = file.id || uid();
      file.createdAt = file.createdAt || Date.now();
      return DB.put('files', file);
    },
    async deleteFile(id) { return DB.delete('files', id); },

    // ---- backup / restore (plans + patterns + settings only; imported
    // score/music blobs are excluded since JSON can't hold them compactly) ----
    async exportBackup() {
      const [plans, patterns, quick, prefs] = await Promise.all([
        this.getPlans(), this.getPatterns(), this.getQuickState(), this.getPrefs()
      ]);
      return {
        exportedAt: new Date().toISOString(),
        version: 1,
        plans, patterns, quick, prefs
      };
    },
    // Built-in content (note-value chart). Applied once per SEED_VERSION; bump the
    // version when data/rhythm-value-chart.json changes to push updates to installed apps.
    async seedBuiltins() {
      const SEED_VERSION = 1;
      const rec = await DB.get('settings', 'seed');
      if (rec && rec.version >= SEED_VERSION) return false;
      const res = await fetch('data/rhythm-value-chart.json');
      const data = await res.json();
      await this.importBackup({ plans: data.plans, patterns: data.patterns });
      await DB.put('settings', { id: 'seed', version: SEED_VERSION });
      return true;
    },
    async importBackup(data) {
      if (!data || typeof data !== 'object') throw new Error('备份文件格式不正确');
      const tasks = [];
      (data.plans || []).forEach(p => tasks.push(DB.put('plans', p)));
      (data.patterns || []).forEach(p => tasks.push(DB.put('patterns', p)));
      if (data.quick) tasks.push(this.saveQuickState(data.quick));
      if (data.prefs) tasks.push(this.savePrefs(data.prefs));
      await Promise.all(tasks);
    }
  };

  root.Storage = Storage;
}(typeof window !== 'undefined' ? window : globalThis));
