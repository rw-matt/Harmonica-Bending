// Light/dark theme. Runs in <head> before paint so there's no flash.
// Follows the device setting until the user picks one; the pick is remembered.
(function () {
  const KEY = 'hs.theme';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const current = () => saved() || (media.matches ? 'dark' : 'light');

  function apply(theme) {
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-set]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)));
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  apply(current());
  media.addEventListener('change', () => { if (!saved()) apply(current()); });
  document.addEventListener('DOMContentLoaded', () => apply(current()));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (!b) return;
    try { localStorage.setItem(KEY, JSON.stringify(b.dataset.themeSet)); } catch { /* storage unavailable */ }
    apply(b.dataset.themeSet);
  });
})();
