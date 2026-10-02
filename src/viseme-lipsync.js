// Phoneme-shaped lip sync from text, as a counterpart to the microphone path in
// speech.js. That one listens to audio and guesses openness from RMS and shape
// from spectral balance, which cannot know whether "ee" or "oo" was said.
// This one goes the other way: it reads the words, converts their spelling to
// Oculus-style viseme ids with a compact English rule set, and lays them over
// estimated word timings. Same {open, round, form} triplet out, so it drops
// into motion.update() exactly where the microphone shape goes.
//
// What it is not: acoustic recognition. Nothing here listens. Word durations
// are estimated from spelling and punctuation, so a caller that knows real
// timings (a speech synthesiser's word boundaries, a forced aligner) should
// pass them in rather than let buildVisemeTrack guess.
//
// Every export is pure and runs under Node, so the rules are unit-testable
// without a browser.

// Mouth pose per viseme. form is bipolar: negative rounds and narrows the lips,
// positive spreads them wide, matching the convention in speech.js.
export const VISEME_SHAPES = {
  sil: { open: 0, round: 0, form: 0 },
  PP: { open: 0, round: 0.15, form: -0.1 },
  FF: { open: 0.16, round: 0.1, form: 0.15 },
  TH: { open: 0.3, round: 0.05, form: 0.1 },
  DD: { open: 0.34, round: 0.05, form: 0.05 },
  kk: { open: 0.4, round: 0.05, form: 0 },
  CH: { open: 0.3, round: 0.5, form: -0.35 },
  SS: { open: 0.14, round: 0, form: 0.5 },
  nn: { open: 0.24, round: 0.05, form: 0.05 },
  RR: { open: 0.3, round: 0.45, form: -0.3 },
  aa: { open: 0.95, round: 0, form: 0.25 },
  E: { open: 0.5, round: 0, form: 0.6 },
  I: { open: 0.34, round: 0, form: 0.85 },
  O: { open: 0.7, round: 0.8, form: -0.5 },
  U: { open: 0.34, round: 0.95, form: -0.75 },
};

// Relative time each viseme wants. Vowels hold, plosives are a tap.
export const VISEME_WEIGHTS = {
  sil: 0.8, PP: 0.5, FF: 0.7, TH: 0.7, DD: 0.55, kk: 0.6, CH: 0.8,
  SS: 0.85, nn: 0.7, RR: 0.75, aa: 1.25, E: 1.1, I: 1, O: 1.2, U: 1.1,
};

// Multi-letter spellings, longest first so "OUGH" wins over "OU".
const CLUSTERS = [
  ["EIGH", ["E"]],
  ["OUGH", ["O"]],
  ["TCH", ["CH"]],
  ["SCH", ["SS", "kk"]],
  ["IGH", ["I"]],
  ["TH", ["TH"]],
  ["CH", ["CH"]],
  ["SH", ["CH"]],
  ["PH", ["FF"]],
  ["GH", []],
  ["CK", ["kk"]],
  ["NG", ["nn"]],
  ["QU", ["kk", "U"]],
  ["WH", ["U"]],
  ["WR", ["RR"]],
  ["KN", ["nn"]],
  ["PS", ["SS"]],
  ["EE", ["E"]],
  ["EA", ["E"]],
  ["IE", ["E"]],
  ["EI", ["E"]],
  ["EY", ["E"]],
  ["AI", ["E"]],
  ["AY", ["E"]],
  ["OO", ["U"]],
  ["OU", ["O", "U"]],
  ["OW", ["O", "U"]],
  ["OI", ["O", "I"]],
  ["OY", ["O", "I"]],
  ["AU", ["O"]],
  ["AW", ["O"]],
  ["OA", ["O"]],
  ["UE", ["U"]],
  ["UI", ["U"]],
  ["EW", ["U"]],
];

const SINGLES = {
  A: "aa", E: "E", I: "I", O: "O", U: "U", Y: "I",
  B: "PP", P: "PP", M: "PP",
  F: "FF", V: "FF",
  T: "DD", D: "DD",
  K: "kk", G: "kk", C: "kk", Q: "kk",
  S: "SS", Z: "SS",
  N: "nn", L: "nn",
  R: "RR",
  J: "CH",
  W: "U",
  H: null,
};

