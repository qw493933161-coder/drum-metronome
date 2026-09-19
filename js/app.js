(function () {
  const HEADER_TITLE = {
    metronome: '节拍器', plans: '练习计划', patterns: '鼓谱编辑', materials: '谱面 / 配乐'
  };
  const views = {
    metronome: MetronomeView,
    plans: PlansView,
    patterns: PatternsView,
    materials: MaterialsView
  };
  let currentView = null;

  function mountAll() {
    Object.keys(views).forEach(key => {
      views[key].mount(document.getElementById('view-' + key));
    });
  }

  async function switchTo(name) {
    if (currentView && views[currentView].onHide) views[currentView].onHide();
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.getElementById('view-' + name).classList.add('active');
    document.getElementById('header-title').textContent = HEADER_TITLE[name];
    currentView = name;
    await views[name].onShow();
  }

  function wireTabbar() {
    document.getElementById('tabbar').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn) switchTo(btn.dataset.view);
    });
  }

  function wireUnlockOverlay() {
    const overlay = document.getElementById('unlock-overlay');
    document.getElementById('unlock-btn').addEventListener('click', async () => {
      await AudioEngine.resume();
      overlay.classList.add('hidden');
    }, { once: true });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => {});
      });
    }
  }

  mountAll();
  wireTabbar();
  wireUnlockOverlay();
  registerServiceWorker();
  Storage.seedBuiltins().catch(() => {}).then(() => switchTo('metronome'));
}());
