// Motion for the Hi-fi and Tape looks. Everything here copies how a physical part
// behaves: the needle has weight, keys have travel, reels spin up and coast down.
// GSAP is loaded as a plain script before this module (js/vendor). If it's missing,
// or the visitor prefers reduced motion, every function still sets the end state.

const gsap = window.gsap;
const motion = !!gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches;
if (gsap && window.CustomEase) gsap.registerPlugin(window.CustomEase);
if (gsap && window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
const look = () => document.documentElement.dataset.look;
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
// Key travel: a fast drop that lands with a tiny bump, like a tape-deck key latching.
const clunk = motion && window.CustomEase ? window.CustomEase.create('clunk', 'M0,0 C0.2,0 0.3,1.15 0.5,1.05 0.7,0.97 0.85,1 1,1') : 'power2.out';

/* ───────── VU meter ───────── */
const PIV = { x: 200, y: 250 }, R = 170, A0 = -46, A1 = 46, REST = -52;
const pt = (a, r) => [PIV.x + r * Math.sin(a * Math.PI / 180), PIV.y - r * Math.cos(a * Math.PI / 180)].map((n) => n.toFixed(2));
const arc = (a1, a2, r) => `M${pt(a1, r)} A${r} ${r} 0 0 1 ${pt(a2, r)}`;
const angle = (f) => A0 + (A1 - A0) * Math.max(-0.07, Math.min(1.08, f));
let meterSeq = 0;

/**
 * Draws a meter into an <svg> and returns controls. `span` is how far past 100% the
 * scale runs (the trainer's gauge goes to 130% of the bend), so labels sit at 0–100%.
 */
export function createMeter(svg, { span = 1, label = 'BEND' } = {}) {
  const id = `m${++meterSeq}`;
  svg.setAttribute('viewBox', '0 0 400 220');
  svg.classList.add('meter');
  const defs = el('defs', {}, svg);
  const gh = el('radialGradient', { id: `${id}h`, cx: '50%', cy: '78%', r: '85%' }, defs);
  [['0', '#8fd0ff'], ['.55', '#3e8fe0'], ['1', '#123a73']].forEach(([o, c]) => el('stop', { offset: o, 'stop-color': c }, gh));
  const gt = el('radialGradient', { id: `${id}t`, cx: '50%', cy: '100%', r: '100%' }, defs);
  [['0', '#fff1c4'], ['1', '#e9cc7e']].forEach(([o, c]) => el('stop', { offset: o, 'stop-color': c }, gt));
  el('rect', { class: 'face-hifi', width: 400, height: 220, rx: 6, fill: `url(#${id}h)` }, svg);
  el('rect', { class: 'face-tape', width: 400, height: 220, rx: 4, fill: `url(#${id}t)` }, svg);
  el('path', { class: 'ink', d: arc(A0, A1, R), 'stroke-width': 1.5 }, svg);
  const zone = el('path', { class: 'zone', 'stroke-width': 8, d: '' }, svg);
  let ticks = '';
  for (let i = 0; i <= 20; i++) { const a = A0 + i * (A1 - A0) / 20, m = i % 5 === 0; ticks += `M${pt(a, R)} L${pt(a, R + (m ? 16 : 9))} `; }
  el('path', { class: 'ink', d: ticks, 'stroke-width': 1.4 }, svg);
  [0, 25, 50, 75, 100].forEach((p) => {
    const [x, y] = pt(angle(p / 100 / span), R + 30);
    el('text', { x, y: +y + 4, 'text-anchor': 'middle', 'font-size': 14 }, svg).textContent = p;
  });
  el('text', { x: 200, y: 172, 'text-anchor': 'middle', 'font-size': 15, 'letter-spacing': 4 }, svg).textContent = label;
  const g = el('g', {}, svg);
  el('line', { class: 'needle', x1: PIV.x, y1: PIV.y - 62, x2: PIV.x, y2: PIV.y - 194 }, g);

  // The needle is a lightly under-damped spring chasing its target, so it carries
  // a little momentum and settles instead of snapping.
  const n = { x: REST, v: 0, target: REST };
  const render = () => g.setAttribute('transform', `rotate(${n.x.toFixed(2)} ${PIV.x} ${PIV.y})`);
  render();
  if (gsap) {
    gsap.ticker.add((t, dt) => {
      if (Math.abs(n.target - n.x) < 0.01 && Math.abs(n.v) < 0.01) return;
      if (motion) {
        const s = Math.min(dt, 50) / 1000;
        n.v += (260 * (n.target - n.x) - 24 * n.v) * s;
        n.x += n.v * s;
      } else n.x = n.target;
      render();
    });
  }
  return {
    /** Fraction of the scale (0..1) the in-tune zone covers. */
    setZone(f0, f1) { zone.setAttribute('d', arc(angle(f0), angle(Math.min(f1, 1.04)), R + 5)); },
    /** Fraction of the scale, or null to drop the needle to its rest pin. */
    set(f) { n.target = f == null ? REST : angle(f); if (!gsap) { n.x = n.target; render(); } },
  };
}

/** Static meters on content pages: <svg data-meter="0.95"></svg> */
export function staticMeters() {
  document.querySelectorAll('svg[data-meter]').forEach((svg) => {
    const m = createMeter(svg);
    m.setZone(0.8, 1.04);
    m.set(+svg.dataset.meter);
  });
}

/* ───────── reels ───────── */
let reelTween = null;
function buildReel(svg, pack) {
  svg.setAttribute('viewBox', '-50 -50 100 100');
  el('circle', { r: 48, fill: '#2b2a27', stroke: '#55524b', 'stroke-width': 2 }, svg);
  el('circle', { r: pack, fill: '#4a3726' }, svg);
  const g = el('g', {}, svg);
  for (let k = 0; k < 3; k++) {
    const a = k * 120 * Math.PI / 180;
    el('circle', { cx: (29 * Math.sin(a)).toFixed(2), cy: (-29 * Math.cos(a)).toFixed(2), r: 11, fill: '#e7e1d2', stroke: '#55524b', 'stroke-width': 1.5 }, g);
  }
  el('circle', { r: 9, fill: '#c9cbcd' }, g);
  return g;
}
export function initReels() {
  const svgs = [...document.querySelectorAll('svg.reel')];
  if (!svgs.length) return;
  const spokes = svgs.map((s, i) => buildReel(s, i ? 26 : 40));
  if (!motion) return;
  reelTween = gsap.to(spokes, { rotation: 360, svgOrigin: '0 0', duration: 1.8, ease: 'none', repeat: -1, paused: true });
  reelTween.timeScale(0);
}
/** Spin up (on) or coast to a stop (off). */
export function reels(on) {
  if (!reelTween) return;
  if (on) reelTween.play();
  gsap.to(reelTween, { timeScale: on ? 1 : 0, duration: on ? 0.6 : 1, ease: on ? 'power2.in' : 'power2.out', overwrite: true, onComplete: () => { if (!on) reelTween.pause(); } });
}

/* ───────── counter wheels ───────── */
export function createCounter(host, digits = 2) {
  const cols = [];
  for (let i = 0; i < digits; i++) {
    const w = document.createElement('span'); w.className = 'wheel';
    const col = document.createElement('span'); col.className = 'col';
    for (let d = 0; d <= 10; d++) { const s = document.createElement('span'); s.textContent = d % 10; col.appendChild(s); }
    w.appendChild(col); host.appendChild(w); cols.push(col);
  }
  host.setAttribute('aria-hidden', 'true');
  let value = 0;
  function show(n, animate) {
    const ds = String(Math.min(n, 10 ** digits - 1)).padStart(digits, '0').split('').map(Number);
    ds.forEach((d, i) => {
      const col = cols[i], prev = +(col.dataset.d || 0);
      col.dataset.d = d;
      const y = (v) => -v * (100 / 11);
      if (!gsap) { col.style.transform = `translateY(${y(d)}%)`; return; }
      if (!animate || !motion || d === prev) { gsap.set(col, { yPercent: y(d) }); return; }
      // Rolling 9 → 0 goes forward through the spare "0" at the bottom, like a real counter.
      if (d === 0 && prev === 9) gsap.fromTo(col, { yPercent: y(9) }, { yPercent: y(10), duration: 0.45, ease: 'back.out(1.2)', onComplete: () => gsap.set(col, { yPercent: 0 }) });
      else gsap.to(col, { yPercent: y(d), duration: 0.45, ease: 'back.out(1.2)' });
    });
    value = n;
  }
  show(0, false);
  return { set: (n) => show(n, n > value), reset: () => show(0, false) };
}

/* ───────── small physical moves ───────── */
/** A key being pressed: it drops and springs back (Tape keys travel further). */
export function press(target) {
  if (!motion || !target) return;
  gsap.fromTo(target, { y: 0 }, { y: look() === 'tape' ? 3 : 2, duration: 0.07, yoyo: true, repeat: 1, ease: 'power1.out', clearProps: 'transform' });
}
/** Tape: the newly chosen key latches down with a clunk. */
export function latch(target) {
  if (!motion || !target || look() !== 'tape') return;
  // Animate from 6px above wherever the stylesheet rests it, so the end state matches the CSS.
  gsap.from(target, { y: '-=6', duration: 0.12, ease: clunk, clearProps: 'transform' });
}
/** Hi-fi: the dial pointer glides to a hole and overshoots a touch. */
export function pointerTo(ptr, target, animate = true) {
  if (!ptr || !target) return;
  const x = target.offsetLeft + target.offsetWidth / 2 - 1;
  if (!gsap) { ptr.style.transform = `translateX(${x}px)`; return; }
  if (!motion || !animate) gsap.set(ptr, { x, overwrite: true });
  else gsap.to(ptr, { x, duration: 0.5, ease: 'back.out(1.4)', overwrite: true });
}
/** Hi-fi: the key selector knob turns to its detent with a small bounce. */
export function knobTo(knob, deg, animate = true) {
  if (!knob) return;
  if (!gsap) { knob.style.transform = `rotate(${deg}deg)`; return; }
  if (!motion || !animate) gsap.set(knob, { rotation: deg, overwrite: true });
  else gsap.to(knob, { rotation: deg, duration: 0.38, ease: 'back.out(2.2)', overwrite: true });
}
/** A short flash when a bend is nailed. */
export function nailed(flash, lamps) {
  if (!flash) return;
  if (!motion) { flash.style.opacity = 1; setTimeout(() => { flash.style.opacity = 0; }, 1400); return; }
  gsap.timeline()
    .fromTo(flash, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.25 })
    .to(flash, { opacity: 0, duration: 0.4, delay: 1.1 });
  if (lamps?.length) gsap.fromTo(lamps, { filter: 'brightness(1)' }, { filter: 'brightness(2.2)', duration: 0.15, yoyo: true, repeat: 3, clearProps: 'filter' });
}

