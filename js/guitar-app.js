import {
  TUNINGS, AMOUNTS, noteName, midiToFreq, freqToMidi, openNote, stringName, stringWord,
  buildTarget, targetLabel, bendTip, tuningTip,
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
const ON_TARGET_CENTS = 20;   // within ±20¢ counts as hitting the bend
const HOLD_GOAL = 0.3;        // seconds on target to count as "nailed" (guitar notes decay, so a little shorter)
const TRACE_MS = 6000;
const GAUGE_SPAN = 1.3;       // the gauge runs from the fretted note to 130% of the bend
const MAP_FRETS = 17;

/** Wrap ♭/♯ so the display font doesn't fall back to an odd glyph. */
const acc = (s) => s.replace(/([♭♯])/g, '<span class="acc">$1</span>');

/* ───────── state ───────── */
const state = {
  tuning: TUNINGS.find((t) => t.id === store.get('tuning', 'std')) || TUNINGS[0],
  string: store.get('string', 3),
  fret: store.get('fret', 7),
  amountId: store.get('amount', 'f'),
  target: null,
  listening: false,
  trace: [],
  attempt: null,
  results: [],   // this page visit only
  mood: '',
};
const nn = (m, oct = false) => noteName(m, state.tuning, oct);

const audio = {
  ctx: null, stream: null, source: null, analyser: null, buf: null,
  detect: null, smooth: createSmoother(5), raf: 0, muteUntil: 0,
  recorder: null, chunks: [], takeUrl: null, recTimer: 0,
};

/* ───────── setup steps (pickers) ───────── */
const sheets = { stepKey: 'keySheet', stepBend: 'bendSheet' };
function toggleSheet(stepId, open) {
  for (const [s, sheet] of Object.entries(sheets)) {
    const show = s === stepId ? (open ?? $(sheet).hidden) : false;
    $(sheet).hidden = !show;
    $(s).setAttribute('aria-expanded', String(show));
  }
}

function renderTunings() {
  $('tunings').innerHTML = TUNINGS.map((t) => `<button type="button" class="key" data-tuning="${t.id}" aria-pressed="${t.id === state.tuning.id}">${t.label}</button>`).join('');
  const strings = [6, 5, 4, 3, 2, 1].map((s) => stringName(state.tuning, s)).join(' ');
  $('feel').innerHTML = `<strong>${state.tuning.label} · ${strings}.</strong> ${tuningTip(state.tuning)}`;
  $('stepKeyVal').textContent = state.tuning.short;
}

function renderAmounts() {
  $('amounts').innerHTML = $('amountsMain').innerHTML = AMOUNTS.map((a) => `<button type="button" class="key" data-amount="${a.id}" aria-pressed="${a.id === state.amountId}" title="${a.name}">${a.label}${a.cents >= 100 ? '' : ' tone'}</button>`).join('');
}

/** Fretboard laid out like tab: high e on top, frets across. */
function fretboardHTML(live) {
  const id = (v) => (live ? ` id="${v}"` : '');
  let html = '<div class="fb-corner"></div>';
  for (let f = 1; f <= MAP_FRETS; f++) html += `<div class="fb-num${[3, 5, 7, 9, 12, 15, 17].includes(f) ? ' marked' : ''}">${f}</div>`;
  for (let s = 1; s <= 6; s++) {
    html += `<div class="fb-string">${stringName(state.tuning, s)}</div>`;
    for (let f = 1; f <= MAP_FRETS; f++) {
      const sel = s === state.string && f === state.fret;
      html += `<button type="button" class="fb-cell${sel ? ' is-selected' : ''}" data-sf="${s}-${f}"${id(`fb-${s}-${f}`)}
        title="String ${s} (${stringName(state.tuning, s)}), fret ${f}: ${nn(openNote(state.tuning, s) + f)}">${nn(openNote(state.tuning, s) + f)}</button>`;
    }
  }
  return html;
}

function renderBoards() {
  $('fretboard').innerHTML = fretboardHTML(true);
  $('sheetBoard').innerHTML = fretboardHTML(false);
  renderAmounts();
}

function rebuild() {
  state.target = buildTarget(state.tuning, state.string, state.fret, state.amountId);
  if (audio.analyser) makeDetector();
  renderTunings(); renderBoards(); renderTarget();
  state.trace = []; state.attempt = null; drawTrace();
}

function setTuning(id) { state.tuning = TUNINGS.find((t) => t.id === id) || state.tuning; store.set('tuning', state.tuning.id); rebuild(); }
function setPosition(s, f) { state.string = s; state.fret = f; store.set('string', s); store.set('fret', f); rebuild(); }
function setAmount(id) { state.amountId = id; store.set('amount', id); rebuild(); }

function renderTarget() {
  const t = state.target;
  const nat = nn(t.naturalMidi), tgt = targetLabel(t, state.tuning);
  $('headline').innerHTML = `Bend the ${stringWord(state.tuning, t.string)} string at fret ${t.fret} up ${t.amount.phrase}.`;
  $('subline').innerHTML = `Pick ${acc(nat)}, then push the string until it sounds ${acc(tgt)} and the gauge settles in the green.`;
  $('stepBendVal').textContent = `${stringName(state.tuning, t.string)}${t.fret} · ${t.amount.label}`;
  $('playNatural').querySelector('span').innerHTML = `Natural ${acc(nat)}`;
  $('playTarget').querySelector('span').innerHTML = `Target ${acc(tgt)}`;
  $('gNat').innerHTML = `${acc(nat)} · fretted`;
  $('gTgt').innerHTML = `${acc(tgt)} · target`;
  $('tipTitle').textContent = `${t.amount.label === 'Full' ? 'Full' : t.amount.label + ' step'} bend tip`;
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
  $('gZone').setAttribute('d', gArc((size - ON_TARGET_CENTS) / size / GAUGE_SPAN, (size + ON_TARGET_CENTS) / size / GAUGE_SPAN));
}
function setGauge(c) {
  const gauge = document.querySelector('.gauge');
  if (c == null) { gauge.setAttribute('class', 'gauge is-idle'); $('gaugePct').textContent = '0%'; return; }
  const tc = state.target.cents, p = c / tc, f = clamp(p / GAUGE_SPAN, 0, 1);
  const on = Math.abs(c - tc) <= ON_TARGET_CENTS, over = !on && p > 1;
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
  const cell = $(`fb-${state.string}-${state.fret}`);
  if (midi == null) {
    $('noteBig').innerHTML = '<span class="idle">—</span>'; $('noteBig').classList.remove('is-on');
    cell?.classList.remove('is-hit');
    if (state.listening) { setStatus('live', 'Listening'); $('where').textContent = `Pick fret ${state.fret} on the ${stringWord(state.tuning, state.string)} string.`; }
    return;
  }
  const near = Math.round(midi), dev = Math.round((midi - near) * 100);
  $('noteBig').innerHTML = `${acc(nn(near))}<sub>${Math.floor(near / 12) - 1}</sub>`;
  const onTarget = Math.abs((midi - state.target.targetMidi) * 100) <= ON_TARGET_CENTS;
  $('noteBig').classList.toggle('is-on', onTarget);
  cell?.classList.toggle('is-hit', onTarget);
  setStatus(onTarget ? 'on' : 'live', onTarget ? 'On target' : `${dev > 0 ? '+' : ''}${dev}¢`);
  const tc = state.target.cents;
  if (c != null && c > -60 && c < tc + 150) {
    $('where').innerHTML = c < 15 ? `<strong>Fretted note</strong>, now push the string`
      : `<strong>Bent ${Math.round(c)}¢</strong> of ${tc}¢`;
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
    if (dist <= ON_TARGET_CENTS) { a.onTarget += dt; a.run += dt; a.bestRun = Math.max(a.bestRun, a.run); } else a.run = 0;
  } else if (a) {
    a.last = now;
    if (now - a.lastVoiced > 300) { finishAttempt(a); state.attempt = null; }
  }
}

function finishAttempt(a) {
  const dur = (a.lastVoiced - a.start) / 1000;
  if (dur < 0.25) return;
  const t = state.target, size = t.cents;
  const tgt = acc(targetLabel(t, state.tuning));
  const moved = a.extreme * size, past = (a.extreme - 1) * size;
  const reached = Math.round(clamp(a.extreme, 0, 9.99) * size);

  let cls, title, msg;
  if (a.bestRun >= HOLD_GOAL) {
    cls = 'good'; title = `Nailed it. You held ${tgt} for ${a.bestRun.toFixed(1)}s.`;
    msg = 'Now add a little vibrato at the top, then try a bend and release back down to the fretted note.';
  } else if (moved < 15) {
    cls = 'miss'; title = "The note didn't move";
    msg = `You played a clean ${acc(nn(t.naturalMidi))}. Now push the string sideways across the fret, with two fingers behind the bending finger, while it's still ringing.`;
  } else if (past > 25) {
    cls = 'close'; title = `Too far, ${Math.round(past)}¢ past ${tgt}`;
    msg = 'You have the strength. Ease off a little and stop as the gauge turns green. Fret the target note first to lock its sound in your ear.';
  } else if (a.closest <= ON_TARGET_CENTS) {
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
  if (typeof gtag === 'function') gtag('event', 'bend_attempt', { instrument: 'guitar', result: cls, bend: `${t.string}-${t.fret}-${t.amount.id}` });
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
  const top = tc + 120, bot = -120;
  const y = (c) => ((top - c) / (top - bot)) * H;
  g.clearRect(0, 0, W, H);
  g.fillStyle = colors.good; g.globalAlpha = 0.16;
  g.fillRect(0, y(tc + ON_TARGET_CENTS), W, y(tc - ON_TARGET_CENTS) - y(tc + ON_TARGET_CENTS));
  g.globalAlpha = 1;
  g.font = '600 13px "League Spartan", -apple-system, sans-serif';
  g.textBaseline = 'middle'; g.lineWidth = 1;
  const lines = [];
  for (let s = Math.ceil(bot / 100); s <= Math.floor(top / 100); s++) lines.push(s * 100);
  if (!lines.includes(tc)) lines.push(tc);
  for (const cents of lines) {
    const yy = y(cents), isNat = cents === 0, isTgt = cents === tc;
    g.strokeStyle = isTgt ? colors.good : colors.ink3;
    g.globalAlpha = isNat || isTgt ? 0.6 : 0.2;
    g.setLineDash(isNat || isTgt ? [] : [3, 5]);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); g.setLineDash([]);
    g.globalAlpha = isNat || isTgt ? 1 : 0.7;
    g.fillStyle = isTgt ? colors.good : colors.ink3;
    g.textAlign = 'right';
    g.fillText(isTgt ? targetLabel(t, state.tuning) : nn(t.naturalMidi + cents / 100), W - 10, yy - 9);
    if (isNat || isTgt) { g.textAlign = 'left'; g.fillText(isNat ? 'FRETTED' : 'TARGET', 10, yy - 9); }
  }
  g.globalAlpha = 1;
  const pts = state.trace;
  g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.c == null || b.c == null) continue;
    const xa = W - ((now - a.t) / TRACE_MS) * W, xb = W - ((now - b.t) / TRACE_MS) * W;
    const dist = Math.abs(b.c - tc);
    g.strokeStyle = dist <= ON_TARGET_CENTS ? colors.good : (b.c > tc ? colors.bad : colors.accent);
    g.beginPath(); g.moveTo(xa, clamp(y(a.c), -10, H + 10)); g.lineTo(xb, clamp(y(b.c), -10, H + 10)); g.stroke();
  }
  const last = pts[pts.length - 1];
  if (last && last.c != null && now - last.t < 120) {
    g.fillStyle = colors.ink;
    g.beginPath(); g.arc(W - 4, clamp(y(last.c), 4, H - 4), 5, 0, Math.PI * 2); g.fill();
  }
}

