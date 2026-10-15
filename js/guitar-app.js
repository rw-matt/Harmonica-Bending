import {
  TUNINGS, AMOUNTS, KEYS, TOLERANCES, noteName, midiToFreq, freqToMidi, openNote, stringName, stringWord,
  buildTarget, targetLabel, bendTip, tuningTip, presets, tabFor, keyUsesFlats,
} from './guitar.js';
import { createDetector, createSmoother } from './pitch.js';

/* ───────── helpers ───────── */
const $ = (id) => document.getElementById(id);
// Only settings are saved. Practice results live in memory and vanish on reload.
const store = {
  get(k, d) { try { const v = localStorage.getItem('gb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gb.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const HOLD_GOAL = 0.3;        // seconds on target to count as "nailed" (guitar notes decay, so a little shorter)
const TRACE_MS = 6000;
const GAUGE_SPAN = 1.3;       // the gauge runs from the fretted note to 130% of the bend
const NECK_FRETS = 17;

/** Wrap ♭/♯ so the display font doesn't fall back to an odd glyph. */
const acc = (s) => s.replace(/([♭♯])/g, '<span class="acc">$1</span>');

/* ───────── state ───────── */
const state = {
  tuning: TUNINGS.find((t) => t.id === store.get('tuning', 'std')) || TUNINGS[0],
  keyId: store.get('key', 'A'),
  mode: store.get('mode', 'minor'),
  string: store.get('string', 3),
  fret: store.get('fret', 7),
  amountId: store.get('amount', 'f'),
  tolerance: TOLERANCES.find((t) => t.id === store.get('tolerance', 'normal')) || TOLERANCES[1],
  lefty: store.get('lefty', false),
  inputId: store.get('input', ''),
  target: null,
  listening: false,
  trace: [],
  attempt: null,
  results: [],   // this page visit only
  mood: '',
};
const tol = () => state.tolerance.cents;
const spelling = () => ({ flats: state.tuning.flats || keyUsesFlats(state.keyId, state.mode) });
const nn = (m, oct = false) => noteName(m, spelling(), oct);
const tgtName = (t, oct = false) => targetLabel(t, spelling(), oct);

const audio = {
  ctx: null, stream: null, source: null, analyser: null, buf: null,
  detect: null, smooth: createSmoother(5), raf: 0, muteUntil: 0,
  recorder: null, chunks: [], takeUrl: null, recTimer: 0,
};

/* ───────── pickers (key, bend, settings) ───────── */
const sheets = { stepKey: 'keySheet', stepBend: 'bendSheet', settingsBtn: 'settingsSheet' };
function toggleSheet(btnId, open) {
  for (const [b, sheet] of Object.entries(sheets)) {
    const show = b === btnId ? (open ?? $(sheet).hidden) : false;
    $(sheet).hidden = !show;
    $(b).setAttribute('aria-expanded', String(show));
  }
}

function renderKeys() {
  $('keys').innerHTML = KEYS.map((k) => `<button type="button" class="key" data-key="${k.id}" aria-pressed="${k.id === state.keyId}">${k.id}</button>`).join('');
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('stepKeyVal').textContent = `${state.keyId} ${state.mode}`;
  $('presetsLabel').textContent = `Classic bends in ${state.keyId} ${state.mode}`;
}

function renderPresets() {
  $('presets').innerHTML = presets(state.tuning, state.keyId, state.mode).map((p) => {
    const t = buildTarget(state.tuning, p.string, p.fret, p.amount);
    const on = p.string === state.string && p.fret === state.fret && p.amount === state.amountId;
    return `<button type="button" class="preset${on ? ' on' : ''}" data-preset="${p.string}-${p.fret}-${p.amount}">
      ${stringName(state.tuning, p.string)} string · ${p.fret} · ${t.amount.label}<small>${p.box} · ${acc(nn(t.naturalMidi))} → ${acc(tgtName(t))}</small></button>`;
  }).join('');
}

function renderSettings() {
  $('tunings').innerHTML = TUNINGS.map((t) => `<button type="button" class="key" data-tuning="${t.id}" aria-pressed="${t.id === state.tuning.id}">${t.label}</button>`).join('');
  const strings = [6, 5, 4, 3, 2, 1].map((s) => stringName(state.tuning, s)).join(' ');
  $('tuningNote').innerHTML = `<strong>${strings}.</strong> ${tuningTip(state.tuning)}`;
  $('tolerances').innerHTML = TOLERANCES.map((t) => `<button type="button" class="key" data-tol="${t.id}" aria-pressed="${t.id === state.tolerance.id}" title="${t.hint}">${t.label}</button>`).join('');
  $('tolNote').textContent = state.tolerance.hint;
  $('leftyToggle').setAttribute('aria-checked', String(state.lefty));
  $('settingsVal').textContent = state.tuning.short;
}

function renderSizes() {
  const html = AMOUNTS.map((a) => `<button type="button" data-amount="${a.id}" aria-pressed="${a.id === state.amountId}" title="${a.name}">${a.label}</button>`).join('');
  document.querySelectorAll('.sizes').forEach((el) => { el.innerHTML = html; });
}

/* ───────── the neck ───────── */
// Drawn like tab: high e on top. Fret spacing follows a real guitar (each fret ~5.6% shorter).
function neckSVG(interactive) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const W = 1040, top = 32, bottom = 222, nut = 44, end = W - 24, H = 254;
  const span = (n) => (1 - Math.pow(2, -n / 17)) / (1 - Math.pow(2, -NECK_FRETS / 17));
  const raw = (n) => nut + (end - nut) * span(n);
  const fx = (n) => (state.lefty ? W - raw(n) : raw(n));
  const mid = (n) => (fx(n - 1) + fx(n)) / 2;
  const sy = (s) => top + (s - 1) * ((bottom - top) / 5);
  const t = state.target;
  const wood = dark ? ['#1b2433', '#121926'] : ['#ece4d6', '#ddd2c1'];
  const inlay = dark ? 'rgba(203,233,253,.16)' : 'rgba(60,40,20,.16)';
  const left = Math.min(fx(0), fx(NECK_FRETS)), right = Math.max(fx(0), fx(NECK_FRETS));
  let o = `<defs>
    <linearGradient id="wood${interactive}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${wood[0]}"/><stop offset="1" stop-color="${wood[1]}"/></linearGradient>
    <radialGradient id="glow${interactive}"><stop offset="0" stop-color="#4a8dfd" stop-opacity=".85"/><stop offset="1" stop-color="#4a8dfd" stop-opacity="0"/></radialGradient>
    <linearGradient id="dot${interactive}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a8dfd"/><stop offset="1" stop-color="#1951fc"/></linearGradient>
    <marker id="arr${interactive}" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--accent-text)"/></marker>
  </defs>`;
  o += `<rect x="${left}" y="${top - 18}" width="${right - left}" height="${bottom - top + 36}" rx="10" fill="url(#wood${interactive})"/>`;
  for (const n of [3, 5, 7, 9, 15, 17]) o += `<circle cx="${mid(n)}" cy="${(top + bottom) / 2}" r="7" fill="${inlay}"/>`;
  o += `<circle cx="${mid(12)}" cy="${sy(2) + 18}" r="7" fill="${inlay}"/><circle cx="${mid(12)}" cy="${sy(5) - 18}" r="7" fill="${inlay}"/>`;
  o += `<rect x="${fx(0) - 4}" y="${top - 18}" width="8" height="${bottom - top + 36}" rx="2" fill="${dark ? '#cbd5e6' : '#f8f4ec'}" stroke="${dark ? 'none' : 'rgba(0,0,0,.15)'}"/>`;
  for (let n = 1; n <= NECK_FRETS; n++) {
    o += `<line x1="${fx(n)}" x2="${fx(n)}" y1="${top - 18}" y2="${bottom + 18}" stroke="${dark ? '#7d8aa3' : '#a59a8a'}" stroke-width="3"/>`;
    const marked = [3, 5, 7, 9, 12, 15, 17].includes(n);
    o += `<text x="${mid(n)}" y="${H - 2}" text-anchor="middle" class="neck-num${marked ? ' marked' : ''}">${n}</text>`;
  }
  for (let s = 1; s <= 6; s++) {
    o += `<line x1="${left}" x2="${right}" y1="${sy(s)}" y2="${sy(s)}" stroke="${s > 3 ? (dark ? '#c9a77a' : '#9c7a4a') : (dark ? '#d7dee9' : '#8b8f96')}" stroke-width="${0.8 + s * 0.55}"/>`;
    o += `<text x="${state.lefty ? W - 16 : 16}" y="${sy(s) + 5}" text-anchor="middle" class="neck-str">${stringName(state.tuning, s)}</text>`;
  }
  // target ring (where the bent pitch lives on the same string) + selected dot + bend direction
  const cx = mid(t.fret), cy = sy(t.string);
  const steps = t.cents / 100;
  if (Number.isInteger(steps) && t.fret + steps <= NECK_FRETS) {
    const tx = mid(t.fret + steps);
    o += `<circle cx="${tx}" cy="${cy}" r="15" fill="none" stroke="var(--good)" stroke-width="2.5" stroke-dasharray="5 4"/>`;
    o += `<text x="${tx}" y="${cy + 5}" text-anchor="middle" class="neck-tgt">${tgtName(t)}</text>`;
  }
  // On guitar, "up" means toward the ceiling = toward the low E string, which is DOWN in a tab-style diagram.
  const high = t.string <= 3, dir = high ? 1 : -1;
  o += `<circle cx="${cx}" cy="${cy}" r="34" fill="url(#glow${interactive})" class="neck-glow"/>`;
  o += `<path d="M${cx} ${cy + dir * 20} L${cx} ${cy + dir * 50}" stroke="var(--accent-text)" stroke-width="2.5" stroke-linecap="round" marker-end="url(#arr${interactive})"/>`;
  o += `<text x="${cx + (state.lefty ? -12 : 12)}" y="${cy + dir * 44 + (high ? 4 : 0)}" text-anchor="${state.lefty ? 'end' : 'start'}" class="neck-dir">${high ? 'push toward the ceiling' : 'pull toward the floor'}</text>`;
  o += `<circle cx="${cx}" cy="${cy}" r="17" fill="url(#dot${interactive})" stroke="#fff" stroke-width="2.5" class="neck-dot"/>`;
  o += `<text x="${cx}" y="${cy + 5}" text-anchor="middle" class="neck-dot-lbl">${nn(t.naturalMidi)}</text>`;
  // invisible hit areas so any string/fret can be tapped
  for (let s = 1; s <= 6; s++) {
    for (let n = 1; n <= NECK_FRETS; n++) {
      const x0 = Math.min(fx(n - 1), fx(n)), w = Math.abs(fx(n) - fx(n - 1));
      o += `<rect class="neck-hit" x="${x0}" y="${sy(s) - 16}" width="${w}" height="32" data-sf="${s}-${n}"><title>${stringName(state.tuning, s)} string, fret ${n}: ${nn(openNote(state.tuning, s) + n)}</title></rect>`;
    }
  }
  return o;
}

function renderNecks() {
  document.querySelectorAll('.neck').forEach((svg) => { svg.innerHTML = neckSVG(svg.id === 'neckMain' ? 'm' : 's'); });
}

/* ───────── target ───────── */
function rebuild() {
  state.target = buildTarget(state.tuning, state.string, state.fret, state.amountId);
  if (audio.analyser) makeDetector();
  renderKeys(); renderSettings(); renderSizes(); renderPresets(); renderNecks(); renderTarget();
  state.trace = []; state.attempt = null; drawTrace();
}

function setPosition(s, f, amountId) {
  state.string = s; state.fret = f; store.set('string', s); store.set('fret', f);
  if (amountId) { state.amountId = amountId; store.set('amount', amountId); }
  rebuild();
}

function renderTarget() {
  const t = state.target;
  const nat = nn(t.naturalMidi), tgt = tgtName(t);
  $('headline').innerHTML = `Bend the ${stringWord(state.tuning, t.string)} string at fret ${t.fret} up ${t.amount.phrase}.`;
  $('subline').innerHTML = `Pick ${acc(nat)}, then push the string until it sounds ${acc(tgt)}.`;
  $('tabLine').innerHTML = `<span class="tab-str">${stringName(state.tuning, t.string)}</span>|--${tabFor(t)}--|`;
  $('tabLabel').textContent = t.amount.cents % 100 ? 'quarter-tone curl' : `${t.amount.label === 'Full' ? 'full' : t.amount.label + ' step'} bend`;
  $('stepBendVal').textContent = `${stringName(state.tuning, t.string)} string ${t.fret} · ${t.amount.label}`;
  $('playNatural').querySelector('span').innerHTML = `Fretted ${acc(nat)}`;
  $('playTarget').querySelector('span').innerHTML = `Target ${acc(tgt)}`;
  $('gNat').innerHTML = `${acc(nat)} · fret ${t.fret}`;
  $('gMid').textContent = t.cents >= 200 ? '½' : '';
  $('gTgt').innerHTML = `${acc(tgt)} · ${t.amount.label === 'Full' ? 'Full' : t.amount.label}`;
  $('gaugeOf').textContent = `of a ${t.amount.cents % 100 ? 'quarter-tone' : t.amount.label === 'Full' ? 'full' : t.amount.label + '-step'} bend`;
  $('tipTitle').textContent = `${t.amount.label === 'Full' ? 'Full' : t.amount.label} bend tip`;
  $('tipText').textContent = bendTip(t);
  drawGaugeFrame();
  setGauge(null);
}

/* ───────── bend-depth gauge ───────── */
const G = { cx: 120, cy: 122, r: 100 };
const gPoint = (f) => {
  const a = Math.PI * (1 - clamp(f, 0, 1));
  return [G.cx + G.r * Math.cos(a), G.cy - G.r * Math.sin(a)];
};
const gArc = (f0, f1) => {
  const [x0, y0] = gPoint(f0), [x1, y1] = gPoint(f1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${G.r} ${G.r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
function drawGaugeFrame() {
  const size = state.target.cents;
  $('gTrack').setAttribute('d', gArc(0, 1));
  $('gZone').setAttribute('d', gArc(Math.max(0, size - tol()) / size / GAUGE_SPAN, (size + tol()) / size / GAUGE_SPAN));
}
function setGauge(c) {
  const gauge = document.querySelector('.gauge');
  if (c == null) { gauge.setAttribute('class', 'gauge is-idle'); $('gaugePct').textContent = '0%'; return; }
  const tc = state.target.cents, p = c / tc, f = clamp(p / GAUGE_SPAN, 0, 1);
  const on = Math.abs(c - tc) <= tol(), over = !on && p > 1;
  gauge.setAttribute('class', `gauge${on ? ' is-on' : over ? ' is-over' : ''}`);
  $('gFill').setAttribute('d', gArc(0, Math.max(f, 0.001)));
  const [kx, ky] = gPoint(f);
  $('gKnob').setAttribute('cx', kx.toFixed(2)); $('gKnob').setAttribute('cy', ky.toFixed(2));
  $('gaugePct').textContent = `${Math.round(clamp(p, 0, 9.99) * 100)}%`;
}

/* ───────── live readout ───────── */
function setStatus(kind, text) {
  const el = $('micStatus');
  el.className = `status${kind ? ' is-' + kind : ''}`;
  el.lastElementChild.textContent = text;
}

function updateLive(midi, c) {
  const necks = document.querySelectorAll('.neck');
  if (midi == null) {
    $('noteBig').innerHTML = '<span class="idle">—</span>'; $('noteBig').classList.remove('is-on');
    necks.forEach((n) => n.classList.remove('is-hit'));
    if (state.listening) { setStatus('live', 'Listening'); $('where').textContent = `Pick fret ${state.fret} on the ${stringWord(state.tuning, state.string)} string.`; }
    return;
  }
  const near = Math.round(midi), dev = Math.round((midi - near) * 100);
  $('noteBig').innerHTML = `${acc(nn(near))}<sub>${Math.floor(near / 12) - 1}</sub>`;
  const tc = state.target.cents;
  const onTarget = c != null && Math.abs(c - tc) <= tol();
  $('noteBig').classList.toggle('is-on', onTarget);
  necks.forEach((n) => n.classList.toggle('is-hit', onTarget));
  setStatus(onTarget ? 'on' : 'live', onTarget ? 'On target' : `${dev > 0 ? '+' : ''}${dev}¢`);
  if (c != null && c > -60 && c < tc + 150) {
    $('where').innerHTML = c < 15 ? '<strong>Fretted note</strong>. Now push the string'
      : onTarget ? `<strong>Bent ${Math.round(c)}¢</strong> of ${tc}¢. Hold it there`
        : c < tc ? `<strong>Bent ${Math.round(c)}¢</strong> of ${tc}¢. Push a little further`
          : `<strong>Bent ${Math.round(c)}¢</strong> of ${tc}¢. Ease off a little`;
  } else {
    $('where').textContent = `That's not fret ${state.fret} on the ${stringWord(state.tuning, state.string)} string.`;
  }
}

function setMood(mood) {
  if (mood === state.mood) return;
  state.mood = mood;
  document.body.dataset.mood = mood;
}

/* ───────── attempt scoring ───────── */
function trackAttempt(c, now) {
  const tc = state.target.cents;
  const voiced = c != null && c >= -80 && c <= tc + 150;
  let a = state.attempt;
  if (voiced) {
    if (!a) a = state.attempt = { start: now, last: now, lastVoiced: now, extreme: 0, onTarget: 0, bestRun: 0, run: 0, closest: Infinity };
    const dt = Math.min(0.1, (now - a.last) / 1000);
    a.last = now; a.lastVoiced = now;
    a.extreme = Math.max(a.extreme, c / tc);
    const dist = Math.abs(c - tc);
    a.closest = Math.min(a.closest, dist);
    if (dist <= tol()) { a.onTarget += dt; a.run += dt; a.bestRun = Math.max(a.bestRun, a.run); } else a.run = 0;
  } else if (a) {
    a.last = now;
    if (now - a.lastVoiced > 300) { finishAttempt(a); state.attempt = null; }
  }
}

function finishAttempt(a) {
  const dur = (a.lastVoiced - a.start) / 1000;
  if (dur < 0.25) return;
  const t = state.target, size = t.cents;
  const tgt = acc(tgtName(t));
  const moved = a.extreme * size, past = (a.extreme - 1) * size;
  const reached = Math.round(clamp(a.extreme, 0, 9.99) * size);

  let cls, title, msg;
  if (a.bestRun >= HOLD_GOAL) {
    cls = 'good'; title = `Nailed it. You held ${tgt} for ${a.bestRun.toFixed(1)}s.`;
    msg = state.tolerance.id === 'strict'
      ? 'Studio-tight. Now add a little vibrato at the top, then try a bend and release back to the fretted note.'
      : `Now add a little vibrato at the top. Ready for more? Switch accuracy to ${state.tolerance.id === 'easy' ? 'Normal' : 'Strict'} in settings.`;
  } else if (moved < 15) {
    cls = 'miss'; title = "The note didn't move";
    msg = `You played a clean ${acc(nn(t.naturalMidi))}. Now push the string sideways across the fret, with two fingers behind the bending finger, while it's still ringing.`;
  } else if (past > tol() + 5) {
    cls = 'close'; title = `Too far, ${Math.round(past)}¢ past ${tgt}`;
    msg = 'You have the strength. Ease off a little and stop as the gauge turns green. Fret the target note first to lock its sound in your ear.';
  } else if (a.closest <= tol()) {
    cls = 'close'; title = 'You touched it. Now hold it.';
    msg = `You reached ${tgt} but slipped off. Lock your wrist at the top of the bend and keep your fingers pressing so the note doesn't sag.`;
  } else {
    const pct = Math.round(clamp(a.extreme, 0, 1) * 100);
    cls = pct >= 50 ? 'close' : 'miss';
    title = `${pct}% of the way there`;
    msg = pct >= 50
      ? `You bent about ${reached}¢ of ${size}¢. Under-bending is the most common mistake: push a little further, rotating from the wrist.`
      : 'The note started to move. Use your wrist, not just your fingertip, and stack your other fingers behind the bending finger for strength.';
  }

  const r = $('result');
  r.className = `card result ${cls}`;
  r.innerHTML = `<span class="lbl">Last result</span><h3 class="display">${title}</h3><p class="muted">${msg}</p>
    <div class="stats">
      <span class="chip">Reached: ${reached}¢ of ${size}¢</span>
      <span class="chip">Closest: ${a.closest === Infinity ? '—' : `${Math.round(a.closest)}¢ off`}</span>
      <span class="chip">Held: ${dur.toFixed(1)}s</span>
    </div>`;
  state.results.push(cls);
  renderSession();
  if (typeof gtag === 'function') gtag('event', 'bend_attempt', { instrument: 'guitar', result: cls, bend: `${t.string}-${t.fret}-${t.amount.id}`, accuracy: state.tolerance.id });
}

function renderSession() {
  const good = state.results.filter((x) => x === 'good').length;
  $('sessionScore').textContent = `${good} / ${state.results.length}`;
  $('pips').innerHTML = state.results.slice(-24).map((x) => `<i class="${x}" title="${x === 'good' ? 'Nailed' : x === 'close' ? 'Close' : 'Missed'}"></i>`).join('');
}

/* ───────── pitch trace ───────── */
const canvas = $('trace');
const g = canvas.getContext('2d');
let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  colors = { ink: v('--ink'), ink3: v('--ink-3'), good: v('--good'), bad: v('--bad'), accent: v('--accent') };
  renderNecks();
  drawTrace();
}
function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrace();
}
function drawTrace(now = performance.now()) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !colors.ink) return;
  const t = state.target, tc = t.cents;
  const top = tc + 100, bot = -100;
  const y = (c) => ((top - c) / (top - bot)) * H;
  g.clearRect(0, 0, W, H);
  g.fillStyle = colors.good; g.globalAlpha = 0.16;
  g.fillRect(0, y(tc + tol()), W, y(tc - tol()) - y(tc + tol()));
  g.globalAlpha = 1;
  g.font = '700 13px "League Spartan", -apple-system, sans-serif';
  g.textBaseline = 'middle'; g.lineWidth = 1;
  const lines = [];
  for (let s = Math.ceil(bot / 100); s <= Math.floor(top / 100); s++) lines.push(s * 100);
  if (!lines.includes(tc)) lines.push(tc);
  for (const cents of lines) {
    const yy = y(cents), isNat = cents === 0, isTgt = cents === tc;
    g.strokeStyle = isTgt ? colors.good : colors.ink3;
    g.globalAlpha = isNat || isTgt ? 0.6 : 0.18;
    g.setLineDash(isNat || isTgt ? [] : [3, 5]);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); g.setLineDash([]);
    if (isNat || isTgt) {
      g.globalAlpha = 1;
      g.fillStyle = isTgt ? colors.good : colors.ink3;
      g.textAlign = 'left';
      g.fillText(isNat ? `FRETTED · ${nn(t.naturalMidi)}` : `TARGET · ${tgtName(t)}`, 12, yy - 10);
    }
  }
  g.globalAlpha = 1;
  const pts = state.trace;
  g.lineWidth = 3.5; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.c == null || b.c == null) continue;
    const xa = W - ((now - a.t) / TRACE_MS) * W, xb = W - ((now - b.t) / TRACE_MS) * W;
    const dist = Math.abs(b.c - tc);
    g.strokeStyle = dist <= tol() ? colors.good : (b.c > tc ? colors.bad : colors.accent);
    g.beginPath(); g.moveTo(xa, clamp(y(a.c), -10, H + 10)); g.lineTo(xb, clamp(y(b.c), -10, H + 10)); g.stroke();
  }
  const last = pts[pts.length - 1];
  if (last && last.c != null && now - last.t < 120) {
    g.fillStyle = colors.ink;
    g.beginPath(); g.arc(W - 4, clamp(y(last.c), 4, H - 4), 5, 0, Math.PI * 2); g.fill();
  }
}