/* ───────── power on / switching looks ───────── */
export function powerOn() {
  if (!motion) return;
  if (look() === 'hifi') {
    gsap.fromTo('.backlight', { opacity: 0.85 }, { opacity: 0, duration: 0.5, ease: 'power2.out' });
    gsap.fromTo('.gkey .lamp, .step .lamp, .status .dot', { opacity: 0.15 }, { opacity: 1, duration: 0.25, stagger: 0.04, clearProps: 'opacity' });
  } else {
    gsap.fromTo('.machine, .jcard, .faq-list', { y: 14 }, { y: 0, duration: 0.5, ease: 'power3.out', clearProps: 'transform' });
    if (reelTween && !reelTween.isActive()) {
      reelTween.play(); gsap.fromTo(reelTween, { timeScale: 1 }, { timeScale: 0, duration: 0.9, ease: 'power2.out', onComplete: () => reelTween.pause() });
    }
  }
}

if (window.HBLook) {
  // Power the current gear down, swap looks while it's dark, power the new one up.
  window.HBLook.transition = (apply, to) => {
    if (!motion || document.hidden) { apply(); return; }
    // Never leave the visitor on the old look, even if the timeline is interrupted.
    setTimeout(() => { if (look() !== to) apply(); }, 900);
    const main = document.querySelector('main');
    const from = look();
    const tl = gsap.timeline();
    if (from === 'hifi') tl.to('.backlight', { opacity: 0.9, duration: 0.22, ease: 'power2.in' });
    else if (reelTween) tl.to(reelTween, { timeScale: 0, duration: 0.25 });
    tl.to(main, { opacity: 0, y: 6, duration: 0.18, ease: 'power2.in' });
    tl.add(() => { apply(); });
    tl.to(main, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', clearProps: 'opacity,transform' });
    tl.add(() => { powerOn(); window.dispatchEvent(new CustomEvent('lookpowered')); }, '<');
  };
}

/* ───────── content pages: figures power on as they scroll in ───────── */
export function reveals() {
  if (!motion || !window.ScrollTrigger) return;
  document.querySelectorAll('[data-reveal]').forEach((node) => {
    gsap.from(node, { opacity: 0, y: 24, duration: 0.6, ease: 'power3.out', scrollTrigger: { trigger: node, start: 'top 85%', once: true } });
  });
  document.querySelectorAll('.fig .meter').forEach((svg) => {
    gsap.from(svg, { opacity: 0.3, duration: 0.6, scrollTrigger: { trigger: svg, start: 'top 80%', once: true } });
  });
}

/** FAQ: answers slide open like a drawer instead of popping. */
export function drawers() {
  if (!motion) return;
  document.querySelectorAll('details.qa').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      const a = d.querySelector('.answer');
      if (a) gsap.fromTo(a, { height: 0, opacity: 0 }, { height: 'auto', opacity: 1, duration: 0.35, ease: 'power2.out', clearProps: 'height,opacity' });
    });
  });
}

// Pause everything when the tab is hidden.
if (gsap) document.addEventListener('visibilitychange', () => { document.hidden ? gsap.globalTimeline.pause() : gsap.globalTimeline.resume(); });
