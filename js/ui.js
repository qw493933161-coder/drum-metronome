// Small shared DOM helpers used by every view module.
(function (root) {
  function toast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => el.remove(), ms || 1800);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function confirmDialog(message) {
    return Promise.resolve(window.confirm(message));
  }

  // Opens a full-screen overlay <div id="overlay-root"> filled with `html`.
  // `onClose` runs once, either on back-button click or Escape.
  function openOverlay(html, onClose) {
    const root = document.getElementById('overlay-root');
    root.innerHTML = `<div class="overlay active" id="active-overlay">${html}</div>`;
    const closeBtn = root.querySelector('[data-overlay-close]');
    const doClose = () => {
      root.innerHTML = '';
      document.removeEventListener('keydown', escHandler);
      if (onClose) onClose();
    };
    const escHandler = (e) => { if (e.key === 'Escape') doClose(); };
    document.addEventListener('keydown', escHandler);
    if (closeBtn) closeBtn.addEventListener('click', doClose);
    return doClose;
  }

  function closeOverlay() {
    document.getElementById('overlay-root').innerHTML = '';
  }

  function overlayHeaderHtml(titleHtml) {
    return `<div class="overlay-header">
      <button class="btn-icon" data-overlay-close>✕</button>
      ${titleHtml}
    </div>`;
  }

  root.UI = { toast, escapeHtml, confirmDialog, openOverlay, closeOverlay, overlayHeaderHtml };
}(typeof window !== 'undefined' ? window : globalThis));
