/**
 * Per-frame chord gates, with the emphasis on what must NOT pass.
 *
 * The prototype these tests were written against passed a C5 power chord and a
 * C major with the third muted as correct C majors. Most of what follows exists
 * to keep that from coming back.
 */

import { describe, expect, it } from 'vitest';
import { FrameAnalyzer } from '../src/lib/analyzer';
import {
  characteristicInterval,
  checkExpectedChord,
  isBenignRival,
  matchChord,
  missingTones,
  presentPitchClasses,
  type ChordSpec,
} from '../src/lib/chroma';
import { FRAME_SIZE, MIN_RUNNER_UP_MARGIN, MIN_TOP_SCORE } from '../src/lib/thresholds';
import { OPEN_CHORDS } from '../src/lessons/openChords';
import {
  addHum,
  addNote,
  addNoise,
  chord,
  DEFAULT_SAMPLE_RATE,
  scale,
  VOICINGS,
} from './signals';

const SR = DEFAULT_SAMPLE_RATE;
const analyzer = new FrameAnalyzer(FRAME_SIZE);

const C: ChordSpec = { root: 0, quality: 'major' };
const D: ChordSpec = { root: 2, quality: 'major' };
const E: ChordSpec = { root: 4, quality: 'major' };
const Em: ChordSpec = { root: 4, quality: 'minor' };
const G: ChordSpec = { root: 7, quality: 'major' };
const A: ChordSpec = { root: 9, quality: 'major' };
const Am: ChordSpec = { root: 9, quality: 'minor' };

function sig(midis: readonly number[], options: Record<string, unknown> = {}): Float32Array {
  return chord([...midis], FRAME_SIZE, SR, {
    amplitude: 0.25,
    harmonics: 8,
    rolloff: 1,
    ...options,
  });
}

function evaluate(signal: Float32Array, expected: ChordSpec, sampleRate = SR) {
  const observation = analyzer.analyze(signal, sampleRate, 0.0005);
  if (!observation.chroma) return null;
  return {
    chroma: observation.chroma,
    check: checkExpectedChord(observation.chroma, expected),
    top: matchChord(observation.chroma, 1)[0],
  };
}

function accepts(signal: Float32Array, expected: ChordSpec, sampleRate = SR): boolean {
  const result = evaluate(signal, expected, sampleRate);
  return !!result && result.check.passes && result.check.score >= MIN_TOP_SCORE;
}

describe('legitimate chords are accepted', () => {
  it.each(OPEN_CHORDS.map((c) => [c.name, c.id] as const))(
    'accepts a clean %s',
    (_name, id) => {
      const shape = OPEN_CHORDS.find((c) => c.id === id)!;
      const voicing = VOICINGS[id.toUpperCase() as keyof typeof VOICINGS] ??
        VOICINGS[(id === 'am' ? 'Am' : id === 'em' ? 'Em' : id.toUpperCase()) as keyof typeof VOICINGS];
      expect(accepts(sig(voicing), { root: shape.root, quality: shape.quality })).toBe(true);
    },
  );

  it('accepts a bright tone (harmonically rich, the harder case)', () => {
    expect(accepts(sig(VOICINGS.C, { rolloff: 0.7 }), C)).toBe(true);
  });

  it('accepts a dull tone', () => {
    expect(accepts(sig(VOICINGS.C, { rolloff: 1.4 }), C)).toBe(true);
  });

  it('is level-independent: the same chord played quietly still reads', () => {
    expect(accepts(scale(sig(VOICINGS.C), 0.05), C)).toBe(true);
  });
});

describe('single notes must not pass as chords', () => {
  it.each([
    ['low E2', 40, Em],
    ['A2', 45, Am],
    ['D3', 50, D],
    ['G3', 55, G],
    ['C3', 48, C],
    ['E4', 64, E],
  ])('rejects %s as a full chord', (_label, midi, expected) => {
    expect(accepts(sig([midi]), expected as ChordSpec)).toBe(false);
  });

  it('rejects a single note even though its harmonics spell a major triad', () => {
    // This is the core false positive: harmonic 3 is the fifth, harmonic 5 the
    // major third, so one string already looks like a major chord.
    const result = evaluate(sig([48]), C)!;
    expect(result.check.isTopMatch).toBe(true); // it really does look like C
    expect(result.check.hasCharacteristicTone).toBe(false); // but the third is only harmonics
    expect(result.check.pitchClassCount).toBeLessThan(3);
    expect(result.check.passes).toBe(false);
  });
});

describe('power chords must not pass as major or minor chords', () => {
  it('rejects C5 as C major', () => {
    expect(accepts(sig(VOICINGS.C5), C)).toBe(false);
  });

  it('rejects E5 as E minor', () => {
    expect(accepts(sig(VOICINGS.E5), Em)).toBe(false);
  });

  it('rejects C5 specifically because the third is absent', () => {
    const result = evaluate(sig(VOICINGS.C5), C)!;
    expect(result.check.hasCharacteristicTone).toBe(false);
    expect(result.check.pitchClassCount).toBe(2);
  });
});

