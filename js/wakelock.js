// Keeps the screen awake while a practice session is running (Screen Wake Lock
// API). Falls back to a no-op silently on browsers that don't support it.
// Also re-acquires the lock when the tab becomes visible again, since the
// browser releases it automatically whenever the page is hidden.
(function (root) {
  let sentinel = null;
  let wanted = false;

  async function acquire() {
    wanted = true;
    if (!('wakeLock' in navigator)) return false;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
      return true;
    } catch (e) {
      return false;
    }
  }

  function release() {
    wanted = false;
    if (sentinel) sentinel.release().catch(() => {});
    sentinel = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible' && !sentinel) acquire();
  });

  root.WakeLock = { acquire, release };
}(typeof window !== 'undefined' ? window : globalThis));