const VOWELS = "AEIOUY";
const SOFTENERS = "EIY";
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Spelling to viseme ids for a single word.
 * Deliberately a rule set rather than a dictionary: no lookup table to ship,
 * and it degrades gracefully on names and invented words. It will mispronounce
 * the genuinely irregular ones ("colonel"), which costs a wrong mouth shape
 * for one syllable and nothing else.
 */
export function wordToVisemes(word) {
  // Strip diacritics first so "Zoe" and "Zoe\u0308" speak the same.
  const letters = String(word)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!letters) return [];

  // Silent final E: "make" is three sounds, not four. Only past four letters,
  // because the short words where E carries the vowel ("the", "she", "we") are
  // the ones said most often.
  let text = letters;
  if (text.length > 3 && text.endsWith("E") && !VOWELS.includes(text[text.length - 2])) {
    text = text.slice(0, -1);
  }

  const out = [];
  let i = 0;
  while (i < text.length) {
    // Doubled consonants say one sound: "LL" is one nn.
    if (text[i] === text[i + 1] && !VOWELS.includes(text[i])) {
      i += 1;
      continue;
    }

    const cluster = CLUSTERS.find((entry) => text.startsWith(entry[0], i));
    if (cluster) {
      out.push(...cluster[1]);
      i += cluster[0].length;
      continue;
    }

    const ch = text[i];
    const next = text[i + 1];
    if (ch === "X") {
      out.push("kk", "SS");
    } else if (ch === "C" && SOFTENERS.includes(next)) {
      out.push("SS");
    } else if (ch === "G" && SOFTENERS.includes(next)) {
      out.push("CH");
    } else {
      const viseme = SINGLES[ch];
      if (viseme) out.push(viseme);
    }
    i += 1;
  }

  // Collapse immediate repeats so the mouth moves instead of holding.
  const merged = out.filter((v, k) => v !== out[k - 1]);
  return merged.length ? merged : ["aa"];
}

/**
 * Guess when each word starts and how long it lasts, from spelling and
 * punctuation. charsPerSecond is the speaking rate; measure it from a real
 * voice and pass it in rather than trusting the default.
 */
export function estimateWordTimings(text, charsPerSecond = 15.5) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  const rate = charsPerSecond > 0 ? charsPerSecond : 15.5;
  const words = [];
  const times = [];
  const durations = [];
  let cursor = 0;

  for (const token of tokens) {
    const core = token.replace(/[^\p{L}\p{N}']/gu, "");
    let weight = (core.length || token.length) + 1.7;
    if (/[,;:)\]]$/.test(token)) weight += 2.6;
    if (/[.!?…]$/.test(token)) weight += 5.2;
    if (/[-–—]$/.test(token)) weight += 3;

    const duration = (weight / rate) * 1000;
    words.push(token);
    times.push(Math.round(cursor));
    durations.push(Math.round(duration));
    cursor += duration;
  }

  return { words, times, durations, totalMs: Math.round(cursor) };
}

/**
 * Text to a timed viseme track.
 * Pass { words, times, durations } as `timings` when real word boundaries are
 * known; otherwise they are estimated from `charsPerSecond`.
 */
export function buildVisemeTrack(text, { charsPerSecond = 15.5, timings = null } = {}) {
  const timed = timings ?? estimateWordTimings(text, charsPerSecond);
  const segments = [];

  for (let w = 0; w < timed.words.length; w++) {
    const visemes = wordToVisemes(timed.words[w]);
    if (!visemes.length) continue;

    const start = timed.times[w];
    // Keep a sliver of closure at each word end so words stay distinct.
    const span = timed.durations[w] * 0.88;
    let total = 0;
    for (const v of visemes) total += VISEME_WEIGHTS[v] ?? 1;
    if (total <= 0) continue;

    let cursor = start;
    for (const v of visemes) {
      const length = (span * (VISEME_WEIGHTS[v] ?? 1)) / total;
      segments.push({ viseme: v, t0: cursor, t1: cursor + Math.max(20, length) });
      cursor += length;
    }
  }

  const totalMs = segments.length ? Math.round(segments[segments.length - 1].t1) : 0;
  // SpeechSynthesis boundary charIndex uses UTF-16 offsets into the original
  // text, including leading whitespace and repeated words.
  const charIndices = Array.from(String(text).matchAll(/\S+/g), match => match.index);
  return { segments, totalMs, words: timed.words, times: timed.times, durations: timed.durations, charIndices };
}

