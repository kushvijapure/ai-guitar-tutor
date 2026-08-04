/**
 * Synthetic guitar-ish signals for the DSP tests.
 *
 * These are NOT recordings and they are not a substitute for one. What they can
 * prove is that the maths is wired up correctly and that specific, physically
 * motivated failure modes (a power chord looking like a major triad, a single
 * note's harmonics spelling out a chord) are actually rejected. What they cannot
 * prove is real-world accuracy: a real pickup adds inharmonicity, fret buzz,
 * body resonance, room reflections, and a noise profile none of this models.
 *
 * The one thing modelled carefully is the harmonic series, because that is the
 * source of the false positives the chord gates exist to stop.
 */

import { midiToFreq } from '../src/lib/notes';

export const DEFAULT_SAMPLE_RATE = 44100;

export interface ToneOptions {
  /** Number of harmonics to synthesize. Real strings have many; 8 is plenty. */
  harmonics?: number;
  /**
   * Amplitude of harmonic h is 1/h**rolloff. 1.0 is the textbook plucked string.
   * Lower values mean a brighter, more harmonically rich tone — which is the
   * harder case for chord recognition, so some tests deliberately use 0.7.
   */
  rolloff?: number;
  /** Peak amplitude of the fundamental. */
  amplitude?: number;
  /** Seconds for the fundamental to decay to 1/e. 0 disables the envelope. */
  decay?: number;
  /** Seconds into the buffer at which the note starts. */
  startSeconds?: number;
  /** Randomised per-harmonic phase makes the summed waveform less artificial. */
  phase?: number;
}

/**
 * One plucked note, added into `out`.
 *
 * Higher harmonics are given a shorter decay than the fundamental, which is
 * what real strings do and what makes a sustained chord's chroma drift toward
 * the fundamentals over time.
 */
export function addNote(
  out: Float32Array,
  midi: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  options: ToneOptions = {},
): Float32Array {
  const {
    harmonics = 8,
    rolloff = 1,
    amplitude = 0.3,
    decay = 0,
    startSeconds = 0,
    phase = 0,
  } = options;

  const f0 = midiToFreq(midi);
  const start = Math.floor(startSeconds * sampleRate);

  for (let h = 1; h <= harmonics; h++) {
    const freq = f0 * h;
    if (freq >= sampleRate / 2) break;

    const harmonicAmplitude = amplitude / Math.pow(h, rolloff);
    // Higher partials die faster on a real string.
    const harmonicDecay = decay > 0 ? decay / Math.sqrt(h) : 0;
    const harmonicPhase = phase * h * 0.61803399; // irrational spacing, avoids alignment

    for (let i = start; i < out.length; i++) {
      const t = (i - start) / sampleRate;
      const envelope = harmonicDecay > 0 ? Math.exp(-t / harmonicDecay) : 1;
      out[i] += harmonicAmplitude * envelope * Math.sin(2 * Math.PI * freq * t + harmonicPhase);
    }
  }

  return out;
}

/** A chord: several notes sounding together. */
export function chord(
  midis: number[],
  samples: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  options: ToneOptions = {},
): Float32Array {
  const out = new Float32Array(samples);
  midis.forEach((midi, i) => addNote(out, midi, sampleRate, { ...options, phase: i + 1 }));
  return out;
}

/**
 * A strum: the same notes, but entering a few milliseconds apart and decaying,
 * which is what the analyser actually sees in the field.
 */
export function strum(
  midis: number[],
  samples: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  options: ToneOptions & { spreadSeconds?: number } = {},
): Float32Array {
  const { spreadSeconds = 0.025, ...tone } = options;
  const out = new Float32Array(samples);
  midis.forEach((midi, i) => {
    addNote(out, midi, sampleRate, {
      decay: 2,
      ...tone,
      startSeconds: (tone.startSeconds ?? 0) + i * spreadSeconds,
      phase: i + 1,
    });
  });
  return out;
}

export function silence(samples: number): Float32Array {
  return new Float32Array(samples);
}

/** Broadband noise, added in place. */
export function addNoise(out: Float32Array, level: number, seed = 1): Float32Array {
  // Deterministic PRNG so a failing test fails the same way twice.
  let state = seed >>> 0 || 1;
  for (let i = 0; i < out.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] += ((state / 0xffffffff) * 2 - 1) * level;
  }
  return out;
}

/** Mains hum: a fundamental plus its odd harmonics, as a cheap single-coil does. */
export function addHum(
  out: Float32Array,
  level: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
  baseHz = 60,
): Float32Array {
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    out[i] +=
      level * Math.sin(2 * Math.PI * baseHz * t) +
      level * 0.4 * Math.sin(2 * Math.PI * baseHz * 3 * t) +
      level * 0.2 * Math.sin(2 * Math.PI * baseHz * 5 * t);
  }
  return out;
}

export function scale(buffer: Float32Array, factor: number): Float32Array {
  for (let i = 0; i < buffer.length; i++) buffer[i] *= factor;
  return buffer;
}

/** Join buffers end to end — for silence -> chord -> silence sequences. */
export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Split a signal into overlapping analysis frames, as the worklet does. */
export function frames(signal: Float32Array, frameSize: number, hop: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let start = 0; start + frameSize <= signal.length; start += hop) {
    out.push(signal.subarray(start, start + frameSize));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Named chord voicings, as actually fingered on a guitar in standard tuning.
// MIDI 40 = E2 = low open E.
// ---------------------------------------------------------------------------

export const VOICINGS = {
  /** x32010 */
  C: [48, 52, 55, 60, 64],
  /** x02210 */
  Am: [45, 52, 57, 60, 64],
  /** 022000 */
  Em: [40, 47, 52, 55, 59, 64],
  /** 320003 */
  G: [43, 47, 50, 55, 59, 67],
  /** xx0232 */
  D: [50, 57, 62, 66],
  /** x02220 — the major/minor confusion partner for Am */
  A: [45, 52, 57, 61, 64],
  /** 022100 — E major, confusion partner for Em */
  E: [40, 47, 52, 56, 59, 64],
  /** C power chord: root + fifth only */
  C5: [48, 55],
  /** E power chord */
  E5: [40, 47],
  /** C major with the third (E) muted — the classic beginner error */
  C_noThird: [48, 55, 60],
  /** C major with an F added by a stray finger */
  C_wrongNote: [48, 52, 55, 60, 65],
  /** Csus4 */
  Csus4: [48, 53, 55, 60],
} as const;
