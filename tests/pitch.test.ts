import { describe, expect, it } from 'vitest';
import { PitchDetector } from '../src/lib/pitch';
import { freqToNote, midiToFreq, nearestString } from '../src/lib/notes';
import { FRAME_SIZE } from '../src/lib/thresholds';
import { addNoise, addNote, DEFAULT_SAMPLE_RATE, silence } from './signals';

const SR = DEFAULT_SAMPLE_RATE;

function note(midi: number, sampleRate = SR, options = {}): Float32Array {
  return addNote(new Float32Array(FRAME_SIZE), midi, sampleRate, {
    amplitude: 0.3,
    harmonics: 8,
    ...options,
  });
}

function centsOff(measured: number, expected: number): number {
  return Math.abs(1200 * Math.log2(measured / expected));
}

describe('PitchDetector', () => {
  const detector = new PitchDetector(FRAME_SIZE);

  it.each([
    ['E2 low string', 40],
    ['A2', 45],
    ['D3', 50],
    ['G3', 55],
    ['B3', 59],
    ['E4 high string', 64],
    ['A4 reference', 69],
  ])('finds %s within 10 cents', (_label, midi) => {
    const expected = midiToFreq(midi);
    const result = detector.detect(note(midi), SR);
    expect(result).not.toBeNull();
    expect(centsOff(result!.frequency, expected)).toBeLessThan(10);
  });

  it('does not report the octave below, which plain autocorrelation does', () => {
    const expected = midiToFreq(64);
    const result = detector.detect(note(64), SR);
    expect(result!.frequency).toBeGreaterThan(expected * 0.9);
  });

  it('returns null for silence', () => {
    expect(detector.detect(silence(FRAME_SIZE), SR)).toBeNull();
  });

  it('returns null for low-level noise', () => {
    expect(detector.detect(addNoise(silence(FRAME_SIZE), 0.001), SR)).toBeNull();
  });

  it('reports low clarity for broadband noise rather than a confident wrong answer', () => {
    const result = detector.detect(addNoise(silence(FRAME_SIZE), 0.2), SR);
    // Either no reading at all, or one the caller will discard on clarity.
    if (result !== null) expect(result.clarity).toBeLessThan(0.6);
  });

  it('works at 48 kHz as well as 44.1 kHz', () => {
    const expected = midiToFreq(45);
    for (const rate of [44100, 48000, 32000]) {
      const result = new PitchDetector(FRAME_SIZE).detect(note(45, rate), rate);
      expect(result, `no detection at ${rate}`).not.toBeNull();
      expect(centsOff(result!.frequency, expected), `at ${rate} Hz`).toBeLessThan(15);
    }
  });

  it('survives moderate added noise', () => {
    const buffer = note(45);
    addNoise(buffer, 0.01);
    const result = detector.detect(buffer, SR);
    expect(result).not.toBeNull();
    expect(centsOff(result!.frequency, midiToFreq(45))).toBeLessThan(15);
  });

  it('never returns a frequency outside the searched band', () => {
    for (const midi of [40, 52, 64, 76]) {
      const result = detector.detect(note(midi), SR);
      if (result) {
        expect(result.frequency).toBeGreaterThanOrEqual(70 * 0.95);
        expect(result.frequency).toBeLessThanOrEqual(1200 * 1.05);
      }
    }
  });

  it('reuses its buffers across calls without changing results', () => {
    const first = detector.detect(note(45), SR);
    detector.detect(note(64), SR);
    const again = detector.detect(note(45), SR);
    expect(again!.frequency).toBeCloseTo(first!.frequency, 3);
  });
});

describe('note naming', () => {
  it('names 440 Hz as A4', () => {
    const a4 = freqToNote(440);
    expect(a4.name).toBe('A');
    expect(a4.octave).toBe(4);
  });

  it('reports a flat note as negative cents', () => {
    const flat = freqToNote(440 * Math.pow(2, -20 / 1200));
    expect(flat.cents).toBeLessThan(-15);
    expect(flat.cents).toBeGreaterThan(-25);
  });

  it('snaps 80 Hz to the low E string', () => {
    expect(nearestString(80).string.label).toBe('E2');
  });
});
