// Harmonica model for a standard 10-hole Richter-tuned diatonic.
// Every key uses the same layout; only the starting pitch (hole 1 blow) changes.

// Semitone offsets from hole 1 blow, holes 1–10.
export const BLOW = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36];
export const DRAW = [2, 7, 11, 14, 17, 21, 23, 26, 29, 33];

// Hole 1 blow as a MIDI note number. Standard harps: G–B sit in octave 3,
// C–F# in octave 4. Low/high variants are an octave down/up.
export const KEYS = [
  { id: 'G',   label: 'G',   root: 55 },
  { id: 'Ab',  label: 'A♭',  root: 56 },
  { id: 'A',   label: 'A',   root: 57 },
  { id: 'Bb',  label: 'B♭',  root: 58 },
  { id: 'B',   label: 'B',   root: 59 },
  { id: 'C',   label: 'C',   root: 60 },
  { id: 'Db',  label: 'D♭',  root: 61 },
  { id: 'D',   label: 'D',   root: 62 },
  { id: 'Eb',  label: 'E♭',  root: 63 },
  { id: 'E',   label: 'E',   root: 64 },
  { id: 'F',   label: 'F',   root: 65 },
  { id: 'F#',  label: 'F♯',  root: 66 },
  { id: 'LD',  label: 'Low D',  root: 50, variant: true },
  { id: 'LE',  label: 'Low E',  root: 52, variant: true },
  { id: 'LF',  label: 'Low F',  root: 53, variant: true },
  { id: 'LG',  label: 'Low G',  root: 43, variant: true },
  { id: 'HG',  label: 'High G', root: 67, variant: true },
];

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLATS  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
// Sharp keys spell accidentals with sharps; the rest use flats (as most bend charts do).
const SHARP_KEYS = new Set([7, 2, 9, 4, 11, 6]); // G D A E B F#

export function noteName(midi, root, withOctave = true) {
  const pc = ((midi % 12) + 12) % 12;
  const names = SHARP_KEYS.has(((root % 12) + 12) % 12) ? SHARPS : FLATS;
  const oct = Math.floor(midi / 12) - 1;
  return withOctave ? `${names[pc]}${oct}` : names[pc];
}

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

/**
 * All playable targets for a key: draw bends, blow bends, overblows, overdraws.
 * Each item: { id, hole, kind, steps, naturalMidi, targetMidi, advanced }
 * kind: 'draw-bend' | 'blow-bend' | 'overblow' | 'overdraw'
 * steps: half steps from the natural note (negative = bend down).
 */
export function buildTargets(root) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const hole = i + 1;
    const b = BLOW[i], d = DRAW[i];
    if (d > b) {
      // Holes 1–6: the draw reed is higher, so the draw note bends down.
      const depth = d - b - 1;
      for (let s = 1; s <= depth; s++) {
        out.push({ id: `${hole}d${s}`, hole, kind: 'draw-bend', steps: -s,
          naturalMidi: root + d, targetMidi: root + d - s, advanced: false });
      }
      // Overblow: hole 1, 4, 5, 6 — a half step above the draw note.
      if ([1, 4, 5, 6].includes(hole)) {
        out.push({ id: `${hole}ob`, hole, kind: 'overblow', steps: d + 1 - b,
          naturalMidi: root + b, targetMidi: root + d + 1, advanced: true });
      }
    } else {
      // Holes 7–10: the blow reed is higher, so the blow note bends down.
      const depth = b - d - 1;
      for (let s = 1; s <= depth; s++) {
        out.push({ id: `${hole}b${s}`, hole, kind: 'blow-bend', steps: -s,
          naturalMidi: root + b, targetMidi: root + b - s, advanced: false });
      }
      // Overdraw: holes 7, 9, 10 — a half step above the blow note.
      if ([7, 9, 10].includes(hole)) {
        out.push({ id: `${hole}od`, hole, kind: 'overdraw', steps: b + 1 - d,
          naturalMidi: root + d, targetMidi: root + b + 1, advanced: true });
      }
    }
  }
  return out;
}

