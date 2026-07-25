/**
 * Chord recognition via chroma (pitch-class profile) matching.
 *
 * A strummed chord is polyphonic, so YIN is the wrong tool. Instead we fold the
 * FFT spectrum down into 12 pitch-class bins and compare the resulting shape
 * against chord templates. This is deliberately octave-blind, which is exactly
 * what we want: an open C and a barred C should read the same.
 */

import { NOTE_NAMES } from './notes';

export type Chroma = Float32Array; // length 12, normalized to max 1

/** Ignore bins outside the guitar's useful range plus a couple of harmonics. */
const MIN_HZ = 75;
const MAX_HZ = 2000;

/**
 * @param freqData Output of AnalyserNode.getFloatFrequencyData (dBFS).
 * @param sampleRate Context sample rate.
 * @returns 12-bin chroma vector, or null if the signal is too quiet.
 */
export function computeChroma(freqData: Float32Array, sampleRate: number): Chroma | null {
  const bins = freqData.length;
  const nyquist = sampleRate / 2;
  const chroma = new Float32Array(12);
  let total = 0;

  for (let i = 0; i < bins; i++) {
    const freq = (i * nyquist) / bins;
    if (freq < MIN_HZ || freq > MAX_HZ) continue;

    // dBFS -> linear magnitude. Anything under -70 dB is noise floor.
    const db = freqData[i];
    if (db < -70) continue;
    const magnitude = Math.pow(10, db / 20);

    const midi = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;

    chroma[pitchClass] += magnitude;
    total += magnitude;
  }

  if (total < 1e-4) return null;

  let max = 0;
  for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);
  if (max === 0) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= max;

  return chroma;
}

/** Semitone offsets from the root for each supported chord quality. */
const QUALITIES: Record<string, number[]> = {
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

/**
 * Best-matching chord for a chroma vector, plus runners-up.
 *
 * Cosine similarity rather than raw dot product so that a loud strum and a
 * quiet one score the same — we care about the shape, not the energy.
 */
export function matchChord(chroma: Chroma, topN = 3): ChordMatch[] {
  const matches: ChordMatch[] = [];

  let chromaNorm = 0;
  for (let i = 0; i < 12; i++) chromaNorm += chroma[i] * chroma[i];
  chromaNorm = Math.sqrt(chromaNorm);
  if (chromaNorm === 0) return [];

  for (const [quality, intervals] of Object.entries(QUALITIES)) {
    for (let root = 0; root < 12; root++) {
      const template = new Float32Array(12);
      for (const interval of intervals) template[(root + interval) % 12] = 1;

      let dot = 0;
      let templateNorm = 0;
      for (let i = 0; i < 12; i++) {
        dot += chroma[i] * template[i];
        templateNorm += template[i] * template[i];
      }
      templateNorm = Math.sqrt(templateNorm);

      matches.push({
        name: NOTE_NAMES[root] + qualitySuffix(quality),
        root,
        quality,
        score: dot / (chromaNorm * templateNorm),
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, topN);
}

/**
 * Which notes of an expected chord are missing from what was actually played.
 *
 * This is the useful bit for teaching: "you're missing the third" is far more
 * actionable than "that wasn't a C major". A pitch class counts as present if
 * it carries at least `threshold` of the peak energy.
 */
export function missingTones(
  chroma: Chroma,
  root: number,
  quality: string,
  threshold = 0.35,
): string[] {
  const intervals = QUALITIES[quality] ?? QUALITIES.major;
  const missing: string[] = [];

  for (const interval of intervals) {
    const pitchClass = (root + interval) % 12;
    if (chroma[pitchClass] < threshold) missing.push(NOTE_NAMES[pitchClass]);
  }

  return missing;
}