/* ───────── microphone ───────── */
function ensureCtx() {
  if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}
// Listen only around the chosen string and bend. Guitar notes have strong overtones,
// and a narrow window stops the detector from jumping an octave.
function makeDetector() {
  const t = state.target;
  audio.detect = createDetector({
    sampleRate: audio.ctx.sampleRate,
    minFreq: midiToFreq(t.naturalMidi - 2),
    maxFreq: midiToFreq(t.targetMidi + 2),
  });
}
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 6000);
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
    audio.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    audio.source = ctx.createMediaStreamSource(audio.stream);
    audio.analyser = ctx.createAnalyser();
    audio.analyser.fftSize = 4096;
    audio.buf = new Float32Array(audio.analyser.fftSize);
    audio.source.connect(audio.analyser);
    makeDetector();
    state.listening = true;
    setListeningUI(true);
    updateLive(null);
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
  setMood(c != null && Math.abs(c - t.cents) <= ON_TARGET_CENTS ? 'on' : '');
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
  const tu = e.target.closest('[data-tuning]');
  if (tu) { setTuning(tu.dataset.tuning); return toggleSheet('stepKey', false); }
  const am = e.target.closest('[data-amount]');
  if (am) return setAmount(am.dataset.amount);
  const sf = e.target.closest('[data-sf]');
  if (sf) {
    const [s, f] = sf.dataset.sf.split('-').map(Number);
    setPosition(s, f);
    if (sf.closest('#bendSheet')) toggleSheet('stepBend', false);
    return;
  }
  if (e.target.closest('[data-close]')) return toggleSheet(null);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSheet(null); });
$('stepKey').addEventListener('click', () => toggleSheet('stepKey'));
$('stepBend').addEventListener('click', () => toggleSheet('stepBend'));
$('stepPlay').addEventListener('click', () => {
  toggleSheet(null);
  if (!state.listening) document.querySelector('.instrument').scrollIntoView({ behavior: 'smooth', block: 'center' });
  state.listening ? stopMic() : startMic();
});
$('micBtn').addEventListener('click', () => (state.listening ? stopMic() : startMic()));
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
readColors();
sizeCanvas();
