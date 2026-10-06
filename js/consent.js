// Cookie banner for Google Analytics (Consent Mode v2).
// The defaults live inline in <head> so they apply before gtag.js loads. This file only
// asks visitors who appear to be in Europe, and lets anyone change their mind from the footer.
(function () {
  const KEY = 'hs.consent';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } };

  // A time-zone check is a rough location guess, but it needs no network call.
  // Google applies the real regional default (by IP) on its side either way.
  function looksEuropean() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return tz.startsWith('Europe/') || /^Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)$/.test(tz);
    } catch { return false; }
  }

  function clearGaCookies() {
    const host = location.hostname;
    const domains = ['', host, '.' + host, '.' + host.split('.').slice(-2).join('.')];
    document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter((n) => n.startsWith('_ga')).forEach((name) => {
      domains.forEach((d) => { document.cookie = `${name}=; Max-Age=0; path=/${d ? '; domain=' + d : ''}`; });
    });
  }

  function choose(value) {
    save(value);
    if (typeof gtag === 'function') gtag('consent', 'update', { analytics_storage: value });
    if (value === 'denied') clearGaCookies();
    hide();
  }

  let banner;
  function show(focus) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'consent card';
      banner.setAttribute('role', 'dialog');
      banner.setAttribute('aria-label', 'Cookie choice');
      banner.innerHTML = `
        <p>We use Google Analytics cookies to see how people use the site, so we can make it better. Your microphone audio never leaves your device. <a href="privacy.html">Privacy policy</a></p>
        <div class="consent-actions">
          <button type="button" class="btn" data-consent="denied">No thanks</button>
          <button type="button" class="btn btn-primary" data-consent="granted">Allow analytics</button>
        </div>`;
      banner.addEventListener('click', (e) => {
        const b = e.target.closest('[data-consent]');
        if (b) choose(b.dataset.consent);
      });
      document.body.append(banner);
    }
    banner.hidden = false;
    if (focus) banner.querySelector('.btn-primary').focus({ preventScroll: true });
  }
  function hide() { if (banner) banner.hidden = true; }

  document.addEventListener('click', (e) => { if (e.target.closest('[data-cookie-settings]')) show(true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && banner && !banner.hidden && read()) hide(); });
  if (!read() && looksEuropean()) show();
})();
