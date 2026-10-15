// Registers the service worker (installable app + offline) and drives the
// "Add to home screen" box on the How To page, if it's on this page.
(function () {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* site still works without it */ }));
  }

  const box = document.getElementById('installBox');
  if (!box) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) { box.hidden = true; return; }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  box.querySelector('[data-os="ios"]').hidden = !isIOS;
  box.querySelector('[data-os="other"]').hidden = isIOS;

  // Chrome, Edge and Android offer a real install prompt; show a button for it when available.
  let deferred = null;
  const btn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { box.hidden = true; });
})();
