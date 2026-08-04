/**
 * Chord recognition via chroma (pitch-class profile) matching.
 *
 * A strummed chord is polyphonic, so YIN is the wrong tool. Instead we fold the
 * spectrum down into 12 pitch-class bins and compare the shape against chord
 * templates. This is deliberately octave-blind, which is what we want: an open
 * C and a barred C should read the same.
 *
 * THE CENTRAL PROBLEM, and why template matching alone is not enough:
 *
 * A single plucked string produces a harmonic series whose pitch classes spell
 * out a major triad. For a fundamental at pitch class p, harmonic 3 lands on
 * p+7 (the fifth) and harmonic 5 lands on p+4 (the major third). So one loud
 * note already looks like a major chord, and a power chord (root + fifth) looks
 * even more like one.
 *
 * Measured against the previous implementation: a C5 power chord scored 0.841
 * cosine similarity against the C major template, and a C major chord with the
 * third muted scored 0.858 — both above the 0.82 threshold that was in use.
 * Both would have been reported as a correct C.
 *
 * The fix is not a better template. It is to stop asking "does this resemble a
 * C major?" and start asking the two questions that actually separate a chord
 * from a note: are three distinct pitch classes genuinely sounding, and is the
 * third louder than the root's own 5th harmonic could explain? Those gates live
 * in checkExpectedChord() below.
 */

import { NOTE_NAMES } from './notes';
import {
  CHROMA_MAX_HZ,
  CHROMA_MIN_HZ,
  MAJOR_THIRD_HARMONIC_LEAKAGE,
  MAX_PITCH_CLASSES,
  MIN_PITCH_CLASSES,
  MIN_RUNNER_UP_MARGIN,
  MISSING_TONE_MIN_SNR,
  MISSING_TONE_PRESENCE,
  PRESENCE_THRESHOLD,
  SPECTRAL_FLOOR_DB,
  THIRD_SAFETY_FACTOR,
} from './thresholds';

export type Chroma = Float32Array; // length 12, normalized so max === 1

/**
 * Fold a linear magnitude spectrum into a 12-bin pitch-class profile.
 *
 * @param magnitudes Linear magnitudes for bins 0..fftSize/2 (see Fft.magnitudes).
 * @param sampleRate Sample rate the spectrum was computed at.
 * @param fftSize    FFT length, needed to map bin index to frequency.
 * @param out        Optional preallocated 12-element target.
 * @returns The chroma vector, or null if the frame carries no usable energy.
 */
export function computeChroma(
  magnitudes: Float32Array,
  sampleRate: number,
  fftSize: number,
  out?: Float32Array,
): Chroma | null {
  const chroma = out ?? new Float32Array(12);
  chroma.fill(0);

  const binHz = sampleRate / fftSize;
  const firstBin = Math.max(1, Math.ceil(CHROMA_MIN_HZ / binHz));
  const lastBin = Math.min(magnitudes.length - 1, Math.floor(CHROMA_MAX_HZ / binHz));
  if (lastBin <= firstBin) return null;

  // Relative spectral floor: track the loudest bin in this frame and ignore
  // everything far below it. Relative rather than absolute so the floor follows
  // playing dynamics instead of assuming a particular input gain.
  let peakMagnitude = 0;
  for (let i = firstBin; i <= lastBin; i++) {
    if (magnitudes[i] > peakMagnitude) peakMagnitude = magnitudes[i];
  }
  if (peakMagnitude <= 0) return null;

  const floor = peakMagnitude * Math.pow(10, SPECTRAL_FLOOR_DB / 20);

  let total = 0;
  for (let i = firstBin; i <= lastBin; i++) {
    const magnitude = magnitudes[i];
    if (magnitude < floor) continue;

    const freq = i * binHz;
    const midi = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;

    chroma[pitchClass] += magnitude;
    total += magnitude;
  }

  if (total <= 0) return null;

  let max = 0;
  for (let i = 0; i < 12; i++) if (chroma[i] > max) max = chroma[i];
  if (max <= 0) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= max;

  return chroma;
}

/** Semitone offsets from the root for each supported chord quality. */
export const QUALITIES: Record<string, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  sus4: [0, 5, 7],
};

export interface ChordMatch {
  /** e.g. "C", "Am", "G7". */
  name: string;
  root: number;
  quality: string;
  /** Cosine similarity against the template, 0..1. */
  score: number;
}