/* ───────── microphone + input picker ───────── */
function ensureCtx() {
  if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}
// Listen only around the chosen string and bend. Guitar notes have strong overtones,
// and a narrow window stops the detector from jumping an octave.
function makeDetector() {
  const t = state.target;
  audio.detect = createDetector({ sampleRate: audio.ctx.sampleRate, minFreq: midiToFreq(t.naturalMidi - 2), maxFreq: midiToFreq(t.targetMidi + 2) });
}
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 6000);
}

// Device names only appear after the browser has been given mic permission once.
async function renderInputs() {
  const sel = $('inputSelect');
  if (!navigator.mediaDevices?.enumerateDevices) { sel.disabled = true; return; }
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const named = inputs.some((d) => d.label);
  sel.innerHTML = '<option value="">Default microphone</option>' + inputs
    .filter((d) => d.deviceId && d.deviceId !== 'default')
    .map((d, i) => `<option value="${d.deviceId}"${d.deviceId === state.inputId ? ' selected' : ''}>${d.label || `Input ${i + 1}`}</option>`).join('');
  $('inputNote').textContent = named
    ? 'Using an audio interface or USB amp? Pick it here for the cleanest signal.'
    : 'Press Start listening once and allow the mic. Your audio interface and other inputs will then show up here.';
}