describe('major/minor confusion', () => {
  it('does not accept A major when A minor was asked for', () => {
    expect(accepts(sig(VOICINGS.A), Am)).toBe(false);
  });

  it('does not accept A minor when A major was asked for', () => {
    expect(accepts(sig(VOICINGS.Am), A)).toBe(false);
  });

  it('does not accept E major when E minor was asked for', () => {
    expect(accepts(sig(VOICINGS.E), Em)).toBe(false);
  });

  it('still identifies each correctly on its own terms', () => {
    expect(accepts(sig(VOICINGS.A), A)).toBe(true);
    expect(accepts(sig(VOICINGS.Am), Am)).toBe(true);
  });
});

describe('suspended and altered chords', () => {
  it('does not accept Csus4 as C major', () => {
    expect(accepts(sig(VOICINGS.Csus4), C)).toBe(false);
  });

  it('does not accept a C with a stray F added', () => {
    expect(accepts(sig(VOICINGS.C_wrongNote), C)).toBe(false);
  });
});

describe('partially muted chords', () => {
  it('does not accept a C whose third is muted', () => {
    expect(accepts(sig(VOICINGS.C_noThird), C)).toBe(false);
  });

  it('identifies the muted third as the reason', () => {
    const result = evaluate(sig(VOICINGS.C_noThird), C)!;
    expect(result.check.hasCharacteristicTone).toBe(false);
  });

  it('does not accept a chord reduced to its root alone', () => {
    expect(accepts(sig([48, 60]), C)).toBe(false); // octaves only
  });
});

describe('noise, hum and non-musical input', () => {
  it('rejects broadband noise', () => {
    expect(accepts(addNoise(new Float32Array(FRAME_SIZE), 0.05), C)).toBe(false);
  });

  it('rejects broadband noise via the sparsity gate, not luck', () => {
    const result = evaluate(addNoise(new Float32Array(FRAME_SIZE), 0.05), C)!;
    // A flat spectrum lights up every pitch class; a chord never does.
    expect(result.check.pitchClassCount).toBeGreaterThan(6);
    expect(result.check.hasEnoughPitchClasses).toBe(false);
  });

  it('rejects mains hum on its own', () => {
    expect(accepts(addHum(new Float32Array(FRAME_SIZE), 0.05, SR), C)).toBe(false);
  });

  it('still accepts a real chord over hum', () => {
    expect(accepts(addHum(sig(VOICINGS.C), 0.03, SR), C)).toBe(true);
  });

  it('still accepts a real chord over noise', () => {
    expect(accepts(addNoise(sig(VOICINGS.C), 0.01), C)).toBe(true);
  });
});

describe('sample rate independence', () => {
  it.each([32000, 44100, 48000])('accepts C major at %i Hz', (rate) => {
    const signal = chord([...VOICINGS.C], FRAME_SIZE, rate, { amplitude: 0.25, harmonics: 8 });
    expect(accepts(signal, C, rate)).toBe(true);
  });

  it.each([32000, 44100, 48000])('rejects a C5 power chord at %i Hz', (rate) => {
    const signal = chord([...VOICINGS.C5], FRAME_SIZE, rate, { amplitude: 0.25, harmonics: 8 });
    expect(accepts(signal, C, rate)).toBe(false);
  });
});

describe('gate helpers', () => {
  it('identifies the characteristic interval of each quality', () => {
    expect(characteristicInterval('major')).toBe(4);
    expect(characteristicInterval('minor')).toBe(3);
    expect(characteristicInterval('sus4')).toBe(5);
    expect(characteristicInterval('dom7')).toBe(4);
    expect(characteristicInterval('min7')).toBe(3);
  });

  it('treats a same-root extension as a benign rival', () => {
    expect(isBenignRival(C, { name: 'C7', root: 0, quality: 'dom7', score: 0.9 })).toBe(true);
    expect(isBenignRival(Am, { name: 'Am7', root: 9, quality: 'min7', score: 0.9 })).toBe(true);
  });

  it('does not treat a quality change as benign', () => {
    expect(isBenignRival(C, { name: 'Cm', root: 0, quality: 'minor', score: 0.9 })).toBe(false);
    expect(isBenignRival(C, { name: 'Csus4', root: 0, quality: 'sus4', score: 0.9 })).toBe(false);
  });

  it('does not treat a different root as benign', () => {
    expect(isBenignRival(C, { name: 'G', root: 7, quality: 'major', score: 0.9 })).toBe(false);
  });

  it('counts sounding pitch classes', () => {
    const chroma = new Float32Array(12);
    chroma[0] = 1;
    chroma[4] = 0.8;
    chroma[7] = 0.5;
    chroma[2] = 0.1; // below threshold
    expect(presentPitchClasses(chroma)).toEqual([0, 4, 7]);
  });
});