export function describeTarget(t, root) {
  const tgt = noteName(t.targetMidi, root);
  const nat = noteName(t.naturalMidi, root);
  switch (t.kind) {
    case 'draw-bend': {
      const amt = ['', 'half step', 'whole step', 'step and a half'][-t.steps];
      return { title: `Hole ${t.hole} draw · ${amt} bend`, short: `${t.hole} draw ↓ ${tgt}`, nat, tgt };
    }
    case 'blow-bend': {
      const amt = ['', 'half step', 'whole step'][-t.steps];
      return { title: `Hole ${t.hole} blow · ${amt} bend`, short: `${t.hole} blow ↓ ${tgt}`, nat, tgt };
    }
    case 'overblow':
      return { title: `Hole ${t.hole} overblow`, short: `${t.hole} overblow ↑ ${tgt}`, nat, tgt };
    case 'overdraw':
      return { title: `Hole ${t.hole} overdraw`, short: `${t.hole} overdraw ↑ ${tgt}`, nat, tgt };
  }
}

/** Map every reachable MIDI note to the hole positions that produce it. */
export function buildNoteMap(root, includeAdvanced) {
  const map = new Map();
  const add = (m, pos) => { if (!map.has(m)) map.set(m, []); map.get(m).push(pos); };
  for (let i = 0; i < 10; i++) {
    add(root + BLOW[i], { hole: i + 1, kind: 'blow' });
    add(root + DRAW[i], { hole: i + 1, kind: 'draw' });
  }
  for (const t of buildTargets(root)) {
    if (t.advanced && !includeAdvanced) continue;
    add(t.targetMidi, { hole: t.hole, kind: t.kind, id: t.id });
  }
  return map;
}

/** Feel of the key — lower harps have bigger, looser reeds; higher ones are tight. */
export function keyFeel(root) {
  if (root <= 55) return { label: 'Low & loose', tip: 'Big reeds respond slowly. Use gentle, relaxed air and let the bend drop — it is easy to overshoot.' };
  if (root <= 59) return { label: 'Low-mid', tip: 'Bends are deep and forgiving, but the 2 and 3 draw need patience and soft airflow.' };
  if (root <= 62) return { label: 'The sweet spot', tip: 'C and D are the classic keys to learn bending on — responsive without being stiff.' };
  return { label: 'High & tight', tip: 'Small reeds bend in a narrow window. Keep the tongue higher and forward, and make small, precise moves.' };
}

/** Coaching tip per hole/kind, written for this app. */
export function holeTip(t) {
  if (t.kind === 'overblow' || t.kind === 'overdraw') {
    return 'Advanced: block the airflow so the opposite reed pops into a note above. Start with hole 6 on a C or D harp, and expect weeks, not minutes.';
  }
  const tips = {
    1: 'Lowest bend on the harp. Think of a deep "ooh" with the tongue far back — the jaw drops more here than anywhere else.',
    2: 'Two bends live here. Arch the very back of the tongue; if the plain 2 draw already sounds airy, play it softer first.',
    3: 'Three bends — the hardest hole to control. Go one step at a time: half step first, then whole, then step-and-a-half.',
    4: 'The most common first bend. Say "ee-oo" while drawing and feel the tongue slide back.',
    6: 'A small, high bend. Keep the tongue fairly high and forward — think "ee" sliding to "ih".',
    8: 'Blow bends need a narrow, focused air stream. Think of whistling a falling note.',
    9: 'Tight and quick. A tiny tongue move does it — less is more.',
    10: 'Two blow bends. Aim the air at the roof of the mouth and lower it gently.',
  };
  return tips[t.hole] || 'Keep the lips relaxed; shape the bend with your tongue and throat, not by sucking harder.';
}