function qualitySuffix(quality: string): string {
  switch (quality) {
    case 'major': return '';
    case 'minor': return 'm';
    case 'dom7': return '7';
    case 'min7': return 'm7';
    case 'sus4': return 'sus4';
    default: return quality;
  }
}

export function chordName(root: number, quality: string): string {
  return NOTE_NAMES[((root % 12) + 12) % 12] + qualitySuffix(quality);
}

/** The interval that defines a chord's quality: major 3rd, minor 3rd, or 4th. */
export function characteristicInterval(quality: string): number {
  const intervals = QUALITIES[quality] ?? QUALITIES.major;
  // The first interval that is not the root or the perfect fifth.
  return intervals.find((i) => i !== 0 && i !== 7) ?? 4;
}

// Templates are fixed, so build them once rather than per call.
const TEMPLATES: Array<{ root: number; quality: string; vector: Float32Array; norm: number }> = [];
for (const [quality, intervals] of Object.entries(QUALITIES)) {
  for (let root = 0; root < 12; root++) {
    const vector = new Float32Array(12);
    for (const interval of intervals) vector[(root + interval) % 12] = 1;
    TEMPLATES.push({ root, quality, vector, norm: Math.sqrt(intervals.length) });
  }
}

/**
 * Best-matching chords for a chroma vector, best first.
 *
 * Cosine similarity rather than raw dot product so a loud strum and a quiet one
 * score the same — we care about the shape, not the energy.
 */
export function matchChord(chroma: Chroma, topN = 3): ChordMatch[] {
  let chromaNorm = 0;
  for (let i = 0; i < 12; i++) chromaNorm += chroma[i] * chroma[i];
  chromaNorm = Math.sqrt(chromaNorm);
  if (chromaNorm === 0) return [];

  const matches: ChordMatch[] = TEMPLATES.map((t) => {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += chroma[i] * t.vector[i];
    return {
      name: chordName(t.root, t.quality),
      root: t.root,
      quality: t.quality,
      score: dot / (chromaNorm * t.norm),
    };
  });

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, topN);
}

/** Pitch classes carrying enough energy to count as actually sounding. */
export function presentPitchClasses(chroma: Chroma, threshold = PRESENCE_THRESHOLD): number[] {
  const present: number[] = [];
  for (let i = 0; i < 12; i++) if (chroma[i] >= threshold) present.push(i);
  return present;
}

/**
 * Is `rival` close to `expected` only because it is the same chord with an
 * extension added or removed?
 *
 * C major and C7 differ by one added note and always score within a few percent
 * of each other; so do Am and Am7. Failing a player for that would be wrong —
 * they played the right shape. But C major vs C minor, or C vs Csus4, differ in
 * the tone that defines the chord's quality, and those must not be waved
 * through. So the runner-up margin is measured against the best rival that is
 * NOT a same-root extension.
 */
export function isBenignRival(expected: ChordMatch | ChordSpec, rival: ChordMatch): boolean {
  if (rival.root !== expected.root) return false;
  const a = QUALITIES[expected.quality] ?? [];
  const b = QUALITIES[rival.quality] ?? [];
  const superset = (x: number[], y: number[]) => y.every((v) => x.includes(v));
  return superset(a, b) || superset(b, a);
}

export interface ChordSpec {
  root: number;
  quality: string;
}

export interface ExpectedChordCheck {
  /** Cosine similarity of the expected chord's template. */
  score: number;
  /** Was the expected chord the single best match? */
  isTopMatch: boolean;
  /** The strongest non-benign competitor, if any. */
  rival: ChordMatch | null;
  /** score - rival.score. Infinity when there is no meaningful rival. */
  margin: number;
  /** Did a chord-like number of distinct pitch classes sound — not too few, not all twelve? */
  hasEnoughPitchClasses: boolean;
  /** Number of pitch classes above the presence threshold. */
  pitchClassCount: number;
  /**
   * Is the quality-defining tone present at a level the root's own harmonics
   * cannot account for?
   */
  hasCharacteristicTone: boolean;
  /** Every gate satisfied for this single frame (temporal stability is separate). */
  passes: boolean;
}

/**
 * Evaluate the evidence for one specific expected chord.
 *
 * Deliberately asks about the chord the lesson requested rather than reporting
 * whatever scored highest, because "you played A minor instead of C" is more
 * useful than "that was an A minor".
 */
