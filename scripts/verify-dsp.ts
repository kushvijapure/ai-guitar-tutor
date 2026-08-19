/**
 * End-to-end smoke check of the audio DSP against synthetic signals.
 * Run with: npm run verify
 *
 * This complements `npm test` rather than duplicating it. The vitest suite
 * asserts behaviour in detail; this drives the whole pipeline the way the
 * browser does — time-domain samples in, coaching decision out — and prints a
 * human-readable trace, so a failure here points at the pipeline rather than at
 * one unit.
 *
 * WHAT THIS DOES NOT PROVE: any of it working on a real guitar. Every signal
 * below is synthesized from an idealized harmonic series. It has no pickup
 * hum, no fret buzz, no body resonance, no room, no inharmonicity, and a noise
 * profile that a real microphone does not have. Passing here means the maths is
 * wired up correctly and the known false positives are rejected. It does not
 * mean the app is accurate. See README, "Real-world evaluation".
 */

import { FrameAnalyzer } from '../src/lib/analyzer.ts';
import { ChordDecider, type ChordStatus } from '../src/lib/chordDecision.ts';
import type { ChordSpec } from '../src/lib/chroma.ts';
import { midiToFreq, freqToNote, nearestString } from '../src/lib/notes.ts';
import { PitchDetector } from '../src/lib/pitch.ts';
import { FRAME_SIZE, HOP_SIZE } from '../src/lib/thresholds.ts';
import { chord, concat, frames, silence, strum, VOICINGS } from '../tests/signals.ts';

const SR = 44100;
const HOP_MS = (HOP_SIZE / SR) * 1000;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------

console.log('\nPitch detection (YIN on decimated audio)');
{
  const detector = new PitchDetector(FRAME_SIZE);
  for (const [name, midi] of [
    ['E2 low string', 40],
    ['A2', 45],
    ['A4 reference', 69],
    ['E4 high string', 64],
  ] as const) {
    const expected = midiToFreq(midi);
    const buffer = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < buffer.length; i++) {
      const t = i / SR;
      buffer[i] =
        0.6 * Math.sin(2 * Math.PI * expected * t) +
        0.25 * Math.sin(2 * Math.PI * expected * 2 * t) +
        0.1 * Math.sin(2 * Math.PI * expected * 3 * t);
    }
    const result = detector.detect(buffer, SR);
    const cents = result ? Math.abs(1200 * Math.log2(result.frequency / expected)) : Infinity;
    check(
      `${name} @ ${expected.toFixed(1)} Hz`,
      cents < 10,
      result ? `${result.frequency.toFixed(1)} Hz, ${cents.toFixed(1)} cents off` : 'no detection',
    );
  }

  check('silence returns null', detector.detect(silence(FRAME_SIZE), SR) === null);
}

console.log('\nNote naming');
{
  const a4 = freqToNote(440);
  check('440 Hz is A4', a4.name === 'A' && a4.octave === 4, `${a4.name}${a4.octave}`);
  const flat = freqToNote(440 * Math.pow(2, -20 / 1200));
  check('20 cents flat reads negative', flat.cents < -15 && flat.cents > -25, `${flat.cents} cents`);
  const nearE = nearestString(80);
  check('80 Hz snaps to low E', nearE.string.label === 'E2', nearE.string.label);
}

// ---------------------------------------------------------------------------

/** Drive a signal through the full pipeline and collect the states it visits. */
function play(signal: Float32Array, expected: ChordSpec): ChordStatus[] {
  const analyzer = new FrameAnalyzer(FRAME_SIZE);
  const decider = new ChordDecider();
  const seen: ChordStatus[] = [];

  frames(signal, FRAME_SIZE, HOP_SIZE).forEach((frame, i) => {
    const observation = analyzer.analyze(frame, SR, decider.signalGate());
    seen.push(
      decider.update(
        { chroma: observation.chroma, rms: observation.rms, now: i * HOP_MS },
        expected,
      ).status,
    );
  });

  return seen;
}

const sustained = (midis: readonly number[]) =>
  chord([...midis], FRAME_SIZE * 8, SR, { amplitude: 0.25, harmonics: 8 });

const CHORDS: Array<[string, readonly number[], ChordSpec]> = [
  ['C major', VOICINGS.C, { root: 0, quality: 'major' }],
  ['A minor', VOICINGS.Am, { root: 9, quality: 'minor' }],
  ['E minor', VOICINGS.Em, { root: 4, quality: 'minor' }],
  ['G major', VOICINGS.G, { root: 7, quality: 'major' }],
  ['D major', VOICINGS.D, { root: 2, quality: 'major' }],
];

console.log('\nChord recognition — the lesson chords must be accepted');
for (const [label, voicing, spec] of CHORDS) {
  const states = play(sustained(voicing), spec);
  check(`${label} is confirmed`, states.includes('confirmed'), states.at(-1));
}

console.log('\nFalse positives — these must NOT be accepted');
{
  const C: ChordSpec = { root: 0, quality: 'major' };
  const Em: ChordSpec = { root: 4, quality: 'minor' };
  const Am: ChordSpec = { root: 9, quality: 'minor' };

  const cases: Array<[string, Float32Array, ChordSpec]> = [
    ['C5 power chord as C major', sustained(VOICINGS.C5), C],
    ['E5 power chord as E minor', sustained(VOICINGS.E5), Em],
    ['single C3 as C major', sustained([48]), C],
    ['C with the third muted', sustained(VOICINGS.C_noThird), C],
    ['Csus4 as C major', sustained(VOICINGS.Csus4), C],
    ['A major as A minor', sustained(VOICINGS.A), Am],
    ['C with a stray F', sustained(VOICINGS.C_wrongNote), C],
    ['G major as C major', sustained(VOICINGS.G), C],
  ];

  for (const [label, signal, spec] of cases) {
    const states = play(signal, spec);
    check(`${label} is rejected`, !states.includes('confirmed'), `ended ${states.at(-1)}`);
  }
}

console.log('\nSilence must clear previous evidence');
{
  const C: ChordSpec = { root: 0, quality: 'major' };

  const trailing = play(concat(sustained(VOICINGS.C), silence(FRAME_SIZE * 4)), C);
  check('a confirmed chord does not survive silence', trailing.at(-1) === 'silent', trailing.at(-1));

  // C, then silence, then G — judged throughout as if C were still wanted.
  // The G must never be accepted as a C on the strength of the earlier chord.
  const contaminated = play(
    concat(sustained(VOICINGS.C), silence(FRAME_SIZE * 5), sustained(VOICINGS.G)),
    C,
  );
  const afterGap = contaminated.slice(-6);
  check(
    'a new chord is not contaminated by the previous one',
    !afterGap.includes('confirmed'),
    `tail: ${afterGap.join(' ')}`,
  );
}

console.log('\nStrum dynamics');
{
  const C: ChordSpec = { root: 0, quality: 'major' };
  const strummed = strum([...VOICINGS.C], FRAME_SIZE * 12, SR, {
    amplitude: 0.4,
    spreadSeconds: 0.02,
    decay: 4,
  });
  const states = play(strummed, C);
  check('a settled strum is confirmed', states.includes('confirmed'));
  check('the strum transient alone is not', states[0] !== 'confirmed', `first frame ${states[0]}`);
}

// ---------------------------------------------------------------------------

console.log(
  failures === 0
    ? '\nAll checks passed. (Synthetic signals only — this is not a real-world accuracy result.)\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