function setListeningUI(on) {
  $('micBtn').classList.toggle('is-live', on);
  $('micBtn').innerHTML = on ? '<svg><use href="#i-stop"/></svg><span>Stop listening</span>' : '<svg><use href="#i-mic"/></svg><span>Start listening</span>';
  $('stepPlay').classList.toggle('is-on', on);
  $('stepPlayVal').textContent = on ? 'Listening' : 'Play';
  $('traceEmpty').hidden = on;
  $('recBtn').disabled = !on || typeof MediaRecorder === 'undefined';
}
async function startMic() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus('error', 'Mic unavailable');
    toast('The microphone only works on a secure (https://) page or on localhost.');
    return;
  }
  try {
    const ctx = ensureCtx();
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (state.inputId) constraints.deviceId = { exact: state.inputId };
    try {
      audio.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
      // The saved input was unplugged: fall back to the default mic.
      state.inputId = ''; store.set('input', '');
      delete constraints.deviceId;
      audio.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      toast('Your saved input wasn\'t found, so the default microphone is being used.');
    }
    audio.source = ctx.createMediaStreamSource(audio.stream);
    audio.analyser = ctx.createAnalyser();
    audio.analyser.fftSize = 4096;
    audio.buf = new Float32Array(audio.analyser.fftSize);
    audio.source.connect(audio.analyser);
    makeDetector();
    state.listening = true;
    setListeningUI(true);
    updateLive(null);
    renderInputs();
    loop();
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.'
      : err?.name === 'NotFoundError' ? 'No microphone was found on this device.' : `Couldn't start the microphone (${err?.message || err}).`;
    setStatus('error', 'Mic blocked');
    toast(msg);
  }
}
function stopMic() {
  cancelAnimationFrame(audio.raf);
  if (audio.recorder?.state === 'recording') audio.recorder.stop();
  audio.stream?.getTracks().forEach((tr) => tr.stop());
  audio.source?.disconnect();
  Object.assign(audio, { stream: null, source: null, analyser: null });
  state.listening = false; state.attempt = null;
  setListeningUI(false);
  setStatus('', 'Mic off');
  $('where').textContent = 'Press Start listening, then play.';
  updateLive(null); setGauge(null); setMood('');
  drawTrace();
}
const toggleMic = () => (state.listening ? stopMic() : startMic());

