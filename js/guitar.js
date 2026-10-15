// Guitar model for the bend trainer: tunings, strings, bend sizes and coaching tips.
// Strings are numbered the guitarist's way: 1 is the thin high E, 6 is the thick low E.

// Open-string MIDI notes, listed from string 6 (low) to string 1 (high).
export const TUNINGS = [
  { id: 'std',  label: 'Standard',          short: 'Standard', open: [40, 45, 50, 55, 59, 64], flats: false },
  { id: 'eb',   label: 'Half step down',    short: 'E♭',       open: [39, 44, 49, 54, 58, 63], flats: true },
  { id: 'd',    label: 'Whole step down',   short: 'D',        open: [38, 43, 48, 53, 57, 62], flats: false },
  { id: 'dropd', label: 'Drop D',           short: 'Drop D',   open: [38, 45, 50, 55, 59, 64], flats: false },
];

// Bend sizes in cents above the fretted note.
export const AMOUNTS = [
  { id: 'q',  label: '¼',    cents: 50,  name: 'quarter-tone curl',  phrase: 'a quarter tone' },
  { id: 'h',  label: '½',    cents: 100, name: 'half-step bend',     phrase: 'a half step' },
  { id: 'f',  label: 'Full', cents: 200, name: 'whole-step bend',    phrase: 'a whole step' },
  { id: 'f15', label: '1½',  cents: 300, name: 'step-and-a-half bend', phrase: 'a step and a half' },
  { id: 'f2', label: '2',    cents: 400, name: 'two-step bend',      phrase: 'two whole steps' },
];

export const MAX_FRET = 22;

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLATS  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export function noteName(midi, tuning, withOctave = true) {
  const m = Math.round(midi);
  const names = tuning.flats ? FLATS : SHARPS;
  const n = names[((m % 12) + 12) % 12];
  return withOctave ? `${n}${Math.floor(m / 12) - 1}` : n;
}

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

/** Open-string MIDI note for string 1–6. */
export const openNote = (tuning, string) => tuning.open[6 - string];

/** Lowercase "e" for string 1 is how tabs tell the two E strings apart. */
export function stringName(tuning, string) {
  const n = noteName(openNote(tuning, string), tuning, false);
  return string === 1 ? n.toLowerCase() : n;
}

export function buildTarget(tuning, string, fret, amountId) {
  const amount = AMOUNTS.find((a) => a.id === amountId) || AMOUNTS[2];
  const naturalMidi = openNote(tuning, string) + fret;
  return { string, fret, amount, naturalMidi, targetMidi: naturalMidi + amount.cents / 100, cents: amount.cents };
}

/** Display name of the target note; a quarter tone sits between notes. */
export function targetLabel(t, tuning, withOctave = false) {
  if (t.amount.cents % 100) return `${noteName(t.naturalMidi, tuning, withOctave)} +¼`;
  return noteName(t.targetMidi, tuning, withOctave);
}

const STRING_WORDS = { 1: 'high E', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'low E' };
export function stringWord(tuning, string) {
  return tuning.id === 'std' ? STRING_WORDS[string] : `${stringName(tuning, string)} (string ${string})`;
}

/** Coaching tip for this string and bend size. */
export function bendTip(t) {
  const high = t.string <= 3;
  const dir = high
    ? 'Push the string toward the ceiling with your ring finger, with your middle and index fingers lined up behind it to help.'
    : 'On the low strings, pull toward the floor so the string doesn\'t slide off the edge of the neck.';
  const wrist = 'Hook your thumb over the neck and rotate your wrist like turning a doorknob, instead of pushing with the fingertip.';
  const size = {
    50: 'A quarter-tone curl is just a nudge: aim for the bluesy sound between two notes.',
    100: 'Half steps are short. Stop as soon as the gauge reaches green; it\'s easy to overshoot.',
    200: 'Before bending, fret two frets higher and listen. That\'s the note you\'re aiming for.',
    300: 'Big bends need light strings and your whole wrist. Fret three frets higher first to hear the target.',
    400: 'Two-step bends are extreme. Use light strings (9s or 10s); most acoustic guitars can\'t do this.',
  }[t.cents];
  return `${dir} ${wrist} ${size}`;
}

