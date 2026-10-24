// The site's two looks: Hi-fi (dark, '60s amp) and Tape (light, '70s reel-to-reel).
// Runs in <head> before paint so there's no flash. Follows the device's light/dark
// setting until the user picks a look in the header; the pick is remembered.
(function () {
  const KEY = 'hs.look';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const THEME_COLOR = { hifi: '#0b0c0e', tape: '#cfc9bb' };

  const saved = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (v === 'hifi' || v === 'tape') return v;
      // Carry over the old light/dark choice so returning visitors keep their setting.
      const old = JSON.parse(localStorage.getItem('hs.theme'));
      return old === 'dark' ? 'hifi' : old === 'light' ? 'tape' : null;
    } catch { return null; }
  };
  const current = () => saved() || (media.matches ? 'hifi' : 'tape');

  function apply(look) {
    root.dataset.look = look;
    root.dataset.theme = look === 'hifi' ? 'dark' : 'light';
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', THEME_COLOR[look]));
    document.querySelectorAll('[data-look-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lookSet === look)));
    window.dispatchEvent(new CustomEvent('lookchange', { detail: look }));
  }

  const HBLook = window.HBLook = {
    get: () => root.dataset.look,
    // js/gear.js swaps in an animated version (power down, swap, power up).
    transition: null,
    set(look, animate) {
      if (look === root.dataset.look) return;
      try { localStorage.setItem(KEY, JSON.stringify(look)); } catch { /* storage unavailable */ }
      if (animate && HBLook.transition) HBLook.transition(() => apply(look), look);
      else apply(look);
    },
  };

  apply(current());
  media.addEventListener('change', () => { if (!saved()) apply(current()); });

  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    const btn = document.getElementById('lookBtn');
    const panel = document.getElementById('lookPanel');
    if (!btn || !panel) return;
    const open = (show) => {
      panel.hidden = !show;
      btn.setAttribute('aria-expanded', String(show));
      if (show) panel.querySelector('[aria-pressed="true"]')?.focus();
    };
    btn.addEventListener('click', () => open(panel.hidden));
    panel.addEventListener('click', (e) => {
      const tile = e.target.closest('[data-look-set]');
      if (tile) HBLook.set(tile.dataset.lookSet, true);
      if (e.target.closest('[data-look-close]')) open(false);
    });
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) open(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });
  });
})();