function loop() {
  audio.raf = requestAnimationFrame(loop);
  const now = performance.now();
  let midi = null;
  if (now > audio.muteUntil) {
    audio.analyser.getFloatTimeDomainData(audio.buf);
    const r = audio.detect(audio.buf, 0.006);
    const f = audio.smooth(r && r.clarity > 0.8 ? r.freq : null);
    if (f) midi = freqToMidi(f);
  } else audio.smooth(null);
  const t = state.target;
  const c = midi == null ? null : (midi - t.naturalMidi) * 100;
  state.trace.push({ t: now, c });
  while (state.trace.length && now - state.trace[0].t > TRACE_MS + 200) state.trace.shift();
  updateLive(midi, c);
  const inZone = c != null && c >= -80 && c <= t.cents + 150;
  setGauge(inZone ? c : null);
  trackAttempt(c, now);
  setMood(c != null && Math.abs(c - t.cents) <= tol() ? 'on' : '');
  drawTrace(now);
}

/* ───────── reference tones: a simple plucked-string sound ───────── */
function pluck(ctx, freq, start, dur) {
  const out = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 1;
  lp.frequency.setValueAtTime(Math.min(freq * 8, 9000), start);
  lp.frequency.exponentialRampToValueAtTime(Math.min(freq * 2.5, 4000), start + dur);
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'triangle';
  o1.frequency.value = freq; o2.frequency.value = freq; o2.detune.value = 4;
  const mix2 = ctx.createGain(); mix2.gain.value = 0.6;
  o1.connect(lp); o2.connect(mix2).connect(lp); lp.connect(out).connect(ctx.destination);
  out.gain.setValueAtTime(0, start);
  out.gain.linearRampToValueAtTime(0.2, start + 0.008);
  out.gain.exponentialRampToValueAtTime(0.06, start + 0.5);
  out.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  [o1, o2].forEach((o) => { o.start(start); o.stop(start + dur + 0.05); });
  return [o1, o2];
}
function playNote(midi, dur = 1.6) {
  const ctx = ensureCtx();
  pluck(ctx, midiToFreq(midi), ctx.currentTime + 0.02, dur);
  audio.muteUntil = performance.now() + dur * 1000 + 200;
}
function playSlide() {
  const ctx = ensureCtx(), t = state.target;
  const f0 = midiToFreq(t.naturalMidi), f1 = midiToFreq(t.targetMidi);
  const s = ctx.currentTime + 0.02, dur = 2.4;
  pluck(ctx, f0, s, dur).forEach((o) => { o.frequency.setValueAtTime(f0, s + 0.35); o.frequency.exponentialRampToValueAtTime(f1, s + 0.85); });
  audio.muteUntil = performance.now() + dur * 1000 + 200;
}