/**
 * Mouth pose at `elapsedMs` into a track, or null once it has finished, so the
 * caller can hand control back to the idle mouth instead of pinning it shut.
 */
export function sampleVisemeTrack(track, elapsedMs) {
  if (!track || !track.segments.length) return null;
  if (elapsedMs < 0) return { ...VISEME_SHAPES.sil };
  if (elapsedMs > track.totalMs) return null;

  // Segments are ordered, so stop as soon as one starts in the future.
  let found = null;
  for (const segment of track.segments) {
    if (elapsedMs >= segment.t0 && elapsedMs <= segment.t1) { found = segment; break; }
    if (segment.t0 > elapsedMs) break;
  }
  if (!found) return { ...VISEME_SHAPES.sil };

  const shape = VISEME_SHAPES[found.viseme] ?? VISEME_SHAPES.sil;
  return { ...shape };
}

/**
 * Holds one utterance and reports the mouth pose for a wall-clock timestamp.
 * The only stateful piece, kept thin: motion.js already eases toward whatever
 * target it is given, so this deliberately does no smoothing of its own.
 */
export class VisemeTalker {
  constructor({ charsPerSecond = 15.5, gain = 1 } = {}) {
    this.charsPerSecond = charsPerSecond;
    this.gain = gain;
    this.track = null;
    this.startedAt = 0;
    this.offsetMs = 0;
    this.lastBoundary = -1;
    this.holdUntilStop = false;
  }

  /** Begin an utterance at `startMs` (default: now). */
  speak(text, { startMs = null, timings = null, holdUntilStop = false } = {}) {
    this.track = buildVisemeTrack(text, { charsPerSecond: this.charsPerSecond, timings });
    this.startedAt = startMs ?? (typeof performance === "object" ? performance.now() : Date.now());
    this.offsetMs = 0;
    this.lastBoundary = -1;
    this.holdUntilStop = holdUntilStop;
    return this.track;
  }

  stop() {
    this.track = null;
  }

  get speaking() {
    return this.track !== null;
  }

  elapsedAt(timeMs) {
    return timeMs - this.startedAt + this.offsetMs;
  }

  /** Anchor the shared mouth/gesture clock to a synthesiser word event. */
  syncWord(charIndex, timeMs) {
    if (!this.track || !Number.isInteger(charIndex) || !Number.isFinite(timeMs)) return false;
    const word = this.track.charIndices.indexOf(charIndex);
    if (word < 0 || word <= this.lastBoundary || word >= this.track.times.length) return false;
    this.offsetMs = this.track.times[word] - (timeMs - this.startedAt);
    this.lastBoundary = word;
    return true;
  }

  /** Mouth pose for a wall-clock time, or null when nothing is being said. */
  shapeAt(timeMs) {
    if (!this.track) return null;
    const shape = sampleVisemeTrack(this.track, this.elapsedAt(timeMs));
    // Keep the track available for a late word boundary if the voice is slower
    // than predicted. The synthesiser's end/stop event releases it explicitly.
    if (!shape) {
      if (this.holdUntilStop) return { ...VISEME_SHAPES.sil };
      this.track = null;
      return null;
    }
    if (this.gain === 1) return shape;
    return {
      open: clamp(shape.open * this.gain, 0, 1),
      round: clamp(shape.round * this.gain, 0, 1),
      form: clamp(shape.form * this.gain, -1, 1),
    };
  }
}
