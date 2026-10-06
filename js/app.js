import {
  KEYS, BLOW, DRAW, buildTargets, buildNoteMap, describeTarget, noteName,
  midiToFreq, freqToMidi, keyFeel, holeTip,
} from './harmonica.js';
import { createDetector, createSmoother } from './pitch.js';

/* ───────── helpers ───────── */
const $ = (id) => document.getElementById(id);
// Only settings are saved (key, bend, advanced). Practice results live in memory and vanish on reload.
const store = {
  get(k, d) { try { const v = localStorage.getItem('hs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hs.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ON_TARGET_CENTS = 20;   // within ±20¢ counts as hitting the bend
const HOLD_GOAL = 0.35;       // seconds on target to count as "nailed"
const TRACE_MS = 6000;
const GAUGE_SPAN = 1.3;       // the gauge runs from the natural note to 130% of the bend

/** Wrap ♭/♯ so the display font doesn't fall back to an odd glyph. */
const acc = (s) => s.replace(/([♭♯])/g, '<span class="acc">$1</span>');
const plain = (midi) => noteName(midi, state.key.root, false);

/* ───────── state ───────── */
const state = {
  key: KEYS.find((k) => k.id === store.get('key', 'C')) || KEYS[5],
  advanced: store.get('adv', false),
  targetId: store.get('target', '4d1'),
  targets: [],
  target: null,
  noteMap: new Map(),
  listening: false,
  trace: [],
  attempt: null,
  results: [],   // this page visit only
  mood: '',
};

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

function renderKeys() {
  const std = KEYS.filter((k) => !k.variant), vars = KEYS.filter((k) => k.variant);
  const btn = (k) => `<button type="button" class="key" data-key="${k.id}" aria-pressed="${k.id === state.key.id}"
      title="${k.label} harmonica · hole 1 = ${noteName(k.root, k.root)}">${k.label}</button>`;
  $('keys').innerHTML = std.map(btn).join('');
  $('variantKeys').innerHTML = vars.map(btn).join('');
  if (state.key.variant) { $('variantKeys').hidden = false; $('moreKeys').setAttribute('aria-expanded', 'true'); }
  const f = keyFeel(state.key.root);
  $('feel').innerHTML = `<strong>${state.key.label} harmonica · ${f.label}.</strong> ${f.tip}`;
  $('stepKeyVal').textContent = state.key.label;
}

function setKey(id) {
  state.key = KEYS.find((k) => k.id === id) || state.key;
  store.set('key', state.key.id);
  rebuild();
}

const depthLabel = (t) => (t.steps < 0 ? `↓${['', '½', '1', '1½'][-t.steps]}` : '↑');
const shortName = (t) => `${t.hole} ${t.kind === 'draw-bend' || t.kind === 'overdraw' ? 'draw' : 'blow'} ${depthLabel(t)}`;

/* ───────── targets + hole map ───────── */
function rebuild() {
  const root = state.key.root;
  state.targets = buildTargets(root);
  state.noteMap = buildNoteMap(root, state.advanced);
  let t = state.targets.find((x) => x.id === state.targetId);
  if (!t || (t.advanced && !state.advanced)) t = state.targets.find((x) => x.id === '4d1');
  state.target = t;
  state.targetId = t.id;
  if (audio.analyser) makeDetector();
  renderKeys(); renderHoles(); renderTarget();
  state.trace = []; drawTrace();
}

/** The hole map. `live` adds the ids the mic loop uses to light up the note being played. */
function holeMapHTML(live) {
  const root = state.key.root;
  const visible = state.targets.filter((t) => !t.advanced || state.advanced);
  const id = (v) => (live ? ` id="${v}"` : '');
  const chip = (t) => `<button type="button" class="bend${t.advanced ? ' adv' : ''}${t.id === state.targetId ? ' is-selected' : ''}"
      ${id(`c-${t.id}`)} data-target="${t.id}" title="${describeTarget(t, root).title}">${plain(t.targetMidi)}</button>`;
  let html = '';
  for (let h = 1; h <= 10; h++) {
    // Above the blow note: overblow furthest out, then blow bends deepest → shallowest
    const ups = visible.filter((t) => t.hole === h && (t.kind === 'overblow' || t.kind === 'blow-bend'))
      .sort((a, b) => (a.kind === 'overblow' ? -1 : b.kind === 'overblow' ? 1 : a.steps - b.steps));
    // Below the draw note: draw bends shallow → deep, then overdraw
    const downs = visible.filter((t) => t.hole === h && (t.kind === 'draw-bend' || t.kind === 'overdraw'))
      .sort((a, b) => (a.kind === 'overdraw' ? 1 : b.kind === 'overdraw' ? -1 : b.steps - a.steps));
    html += `<div class="hole${h === state.target.hole ? ' is-target' : ''}" data-hole="${h}">
      <div class="bends up">${ups.map(chip).join('')}</div>
      <div class="reed"${id(`n-${h}-blow`)} title="Hole ${h} blow">${plain(root + BLOW[h - 1])}</div>
      <div class="num"${id(`h-${h}`)}>${h}</div>
      <div class="reed"${id(`n-${h}-draw`)} title="Hole ${h} draw">${plain(root + DRAW[h - 1])}</div>
      <div class="bends">${downs.map(chip).join('')}</div>
    </div>`;
  }
  return html;
}

function renderHoles() {
  $('holes').innerHTML = holeMapHTML(true);
  $('sheetHoles').innerHTML = holeMapHTML(false);
  $('advToggle').textContent = `${state.advanced ? 'Hide' : 'Show'} overblows & overdraws (advanced)`;
}

function selectTarget(id) {
  const t = state.targets.find((x) => x.id === id);
  if (!t) return;
  state.target = t; state.targetId = id; store.set('target', id);
  state.attempt = null; state.trace = [];
  document.querySelectorAll('.bend').forEach((c) => c.classList.toggle('is-selected', c.dataset.target === id));
  document.querySelectorAll('.hole').forEach((el) => el.classList.toggle('is-target', el.dataset.hole === String(t.hole)));
  renderTarget(); drawTrace();
}

function renderTarget() {
  const t = state.target;
  const nat = plain(t.naturalMidi), tgt = plain(t.targetMidi);
  const reed = t.kind === 'draw-bend' || t.kind === 'overdraw' ? 'draw' : 'blow';
  const amt = ['', 'a half step', 'a whole step', 'a step and a half'][-t.steps];
  if (t.steps < 0) {
    $('headline').innerHTML = `Bend the ${t.hole} ${reed} down ${amt}.`;
    $('subline').innerHTML = `Play ${acc(nat)}, then pull it down toward ${acc(tgt)} until the gauge settles in the green.`;
  } else {
    $('headline').innerHTML = `${t.kind === 'overblow' ? 'Overblow' : 'Overdraw'} hole ${t.hole}.`;
    $('subline').innerHTML = `From ${acc(nat)}, let the note pop up to ${acc(tgt)}. This one is advanced, so be patient.`;
  }
  $('stepBendVal').textContent = shortName(t);
  $('playNatural').querySelector('span').innerHTML = `Natural ${acc(nat)}`;
  $('playTarget').querySelector('span').innerHTML = `Target ${acc(tgt)}`;
  $('gNat').innerHTML = `${acc(nat)} · natural`;
  $('gTgt').innerHTML = `${acc(tgt)} · target`;
  $('holeTipTitle').textContent = `Hole ${t.hole} tip`;
  $('holeTip').textContent = holeTip(t);
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
  const size = Math.abs(state.target.steps) * 100;
  $('gTrack').setAttribute('d', gArc(0, 1));
  $('gZone').setAttribute('d', gArc((size - ON_TARGET_CENTS) / size / GAUGE_SPAN, (size + ON_TARGET_CENTS) / size / GAUGE_SPAN));
}

function setGauge(c) {
  const gauge = document.querySelector('.gauge');
  if (c == null) {
    gauge.setAttribute('class', 'gauge is-idle');
    $('gaugePct').textContent = '0%';
    return;
  }
  const tc = state.target.steps * 100;
  const p = c / tc;
  const f = clamp(p / GAUGE_SPAN, 0, 1);
  const dist = Math.abs(c - tc);
  const on = dist <= ON_TARGET_CENTS, over = !on && p > 1;
  gauge.setAttribute('class', `gauge${on ? ' is-on' : over ? ' is-over' : ''}`);
  $('gFill').setAttribute('d', gArc(0, Math.max(f, 0.001)));
  const [kx, ky] = gPoint(f);
  $('gKnob').setAttribute('cx', kx.toFixed(2)); $('gKnob').setAttribute('cy', ky.toFixed(2));
  $('gaugePct').textContent = `${Math.round(clamp(p, 0, 9.99) * 100)}%`;
}

/* ───────── live readout ───────── */
let lastHits = [];
function clearHits() { lastHits.forEach((el) => el.classList.remove('is-hit')); lastHits = []; }

function setStatus(kind, text) {
  const el = $('micStatus');
  el.className = `status${kind ? ' is-' + kind : ''}`;
  el.lastElementChild.textContent = text;
}

function updateLive(midi) {
  const root = state.key.root;
  clearHits();
  if (midi == null) {
    $('noteBig').innerHTML = '<span class="idle">—</span>'; $('noteBig').classList.remove('is-on');
    if (state.listening) { setStatus('live', 'Listening'); $('where').textContent = 'Play a note.'; }
    return;
  }
  const near = Math.round(midi);
  const dev = Math.round((midi - near) * 100);
  $('noteBig').innerHTML = `${acc(plain(near))}<sub>${Math.floor(near / 12) - 1}</sub>`;
  const onTarget = Math.abs((midi - state.target.targetMidi) * 100) <= ON_TARGET_CENTS;
  $('noteBig').classList.toggle('is-on', onTarget);
  if (onTarget) setStatus('on', 'On target');
  else setStatus('live', `${dev > 0 ? '+' : ''}${dev}¢`);

  const positions = Math.abs(dev) <= 35 ? state.noteMap.get(near) || [] : [];
  if (!positions.length) {
    $('where').textContent = Math.abs(dev) > 35 ? 'Between notes, keep going.' : `Not on a ${state.key.label} harmonica.`;
    return;
  }
  $('where').innerHTML = positions.map((p) => {
    if (p.kind === 'blow' || p.kind === 'draw') return `<strong>Hole ${p.hole} ${p.kind}</strong>`;
    return `<strong>${describeTarget(state.targets.find((x) => x.id === p.id), root).title}</strong>`;
  }).join(' or ');
  for (const p of positions) {
    [p.id ? $(`c-${p.id}`) : $(`n-${p.hole}-${p.kind}`), $(`h-${p.hole}`)].forEach((el) => {
      if (el) { el.classList.add('is-hit'); lastHits.push(el); }
    });
  }
}

function setMood(mood) {
  if (mood === state.mood) return;
  state.mood = mood;
  document.body.dataset.mood = mood;
}

/* ───────── attempt scoring ───────── */
function trackAttempt(c, now) {
  const t = state.target, tc = t.steps * 100;
  const lo = Math.min(0, tc) - 120, hi = Math.max(0, tc) + 120;
  const voiced = c != null && c >= lo && c <= hi;
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
    if (now - a.lastVoiced > 280) { finishAttempt(a); state.attempt = null; }
  }
}

function finishAttempt(a) {
  const dur = (a.lastVoiced - a.start) / 1000;
  if (dur < 0.25) return;
  const t = state.target, size = Math.abs(t.steps) * 100;
  const nat = acc(plain(t.naturalMidi)), tgt = acc(plain(t.targetMidi));
  const moved = a.extreme * size;               // cents moved toward the target
  const past = (a.extreme - 1) * size;          // cents beyond the target
  const deepName = acc(plain(Math.round(t.naturalMidi + a.extreme * t.steps)));
  const up = t.steps > 0;

  let cls, title, msg;
  if (a.bestRun >= HOLD_GOAL) {
    cls = 'good'; title = `Nailed it. You held ${tgt} for ${a.bestRun.toFixed(1)}s.`;
    msg = 'Now try sliding in and out of it slowly, then hit it cleanly without the slide.';
  } else if (moved < 15) {
    cls = 'miss'; title = up ? 'No pop yet' : "The note didn't move";
    msg = up ? 'Overblows need the airflow almost fully blocked by the tongue. Try hole 6 first, with softer breath.'
      : `You played a clean ${nat}, which is a good start. Keep your lips still and slide your tongue back, as if saying "ee" then "oo".`;
  } else if (past > 25) {
    cls = 'close'; title = `Too far, ${Math.round(past)}¢ past ${tgt}`;
    msg = 'You have the motion. Use less tongue movement and softer air, and stop as the note lands in the green.';
  } else if (a.closest <= ON_TARGET_CENTS) {
    cls = 'close'; title = 'You touched it. Now hold it.';
    msg = `You reached ${tgt} but slipped off. Keep the same mouth shape and steady, gentle air for a full second.`;
  } else {
    const pct = Math.round(clamp(a.extreme, 0, 1) * 100);
    cls = pct >= 50 ? 'close' : 'miss';
    title = `${pct}% of the way there`;
    msg = pct >= 50
      ? `You bent down to about ${deepName}. A little more: drop your jaw and pull your tongue further back, without drawing harder.`
      : 'The note started to move. Bends come from mouth shape, not force. Try a deeper "oo" with a relaxed throat.';
  }

  const r = $('result');
  r.className = `card result ${cls}`;
  r.innerHTML = `<span class="lbl">Last result</span><h3 class="display">${title}</h3><p class="muted">${msg}</p>
    <div class="stats">
      <span class="chip">${up ? 'Highest' : 'Deepest'}: ${deepName}</span>
      <span class="chip">Closest: ${a.closest === Infinity ? '—' : `${Math.round(a.closest)}¢ off`}</span>
      <span class="chip">Held: ${dur.toFixed(1)}s</span>
    </div>`;
  state.results.push(cls);
  renderSession();
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
  const t = state.target, tc = t.steps * 100;
  const top = Math.max(0, tc) + 150, bot = Math.min(0, tc) - 150;
  const y = (c) => ((top - c) / (top - bot)) * H;
  g.clearRect(0, 0, W, H);

  // target band
  g.fillStyle = colors.good;
  g.globalAlpha = 0.16;
  g.fillRect(0, y(tc + ON_TARGET_CENTS), W, y(tc - ON_TARGET_CENTS) - y(tc + ON_TARGET_CENTS));
  g.globalAlpha = 1;

  // semitone grid with note labels
  g.font = '600 13px "League Spartan", -apple-system, sans-serif';
  g.textBaseline = 'middle';
  g.lineWidth = 1;
  for (let s = Math.ceil(bot / 100); s <= Math.floor(top / 100); s++) {
    const yy = y(s * 100);
    const isNat = s === 0, isTgt = s * 100 === tc;
    g.strokeStyle = isTgt ? colors.good : colors.ink3;
    g.globalAlpha = isNat || isTgt ? 0.6 : 0.2;
    g.setLineDash(isNat || isTgt ? [] : [3, 5]);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = isNat || isTgt ? 1 : 0.7;
    g.fillStyle = isTgt ? colors.good : colors.ink3;
    g.textAlign = 'right';
    g.fillText(noteName(t.naturalMidi + s, state.key.root, false), W - 10, yy - 9);
    if (isNat || isTgt) { g.textAlign = 'left'; g.fillText(isNat ? 'NATURAL' : 'TARGET', 10, yy - 9); }
  }
  g.globalAlpha = 1;

  // the player's pitch
  const pts = state.trace;
  g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.c == null || b.c == null) continue;
    const xa = W - ((now - a.t) / TRACE_MS) * W, xb = W - ((now - b.t) / TRACE_MS) * W;
    const dist = Math.abs(b.c - tc);
    g.strokeStyle = dist <= ON_TARGET_CENTS ? colors.good : (b.c / tc > 1 ? colors.bad : colors.accent);
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

function makeDetector() {
  const root = state.key.root;
  audio.detect = createDetector({
    sampleRate: audio.ctx.sampleRate,
    minFreq: midiToFreq(root - 2) * 0.9,
    maxFreq: midiToFreq(root + 38) * 1.1,
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
    audio.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
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
      : err?.name === 'NotFoundError' ? 'No microphone was found on this device.'
        : `Couldn't start the microphone (${err?.message || err}).`;
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
  clearHits(); drawTrace();
}

function loop() {
  audio.raf = requestAnimationFrame(loop);
  const now = performance.now();
  let midi = null;
  if (now > audio.muteUntil) {
    audio.analyser.getFloatTimeDomainData(audio.buf);
    const r = audio.detect(audio.buf, 0.008);
    const f = audio.smooth(r && r.clarity > 0.8 ? r.freq : null);
    if (f) midi = freqToMidi(f);
  } else audio.smooth(null);

  const t = state.target;
  const c = midi == null ? null : (midi - t.naturalMidi) * 100;
  state.trace.push({ t: now, c });
  while (state.trace.length && now - state.trace[0].t > TRACE_MS + 200) state.trace.shift();

  updateLive(midi);
  const tc = t.steps * 100;
  const inZone = c != null && c >= Math.min(0, tc) - 120 && c <= Math.max(0, tc) + 120;
  setGauge(inZone ? c : null);
  trackAttempt(c, now);
  setMood(c != null && Math.abs(c - tc) <= ON_TARGET_CENTS ? 'on' : '');
  drawTrace(now);
}

/* ───────── reference tones ───────── */
function voice(ctx, freq, start, dur) {
  const out = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = Math.min(freq * 4, 7000); lp.Q.value = 0.8;
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'square';
  o1.frequency.value = freq; o2.frequency.value = freq; o2.detune.value = 6;
  const mix2 = ctx.createGain(); mix2.gain.value = 0.35;
  o1.connect(lp); o2.connect(mix2).connect(lp); lp.connect(out).connect(ctx.destination);
  out.gain.setValueAtTime(0, start);
  out.gain.linearRampToValueAtTime(0.16, start + 0.05);
  out.gain.setValueAtTime(0.16, start + dur - 0.2);
  out.gain.linearRampToValueAtTime(0, start + dur);
  [o1, o2].forEach((o) => { o.start(start); o.stop(start + dur + 0.05); });
  return [o1, o2];
}

function playNote(midi, dur = 1.2) {
  const ctx = ensureCtx();
  voice(ctx, midiToFreq(midi), ctx.currentTime + 0.02, dur);
  audio.muteUntil = performance.now() + dur * 1000 + 200;
}

function playSlide() {
  const ctx = ensureCtx(), t = state.target;
  const f0 = midiToFreq(t.naturalMidi), f1 = midiToFreq(t.targetMidi);
  const s = ctx.currentTime + 0.02, dur = 2.2;
  const oscs = voice(ctx, f0, s, dur);
  if (t.steps < 0) {
    oscs.forEach((o) => { o.frequency.setValueAtTime(f0, s + 0.55); o.frequency.exponentialRampToValueAtTime(f1, s + 1.25); });
  } else {
    oscs.forEach((o) => o.frequency.setValueAtTime(f1, s + 0.7)); // overblows pop rather than slide
  }
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
  if (k) { setKey(k.dataset.key); return toggleSheet('stepKey', false); }
  const tg = e.target.closest('[data-target]');
  if (tg) { selectTarget(tg.dataset.target); if (tg.closest('#bendSheet')) toggleSheet('stepBend', false); return; }
  if (e.target.closest('[data-close]')) return toggleSheet(null);
  if (e.target.closest('#advToggle')) {
    state.advanced = !state.advanced; store.set('adv', state.advanced);
    return rebuild();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSheet(null); });
$('stepKey').addEventListener('click', () => toggleSheet('stepKey'));
$('stepBend').addEventListener('click', () => toggleSheet('stepBend'));
$('stepPlay').addEventListener('click', () => {
  toggleSheet(null);
  if (!state.listening) document.querySelector('.instrument').scrollIntoView({ behavior: 'smooth', block: 'center' });
  state.listening ? stopMic() : startMic();
});
$('moreKeys').addEventListener('click', () => {
  const el = $('variantKeys'); el.hidden = !el.hidden;
  $('moreKeys').setAttribute('aria-expanded', String(!el.hidden));
});
$('micBtn').addEventListener('click', () => (state.listening ? stopMic() : startMic()));
$('playNatural').addEventListener('click', () => playNote(state.target.naturalMidi));
$('playTarget').addEventListener('click', () => playNote(state.target.targetMidi));
$('playSlide').addEventListener('click', playSlide);
$('recBtn').addEventListener('click', toggleRecord);
$('playTake').addEventListener('click', () => playTake());
$('compareTake').addEventListener('click', () => { playNote(state.target.targetMidi, 1.2); playTake(1500); });
$('resetSession').addEventListener('click', () => { state.results = []; renderSession(); });
window.addEventListener('themechange', readColors);

new ResizeObserver(sizeCanvas).observe(canvas);
rebuild();
renderSession();
readColors();
sizeCanvas();