/* ───────── record & compare (kept in memory only) ───────── */
function toggleRecord() {
  if (audio.recorder?.state === 'recording') { audio.recorder.stop(); return; }
  if (!audio.stream) return;
  audio.chunks = [];
  audio.recorder = new MediaRecorder(audio.stream);
  audio.recorder.ondataavailable = (e) => e.data.size && audio.chunks.push(e.data);
  audio.recorder.onstop = () => {
    clearTimeout(audio.recTimer);
    if (audio.takeUrl) URL.revokeObjectURL(audio.takeUrl);
    audio.takeUrl = URL.createObjectURL(new Blob(audio.chunks, { type: audio.recorder.mimeType }));
    $('recBtn').querySelector('span').textContent = 'Record again';
    $('recBtn').classList.remove('is-recording');
    $('takeRow').hidden = false;
  };
  audio.recorder.start();
  $('recBtn').querySelector('span').textContent = 'Stop (max 8s)';
  $('recBtn').classList.add('is-recording');
  audio.recTimer = setTimeout(() => audio.recorder?.state === 'recording' && audio.recorder.stop(), 8000);
}
function playTake(delay = 0) {
  if (!audio.takeUrl) return;
  setTimeout(() => {
    const el = new Audio(audio.takeUrl);
    audio.muteUntil = Infinity;
    el.onended = el.onerror = () => { audio.muteUntil = performance.now() + 200; };
    el.play().catch(() => { audio.muteUntil = 0; });
  }, delay);
}

