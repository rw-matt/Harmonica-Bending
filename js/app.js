import {
  KEYS, BLOW, DRAW, buildTargets, buildNoteMap, describeTarget, noteName,
  midiToFreq, freqToMidi, keyFeel, holeTip,
} from './harmonica.js';
import { createDetector, createSmoother } from './pitch.js';

/* ───────── helpers ───────── */
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('hs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hs.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ON_TARGET_CENTS = 20;   // within ±20¢ counts as hitting the bend
const HOLD_GOAL = 0.35;       // seconds on target to count as "nailed"
const TRACE_MS = 6000;

/* ───────── state ───────── */
const state = {
  key: KEYS.find((k) => k.id === store.get('key', 'C')) || KEYS[5],
  view: store.get('view', 'exploded'),
  advanced: store.get('adv', false),
  targetId: store.get('target', '4d1'),
  targets: [],
  target: null,
  noteMap: new Map(),
  listening: false,
  trace: [],
  attempt: null,
  results: [],
  mood: '',
};

const audio = {
  ctx: null, stream: null, source: null, analyser: null, buf: null,
  detect: null, smooth: createSmoother(5), raf: 0, muteUntil: 0,
  recorder: null, chunks: [], takeUrl: null, recTimer: 0,
};

/* ───────── key picker ───────── */
function renderKeys() {
  const std = KEYS.filter((k) => !k.variant), vars = KEYS.filter((k) => k.variant);
  const btn = (k) => `<button type="button" class="key" data-key="${k.id}" aria-pressed="${k.id === state.key.id}"
      title="${k.label} harmonica · hole 1 = ${noteName(k.root, k.root)}">${k.label}</button>`;
  $('keys').innerHTML = std.map(btn).join('');
  $('variantKeys').innerHTML = vars.map(btn).join('');
  if (state.key.variant) { $('variantKeys').hidden = false; $('moreKeys').setAttribute('aria-expanded', 'true'); }
}

function renderFeel() {
  const f = keyFeel(state.key.root);
  const r = state.key.root;
  $('feel').innerHTML = `<span class="chip">${f.label}</span>
    <span>Hole 1 blow is <strong>${noteName(r, r)}</strong> · range ${noteName(r, r)}–${noteName(r + 36, r)}</span>`;
  $('feelTitle').textContent = `${state.key.label} harmonica`;
  $('feelTip').textContent = f.tip;
}

function setKey(id) {
  state.key = KEYS.find((k) => k.id === id) || state.key;
  store.set('key', state.key.id);
  rebuild();
}

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
  renderKeys(); renderFeel(); renderHoles(); renderBendGroups(); renderTarget();
  state.trace = []; drawTrace();
}

function renderHoles() {
  const root = state.key.root;
  const visible = state.targets.filter((t) => !t.advanced || state.advanced);
  const chip = (t) => {
    const d = describeTarget(t, root);
    return `<button type="button" class="bend-chip${t.advanced ? ' adv' : ''}${t.id === state.targetId ? ' is-selected' : ''}"
      id="c-${t.id}" data-target="${t.id}" title="${d.title} → ${d.tgt}">${noteName(t.targetMidi, root, false)}</button>`;
  };
  let html = '';
  // Top row: overblows (furthest out) then blow bends deepest → shallowest
  html += '<div class="row-label row-bends"></div>';
  for (let h = 1; h <= 10; h++) {
    const ups = visible.filter((t) => t.hole === h && (t.kind === 'overblow' || t.kind === 'blow-bend'))
      .sort((a, b) => (a.kind === 'overblow' ? -1 : b.kind === 'overblow' ? 1 : a.steps - b.steps));
    html += `<div class="cell-bends up">${ups.map(chip).join('')}</div>`;
  }
  html += '<div class="row-label">Blow</div>';
  for (let h = 1; h <= 10; h++) html += `<div class="cell-note" id="n-${h}-blow">${noteName(root + BLOW[h - 1], root, false)}</div>`;
  html += '<div class="row-label">Hole</div>';
  for (let h = 1; h <= 10; h++) html += `<div class="cell-hole" id="h-${h}">${h}</div>`;
  html += '<div class="row-label">Draw</div>';
  for (let h = 1; h <= 10; h++) html += `<div class="cell-note" id="n-${h}-draw">${noteName(root + DRAW[h - 1], root, false)}</div>`;
  // Bottom row: draw bends shallow → deep, then overdraws
  html += '<div class="row-label row-bends"></div>';
  for (let h = 1; h <= 10; h++) {
    const downs = visible.filter((t) => t.hole === h && (t.kind === 'draw-bend' || t.kind === 'overdraw'))
      .sort((a, b) => (a.kind === 'overdraw' ? 1 : b.kind === 'overdraw' ? -1 : b.steps - a.steps));
    html += `<div class="cell-bends">${downs.map(chip).join('')}</div>`;
  }
  const el = $('holes');
  el.innerHTML = html;
  el.classList.toggle('simple', state.view === 'simple');
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $('legendAdv').hidden = !state.advanced;
}