export function tuningTip(tuning) {
  return {
    std: 'Most songs and lessons use standard tuning: E A D G B E from the thickest string.',
    eb: 'Every string a half step lower (E♭ A♭ D♭ G♭ B♭ E♭). Looser strings make bends a bit easier.',
    d: 'Every string a whole step lower (D G C F A D). Bends are easier, and big bends need care not to overshoot.',
    dropd: 'Standard tuning with the low E dropped to D. Bends on the top five strings work exactly like standard.',
  }[tuning.id];
}

/* ───────── Keys and classic bend presets ───────── */
// Keys guitarists most often solo in. `pc` is the pitch class of the root.
export const KEYS = [
  { id: 'E', pc: 4 }, { id: 'A', pc: 9 }, { id: 'G', pc: 7 }, { id: 'D', pc: 2 }, { id: 'C', pc: 0 }, { id: 'B', pc: 11 },
];

/** Fret where the box-1 root sits on the low (6th-string-shaped) position, kept between 3 and 14. */
function rootFret(tuning, pc) {
  const refLow = openNote(tuning, 5) - 5;   // the A string minus a 4th: works for Drop D too
  let r = ((pc - refLow) % 12 + 12) % 12;
  if (r < 3) r += 12;
  return r;
}

/**
 * The famous bend spots in a key, all on the top three strings.
 * Minor: the minor pentatonic box. Major: the same shape moved down 3 frets (major pentatonic).
 */
export function presets(tuning, keyId, mode) {
  const key = KEYS.find((k) => k.id === keyId) || KEYS[1];
  if (mode === 'major') {
    let p = rootFret(tuning, key.pc) - 3;
    if (p < 2) p += 12;
    return [
      { string: 3, fret: p + 2, amount: 'f', box: 'Major box', degrees: '2 → 3' },
      { string: 2, fret: p + 3, amount: 'f', box: 'Major box', degrees: '5 → 6' },
      { string: 1, fret: p + 3, amount: 'f', box: 'Major box', degrees: '1 → 2' },
      { string: 3, fret: p, amount: 'f', box: 'Major box', degrees: '1 → 2' },
    ];
  }
  const r = rootFret(tuning, key.pc);
  return [
    { string: 3, fret: r + 2, amount: 'f', box: 'Box 1', degrees: '4 → 5' },
    { string: 2, fret: r + 3, amount: 'f', box: 'Box 1', degrees: '♭7 → 1' },
    { string: 1, fret: r + 3, amount: 'f', box: 'Box 1', degrees: '♭3 → 4' },
    { string: 3, fret: r, amount: 'f', box: 'Box 1', degrees: '♭3 → 4' },
    { string: 2, fret: r + 5, amount: 'f', box: 'Box 2', degrees: '1 → 2' },
    { string: 3, fret: r, amount: 'q', box: 'Blues curl', degrees: '♭3 curl' },
  ];
}

/** Tab for the bend, e.g. "7b9", "7b8", "7b¼". */
export function tabFor(t) {
  if (t.cents % 100) return `${t.fret}b¼`;
  return `${t.fret}b${t.fret + t.cents / 100}`;
}

export const TOLERANCES = [
  { id: 'easy', label: 'Easy', cents: 30, hint: '±30¢, good while you learn' },
  { id: 'normal', label: 'Normal', cents: 20, hint: '±20¢, in tune to most ears' },
  { id: 'strict', label: 'Strict', cents: 10, hint: '±10¢, studio-tight' },
];

/** Keys conventionally written with flats (G minor → B♭, not A♯). */
export function keyUsesFlats(keyId, mode) {
  return mode === 'minor' ? ['G', 'C', 'D'].includes(keyId) : false;
}