/* ───────── events ───────── */
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-key]');
  if (k) { state.keyId = k.dataset.key; store.set('key', state.keyId); return rebuild(); }
  const m = e.target.closest('[data-mode]');
  if (m) { state.mode = m.dataset.mode; store.set('mode', state.mode); return rebuild(); }
  const p = e.target.closest('[data-preset]');
  if (p) { const [s, f, a] = p.dataset.preset.split('-'); return setPosition(+s, +f, a); }
  const tu = e.target.closest('[data-tuning]');
  if (tu) { state.tuning = TUNINGS.find((t) => t.id === tu.dataset.tuning) || state.tuning; store.set('tuning', state.tuning.id); return rebuild(); }
  const to = e.target.closest('[data-tol]');
  if (to) { state.tolerance = TOLERANCES.find((t) => t.id === to.dataset.tol) || state.tolerance; store.set('tolerance', state.tolerance.id); return rebuild(); }
  const am = e.target.closest('[data-amount]');
  if (am) { state.amountId = am.dataset.amount; store.set('amount', state.amountId); return rebuild(); }
  const sf = e.target.closest('[data-sf]');
  if (sf) {
    const [s, f] = sf.dataset.sf.split('-').map(Number);
    setPosition(s, f);
    if (sf.closest('#bendSheet')) toggleSheet('stepBend', false);
    return;
  }
  if (e.target.closest('#leftyToggle')) { state.lefty = !state.lefty; store.set('lefty', state.lefty); return rebuild(); }
  if (e.target.closest('[data-close]')) return toggleSheet(null);
});
// Space starts/stops listening, since both hands are on the guitar. Leave it alone when a control has focus.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return toggleSheet(null);
  if (e.code === 'Space' && !e.repeat && !e.target.closest('button, a, input, select, textarea, summary, [contenteditable]')) {
    e.preventDefault();
    toggleMic();
  }
});
$('inputSelect').addEventListener('change', (e) => {
  state.inputId = e.target.value; store.set('input', state.inputId);
  if (state.listening) { stopMic(); startMic(); }
});
navigator.mediaDevices?.addEventListener?.('devicechange', renderInputs);
$('stepKey').addEventListener('click', () => toggleSheet('stepKey'));
$('stepBend').addEventListener('click', () => toggleSheet('stepBend'));
$('settingsBtn').addEventListener('click', () => toggleSheet('settingsBtn'));
$('stepPlay').addEventListener('click', () => {
  toggleSheet(null);
  if (!state.listening) document.querySelector('.stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toggleMic();
});
$('micBtn').addEventListener('click', toggleMic);
$('playNatural').addEventListener('click', () => playNote(state.target.naturalMidi));
$('playTarget').addEventListener('click', () => playNote(state.target.targetMidi));
$('playSlide').addEventListener('click', playSlide);
$('recBtn').addEventListener('click', toggleRecord);
$('playTake').addEventListener('click', () => playTake());
$('compareTake').addEventListener('click', () => { playNote(state.target.targetMidi, 1.4); playTake(1700); });
$('resetSession').addEventListener('click', () => { state.results = []; renderSession(); });
window.addEventListener('themechange', readColors);

new ResizeObserver(sizeCanvas).observe(canvas);
rebuild();
renderSession();
renderInputs();
readColors();
sizeCanvas();