function renderBendGroups() {
  const root = state.key.root;
  const groups = [
    ['Draw bends', state.targets.filter((t) => t.kind === 'draw-bend')],
    ['Blow bends', state.targets.filter((t) => t.kind === 'blow-bend')],
  ];
  if (state.advanced) groups.push(['Overblows & overdraws', state.targets.filter((t) => t.advanced)]);
  const depth = (t) => (t.steps < 0 ? ['', '−½', '−1', '−1½'][-t.steps] : 'pop');
  $('bendGroups').innerHTML = groups.map(([name, list]) => `
    <div class="bend-group" role="group" aria-label="${name}">
      <span class="label">${name}</span>
      ${list.map((t) => `<button type="button" class="pick" data-target="${t.id}" aria-pressed="${t.id === state.targetId}"
          title="${describeTarget(t, root).title}">${t.hole} → ${noteName(t.targetMidi, root)}<small>${depth(t)}</small></button>`).join('')}
    </div>`).join('') + `
    <div><button type="button" class="linkish" id="advToggle">${state.advanced ? 'Hide' : 'Show'} overblows &amp; overdraws (advanced)</button></div>`;
}

function selectTarget(id) {
  const t = state.targets.find((x) => x.id === id);
  if (!t) return;
  state.target = t; state.targetId = id; store.set('target', id);
  state.attempt = null; state.trace = [];
  document.querySelectorAll('.bend-chip').forEach((c) => c.classList.toggle('is-selected', c.dataset.target === id));
  document.querySelectorAll('.pick').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.target === id)));
  renderTarget(); drawTrace();
}