export function checkExpectedChord(
  chroma: Chroma,
  expected: ChordSpec,
  minMargin = MIN_RUNNER_UP_MARGIN,
): ExpectedChordCheck {
  const all = matchChord(chroma, TEMPLATES.length);
  const self = all.find((m) => m.root === expected.root && m.quality === expected.quality);
  const score = self?.score ?? 0;

  const isTopMatch = all.length > 0 && all[0].root === expected.root && all[0].quality === expected.quality;

  const rival = all.find(
    (m) => !(m.root === expected.root && m.quality === expected.quality) && !isBenignRival(expected, m),
  ) ?? null;
  const margin = rival ? score - rival.score : Infinity;

  // Too few pitch classes means a single note or a power chord. Too many means
  // the spectrum is flat, i.e. noise rather than a chord. Both are rejections.
  const present = presentPitchClasses(chroma);
  const hasEnoughPitchClasses =
    present.length >= MIN_PITCH_CLASSES && present.length <= MAX_PITCH_CLASSES;

  // The characteristic-tone test.
  //
  // A major third sits at harmonic 5 of the root, so some energy always appears
  // there even when nobody fretted it — that is exactly how a power chord fakes
  // a major chord. Require the third to exceed what the root alone could
  // produce, by a safety factor.
  //
  // Minor thirds and fourths get no such discount: neither appears in the low
  // harmonic series of the root, so any energy at those pitch classes was
  // genuinely played. This asymmetry is physical, not a tuning fudge.
  //
  // Every tone that is neither the root nor the fifth must clear its bar, not
  // just the first one. For major, minor and sus4 there is exactly one such
  // tone and this is unchanged. For the seventh chords it also requires the
  // seventh, which previously went unchecked: characteristicInterval() returns
  // the third for dom7/min7, so a plain triad satisfied the quality gate of the
  // corresponding seventh chord outright. Nothing in the current lesson uses a
  // seventh, so this closes the hole before a lesson can walk into it.
  const rootEnergy = chroma[expected.root % 12];
  const defining = (QUALITIES[expected.quality] ?? QUALITIES.major).filter(
    (i) => i !== 0 && i !== 7,
  );
  let hasCharacteristicTone = defining.length > 0;
  for (const interval of defining) {
    const tone = chroma[(expected.root + interval) % 12];
    const requiredTone =
      interval === 4
        ? Math.max(
            PRESENCE_THRESHOLD,
            rootEnergy * MAJOR_THIRD_HARMONIC_LEAKAGE * THIRD_SAFETY_FACTOR,
          )
        : PRESENCE_THRESHOLD;
    if (tone < requiredTone) {
      hasCharacteristicTone = false;
      break;
    }
  }

  return {
    score,
    isTopMatch,
    rival,
    margin,
    hasEnoughPitchClasses,
    pitchClassCount: present.length,
    hasCharacteristicTone,
    passes:
      isTopMatch && margin >= minMargin && hasEnoughPitchClasses && hasCharacteristicTone,
  };
}

/**
 * Which notes of an expected chord are missing from what was actually played.
 *
 * "You're missing the third" is far more actionable than "that wasn't a C
 * major" — but only if it is true. Returns null rather than a guess when the
 * signal is too weak to support naming a specific absent note, and the caller
 * is expected to show nothing in that case.
 *
 * @param snrDb Signal-to-noise ratio of the frame, in dB, against the measured
 *              room floor. Below MISSING_TONE_MIN_SNR the per-bin levels are
 *              not trustworthy enough to say a particular string was silent.
 */
export function missingTones(
  chroma: Chroma,
  expected: ChordSpec,
  snrDb: number,
  threshold = MISSING_TONE_PRESENCE,
): string[] | null {
  if (!Number.isFinite(snrDb) || snrDb < MISSING_TONE_MIN_SNR) return null;

  const intervals = QUALITIES[expected.quality] ?? QUALITIES.major;
  const missing: string[] = [];

  for (const interval of intervals) {
    const pitchClass = (expected.root + interval) % 12;
    if (chroma[pitchClass] < threshold) missing.push(NOTE_NAMES[pitchClass]);
  }

  // Every tone missing means we are not hearing this chord at all; naming all
  // three notes as "missing" is noise, not advice.
  return missing.length === intervals.length ? null : missing;
}