describe('missing-tone advice is confidence-aware', () => {
  const chromaFor = (midis: readonly number[]) =>
    analyzer.analyze(sig(midis), SR, 0.0005).chroma!;

  it('names the missing third when the signal is strong', () => {
    const missing = missingTones(chromaFor(VOICINGS.C_noThird), C, 30);
    expect(missing).toContain('E');
  });

  it('reports nothing missing for a complete chord', () => {
    expect(missingTones(chromaFor(VOICINGS.C), C, 30)).toEqual([]);
  });

  it('refuses to name a missing note when SNR is too low', () => {
    expect(missingTones(chromaFor(VOICINGS.C_noThird), C, 2)).toBeNull();
  });

  it('refuses to name anything when literally every tone is absent', () => {
    // D major against C: no C, E or G sounding at all. Listing all three is
    // noise, not advice — we are simply not hearing a C.
    expect(missingTones(chromaFor(VOICINGS.D), C, 30)).toBeNull();
  });

  it('answers only what it was asked, leaving relevance to the caller', () => {
    // A G chord contains a G, so judged against C only C and E are absent.
    // That is a correct answer to a question that should not have been asked;
    // ChordDecider is what decides not to ask it (see chordDecision.test.ts).
    expect(missingTones(chromaFor(VOICINGS.G), C, 30)).toEqual(['C', 'E']);
  });

  it('returns null rather than guessing on a non-finite SNR', () => {
    expect(missingTones(chromaFor(VOICINGS.C), C, -Infinity)).toBeNull();
  });
});

describe('the top-match gate means top-1, not "somewhere in the top 3"', () => {
  /**
   * An earlier implementation accepted the expected chord if it appeared
   * anywhere in the top few matches, which is nearly free to satisfy: the
   * templates for a root and its relative minor, its sevenths and its sus
   * variants all sit within a few percent of each other, so the correct answer
   * is almost always in the top 3 no matter what was played.
   */
  /** 1-based rank of the expected chord among all 60 templates. */
  const rankOf = (signal: Float32Array, expected: ChordSpec) =>
    matchChord(analyzer.analyze(signal, SR, 0.0005).chroma!, 60).findIndex(
      (m) => m.root === expected.root && m.quality === expected.quality,
    ) + 1;

  it('rejects the expected chord when it is the runner-up rather than the best', () => {
    // Measured: a Csus4 read against C puts C second at 0.770 behind Csus4 at
    // 0.954. This is the case a top-3 test would wave through, and the one a
    // beginner actually produces — the index finger lands on the wrong fret.
    const signal = sig(VOICINGS.Csus4);
    expect(rankOf(signal, C)).toBe(2);
    expect(evaluate(signal, C)!.check.isTopMatch).toBe(false);
    expect(accepts(signal, C)).toBe(false);
  });

  it.each([
    ['A major played, Am wanted', VOICINGS.A, Am],
    ['Am played, A major wanted', VOICINGS.Am, A],
    ['E major played, Em wanted', VOICINGS.E, Em],
  ])('%s: ranks outside the top 3 and is rejected', (_label, voicing, expected) => {
    // These fall further than expected — rank 4 to 6 — because a major/minor
    // swap moves a whole pitch class. Asserted so that a regression which
    // merely blurs the templates together shows up here.
    const signal = sig(voicing);
    expect(rankOf(signal, expected as ChordSpec)).toBeGreaterThan(3);
    expect(evaluate(signal, expected as ChordSpec)!.check.isTopMatch).toBe(false);
    expect(accepts(signal, expected as ChordSpec)).toBe(false);
  });
});