function renderTarget() {
  const t = state.target, root = state.key.root;
  const d = describeTarget(t, root);
  $('targetTitle').textContent = d.title;
  const verb = t.steps < 0 ? `Start on ${d.nat} and bend down to ${d.tgt}.` : `From ${d.nat}, pop up to ${d.tgt}.`;
  $('targetSub').textContent = verb;
  $('targetNote').textContent = d.tgt;
  $('playNatural').querySelector('span').textContent = `Natural ${d.nat}`;
  $('playTarget').querySelector('span').textContent = `Target ${d.tgt}`;
  $('mNat').textContent = d.nat; $('mTgt').textContent = d.tgt;
  // target zone on the meter (meter spans 0 → 130% of the bend)
  const span = Math.abs(t.steps) * 100 * 1.3;
  const lo = (Math.abs(t.steps) * 100 - ON_TARGET_CENTS) / span, hi = (Math.abs(t.steps) * 100 + ON_TARGET_CENTS) / span;
  Object.assign($('meterZone').style, { left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` });
  $('holeTipTitle').textContent = `Hole ${t.hole} tip`;
  $('holeTip').textContent = holeTip(t);
  setMeter(null);
}

/* ───────── live readout ───────── */
let lastHits = [];
function clearHits() { lastHits.forEach((el) => el.classList.remove('is-hit')); lastHits = []; }

function updateLive(midi) {
  const root = state.key.root;
  clearHits();
  if (midi == null) {
    $('noteBig').innerHTML = '—'; $('noteBig').classList.remove('is-on');
    $('needle').style.left = '50%'; $('needle').style.background = '';
    $('centsRead').textContent = '0¢';
    if (state.listening) $('where').textContent = 'Listening… play a note.';
    return;
  }
  const near = Math.round(midi);
  const dev = Math.round((midi - near) * 100);
  const name = noteName(near, root, false), oct = Math.floor(near / 12) - 1;
  $('noteBig').innerHTML = `${name}<sub>${oct}</sub>`;
  const onTarget = Math.abs((midi - state.target.targetMidi) * 100) <= ON_TARGET_CENTS;
  $('noteBig').classList.toggle('is-on', onTarget);
  $('needle').style.left = `${50 + clamp(dev, -50, 50)}%`;
  $('needle').style.background = Math.abs(dev) <= 10 ? 'var(--good)' : Math.abs(dev) <= 25 ? 'var(--amber)' : 'var(--bad)';
  $('centsRead').textContent = `${dev > 0 ? '+' : ''}${dev}¢`;

  const positions = Math.abs(dev) <= 35 ? state.noteMap.get(near) || [] : [];
  if (!positions.length) {
    $('where').textContent = Math.abs(dev) > 35 ? 'Between notes — keep going.' : `Not on this ${state.key.label} harp.`;
    return;
  }
  const words = positions.map((p) => {
    if (p.kind === 'blow' || p.kind === 'draw') return `<strong>Hole ${p.hole} ${p.kind}</strong>`;
    const t = state.targets.find((x) => x.id === p.id);
    return `<strong>${describeTarget(t, root).title}</strong>`;
  });
  $('where').innerHTML = words.join(' or ');
  for (const p of positions) {
    const els = p.id ? [$(`c-${p.id}`)] : [$(`n-${p.hole}-${p.kind}`)];
    els.push($(`h-${p.hole}`));
    els.forEach((el) => { if (el) { el.classList.add('is-hit'); lastHits.push(el); } });
  }
}

function setMeter(c) {
  const t = state.target, tc = t.steps * 100;
  const fill = $('meterFill');
  if (c == null) {
    fill.style.width = '0%'; fill.classList.remove('is-on', 'is-over');
    $('meterNow').textContent = 'Now: —'; $('meterPct').textContent = '0%';
    return;
  }
  const p = c / tc;
  fill.style.width = `${clamp(p / 1.3, 0, 1) * 100}%`;
  const dist = Math.abs(c - tc);
  fill.classList.toggle('is-on', dist <= ON_TARGET_CENTS);
  fill.classList.toggle('is-over', dist > ON_TARGET_CENTS && p > 1);
  const midi = t.naturalMidi + c / 100;
  $('meterNow').textContent = `Now: ${noteName(Math.round(midi), state.key.root)}`;
  $('meterPct').textContent = dist <= ON_TARGET_CENTS ? 'On target' : `${Math.round(clamp(p, 0, 9.99) * 100)}%`;
}

function setMood(mood) {
  if (mood === state.mood) return;
  state.mood = mood;
  const s = document.documentElement.style;
  const moods = {
    '': ['#ff9f2e', '#7b5cff', '#19c2c9', 0],
    voiced: ['#ffb13d', '#7b5cff', '#19c2c9', 0.45],
    bending: ['#ffb13d', '#3fa9ff', '#19c2c9', 0.75],
    on: ['#2fd38a', '#19c2c9', '#4ade9b', 1],
  };
  const [a, b, c, e] = moods[mood];
  s.setProperty('--mood-a', a); s.setProperty('--mood-b', b); s.setProperty('--mood-c', c); s.setProperty('--energy', e);
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
  const t = state.target, root = state.key.root, size = Math.abs(t.steps) * 100;
  const d = describeTarget(t, root);
  const moved = a.extreme * size;               // cents moved toward the target
  const past = (a.extreme - 1) * size;          // cents beyond the target
  const deepMidi = t.naturalMidi + (a.extreme * t.steps);
  const deepName = noteName(Math.round(deepMidi), root);
  const up = t.steps > 0;

  let cls, title, msg;
  if (a.bestRun >= HOLD_GOAL) {
    cls = 'good'; title = `Nailed it — ${d.tgt}`;
    msg = `You held the target for ${a.bestRun.toFixed(1)}s. Now try sliding in and out of it slowly, then hit it cleanly without the slide.`;
  } else if (moved < 15) {
    cls = 'miss'; title = up ? 'No pop yet' : "The note didn't move";
    msg = up ? 'Overblows need the airflow almost fully blocked by the tongue. Try hole 6 first and lower your breath force.'
      : `You played a clean ${d.nat}, which is a good start. Keep the lips still and slide your tongue back as if saying "ee" → "oo".`;
  } else if (past > 25) {
    cls = 'close'; title = `Too far — ${Math.round(past)}¢ past ${d.tgt}`;
    msg = 'You have the motion. Use less tongue movement and softer air; stop the slide as the note lands in the green band.';
  } else if (a.closest <= ON_TARGET_CENTS) {
    cls = 'close'; title = 'You touched it — now hold it';
    msg = `You reached ${d.tgt} but slipped off. Keep the same mouth shape and steady, gentle air for a full second.`;
  } else {
    const pct = Math.round(clamp(a.extreme, 0, 1) * 100);
    cls = pct >= 50 ? 'close' : 'miss';
    title = `${pct}% of the way there`;
    msg = pct >= 50
      ? `You bent down to about ${deepName}. A little more: drop the jaw and pull the tongue further back, without drawing harder.`
      : `The note started to move. Bends come from the mouth shape, not force — try a deeper "oo" with a relaxed throat.`;
  }

  state.results.push(cls);
  if (state.results.length > 12) state.results.shift();
  const r = $('result');
  r.className = `card result ${cls}`;
  r.innerHTML = `<h3>${title}</h3><p>${msg}</p>
    <div class="stats">
      <span class="chip">${up ? 'Highest' : 'Deepest'}: ${deepName}</span>
      <span class="chip">Closest: ${a.closest === Infinity ? '—' : `${Math.round(a.closest)}¢ off`}</span>
      <span class="chip">On target: ${a.onTarget.toFixed(1)}s</span>
      <span class="chip">Note held: ${dur.toFixed(1)}s</span>
    </div>`;
  const good = state.results.filter((x) => x === 'good').length;
  $('history').innerHTML = `<span>Last ${state.results.length}:</span>` +
    state.results.map((x) => `<span class="pip ${x}"></span>`).join('') +
    `<span style="margin-left:auto">${good} nailed</span>`;
}

/* ───────── pitch trace ───────── */
const canvas = $('trace');
const g = canvas.getContext('2d');
function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrace();
}

function drawTrace(now = performance.now()) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W) return;
  const t = state.target, tc = t.steps * 100, root = state.key.root;
  const top = Math.max(0, tc) + 150, bot = Math.min(0, tc) - 150;
  const y = (c) => ((top - c) / (top - bot)) * H;
  g.clearRect(0, 0, W, H);

  // target band
  g.fillStyle = 'rgba(74, 222, 155, 0.16)';
  g.fillRect(0, y(tc + ON_TARGET_CENTS), W, y(tc - ON_TARGET_CENTS) - y(tc + ON_TARGET_CENTS));
  g.strokeStyle = 'rgba(74, 222, 155, 0.55)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, y(tc)); g.lineTo(W, y(tc)); g.stroke();

  // semitone grid with note labels
  g.font = '600 11px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
  g.textBaseline = 'middle';
  for (let s = Math.ceil(bot / 100); s <= Math.floor(top / 100); s++) {
    const yy = y(s * 100);
    const isNat = s === 0, isTgt = s * 100 === tc;
    g.strokeStyle = isNat ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.08)';
    g.setLineDash(isNat ? [] : [3, 5]);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke();
    g.setLineDash([]);
    g.fillStyle = isTgt ? '#4ade9b' : isNat ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)';
    g.textAlign = 'right';
    g.fillText(noteName(t.naturalMidi + s, root), W - 10, yy - 9);
    if (isNat || isTgt) { g.textAlign = 'left'; g.fillText(isNat ? 'NATURAL' : 'TARGET', 10, yy - 9); }
  }

  // the player's pitch
  const pts = state.trace;
  g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.c == null || b.c == null) continue;
    const xa = W - ((now - a.t) / TRACE_MS) * W, xb = W - ((now - b.t) / TRACE_MS) * W;
    const dist = Math.abs(b.c - tc);
    g.strokeStyle = dist <= ON_TARGET_CENTS ? '#4ade9b' : (b.c / tc > 1 ? '#ff6b7a' : '#ffc94a');
    g.shadowColor = g.strokeStyle; g.shadowBlur = 8;
    g.beginPath(); g.moveTo(xa, clamp(y(a.c), -10, H + 10)); g.lineTo(xb, clamp(y(b.c), -10, H + 10)); g.stroke();
  }
  g.shadowBlur = 0;
  const last = pts[pts.length - 1];
  if (last && last.c != null && now - last.t < 120) {
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(W - 2, clamp(y(last.c), 4, H - 4), 5, 0, Math.PI * 2); g.fill();
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

function setMicStatus(kind, text) {
  const el = $('micStatus');
  el.className = `mic-status${kind ? ' is-' + kind : ''}`;
  el.lastElementChild.textContent = text;
}

async function startMic() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setMicStatus('error', 'Mic unavailable');
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
    $('micBtn').classList.add('is-live');
    $('micBtn').querySelector('span').textContent = 'Stop listening';
    $('traceEmpty').hidden = true;
    $('recBtn').disabled = typeof MediaRecorder === 'undefined';
    setMicStatus('live', 'Listening');
    updateLive(null);
    loop();
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.'
      : err?.name === 'NotFoundError' ? 'No microphone was found on this device.'
        : `Couldn't start the microphone (${err?.message || err}).`;
    setMicStatus('error', 'Mic blocked');
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
  $('micBtn').classList.remove('is-live');
  $('micBtn').querySelector('span').textContent = 'Start listening';
  $('recBtn').disabled = true;
  $('traceEmpty').hidden = false;
  setMicStatus('', 'Mic off');
  $('where').textContent = 'Start listening, then play any note.';
  updateLive(null); setMeter(null); setMood('');
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
  setMeter(inZone ? c : null);
  trackAttempt(c, now);
  if (c == null) setMood('');
  else if (Math.abs(c - tc) <= ON_TARGET_CENTS) setMood('on');
  else if (inZone && c / tc > 0.15) setMood('bending');
  else setMood('voiced');
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

/* ───────── record & compare ───────── */
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
    $('recBtn').classList.remove('btn-ghost-amber');
    $('playTake').disabled = false; $('compareTake').disabled = false;
  };
  audio.recorder.start();
  $('recBtn').querySelector('span').textContent = 'Stop (max 8s)';
  $('recBtn').classList.add('btn-ghost-amber');
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
  if (k) return setKey(k.dataset.key);
  const tg = e.target.closest('[data-target]');
  if (tg) return selectTarget(tg.dataset.target);
  const v = e.target.closest('[data-view]');
  if (v) { state.view = v.dataset.view; store.set('view', state.view); return renderHoles(); }
  if (e.target.closest('#advToggle')) {
    state.advanced = !state.advanced; store.set('adv', state.advanced);
    return rebuild();
  }
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

new ResizeObserver(sizeCanvas).observe(canvas);
rebuild();
sizeCanvas();