describe('the runner-up margin gate', () => {
  it('rejects a stray F once it is as prominent as the chord tones', () => {
    // The realistic version of this error — F *replacing* the high E, i.e. a
    // finger on the wrong fret — is rejected outright (C_wrongNote, above).
    // This is the harder variant: a full, correct C with an extra F added on
    // top. Sweep the stray note's level rather than trusting one amplitude.
    //
    // KNOWN LIMITATION, measured, not fixed here. Below ~0.3 (chord tones at
    // 0.25) this is accepted as a clean C, and it is not separable from a
    // legitimate chord using anything the pipeline currently computes:
    //
    //   C + stray F @0.15   5 pitch classes, 2 foreign, score 0.901  (wrong)
    //   C bright rolloff .5 5 pitch classes, 2 foreign, score 0.896  (correct)
    //
    // The wrong one scores *higher*, so no threshold on score, pitch-class
    // count or foreign-tone count separates them; raising MIN_TOP_SCORE would
    // reject the legitimate bright chord first. Separating them needs a gate
    // the pipeline does not have — per-tone harmonic-leakage accounting, the
    // major-third test generalized to every sounding pitch class — and that
    // must be validated against real recordings before it goes in, not tuned
    // against these synthetic tones. Recorded here so the gap is visible.
    for (const strayAmplitude of [0.3, 0.4, 0.5]) {
      const signal = sig(VOICINGS.C);
      addNote(signal, 65, SR, { amplitude: strayAmplitude, harmonics: 8, rolloff: 1 });
      expect(accepts(signal, C)).toBe(false);
    }
  });

  it('rejects a wrong note that replaces a chord tone at every level', () => {
    // The beginner error that actually happens, and the one that must not slip:
    // the finger is on the wrong fret, so the F is there instead of the E.
    for (const amplitude of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) {
      expect(accepts(sig(VOICINGS.C_wrongNote, { amplitude }), C)).toBe(false);
    }
  });

  it('excludes same-root extensions, so a C7 reading does not fail a C', () => {
    const check = evaluate(sig(VOICINGS.C), C)!.check;
    // The nearest rival considered for the margin must not be a C7 or similar.
    expect(check.rival && isBenignRival(C, check.rival)).toBeFalsy();
    expect(check.margin).toBeGreaterThanOrEqual(MIN_RUNNER_UP_MARGIN);
  });

  it('reports the strongest non-benign rival, not merely the second entry', () => {
    const check = evaluate(sig(VOICINGS.C), C)!.check;
    const all = matchChord(analyzer.analyze(sig(VOICINGS.C), SR, 0.0005).chroma!, 60);
    const strongestNonBenign = all.find(
      (m) => !(m.root === C.root && m.quality === C.quality) && !isBenignRival(C, m),
    )!;
    expect(check.rival?.name).toBe(strongestNonBenign.name);
  });
});

describe('the characteristic-tone gate covers every quality-defining tone', () => {
  it('requires the seventh of a dom7, not only its third', () => {
    // characteristicInterval() returns the third for dom7, so checking only
    // that interval let a plain major triad satisfy the quality gate of the
    // corresponding seventh chord. Nothing in the lesson uses sevenths yet;
    // this keeps the hole closed before one does.
    const triad = evaluate(sig(VOICINGS.C), { root: 0, quality: 'dom7' })!;
    expect(triad.check.hasCharacteristicTone).toBe(false);
    expect(triad.check.passes).toBe(false);
  });

  it('requires the seventh of a min7 too', () => {
    const triad = evaluate(sig(VOICINGS.Am), { root: 9, quality: 'min7' })!;
    expect(triad.check.hasCharacteristicTone).toBe(false);
  });

  it('accepts a real seventh chord that actually contains its seventh', () => {
    // C7: C E G Bb.
    const real = evaluate(sig([48, 52, 55, 58, 64]), { root: 0, quality: 'dom7' })!;
    expect(real.check.hasCharacteristicTone).toBe(true);
  });

  it('is unchanged for the triads the lesson actually teaches', () => {
    for (const shape of OPEN_CHORDS) {
      const voicing = VOICINGS[shape.id.toUpperCase() as keyof typeof VOICINGS] ??
        VOICINGS[(shape.id === 'am' ? 'Am' : shape.id === 'em' ? 'Em' : shape.id.toUpperCase()) as keyof typeof VOICINGS];
      const result = evaluate(sig(voicing), { root: shape.root, quality: shape.quality })!;
      expect(result.check.hasCharacteristicTone).toBe(true);
    }
  });
});

describe('a major third must beat the root\'s own fifth harmonic', () => {
  it('rejects a bare root whose harmonics alone put energy at the third', () => {
    // Sweep harmonic richness: a brighter tone puts more energy at harmonic 5,
    // which is the pitch class of the major third. None of these is a chord.
    for (const rolloff of [0.5, 0.7, 1.0, 1.3]) {
      const result = evaluate(sig([48], { rolloff }), C)!;
      expect(result.check.hasCharacteristicTone).toBe(false);
      expect(accepts(sig([48], { rolloff }), C)).toBe(false);
    }
  });

  it('rejects a power chord however bright the tone', () => {
    for (const rolloff of [0.5, 0.7, 1.0, 1.3]) {
      expect(accepts(sig(VOICINGS.C5, { rolloff }), C)).toBe(false);
    }
  });

  it('gives the minor third no harmonic discount, since it is not in the series', () => {
    // Em contains a G at 3 semitones above E; harmonic 5 of E is G#, not G, so
    // any energy at the minor third was genuinely fretted.
    expect(evaluate(sig(VOICINGS.Em), Em)!.check.hasCharacteristicTone).toBe(true);
    // ...and a bare E must still fail it.
    expect(evaluate(sig([40]), Em)!.check.hasCharacteristicTone).toBe(false);
  });
});
