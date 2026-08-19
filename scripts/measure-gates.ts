/**
 * Prints the chord-decision gates for every scenario, so the thresholds in
 * src/lib/thresholds.ts can be set from measurements instead of taste.
 *
 * Run with: npm run measure
 *
 * This is a diagnostic, not a test — it asserts nothing and always exits 0.
 * The assertions live in tests/. Use this when changing a threshold, to see how
 * much headroom the change leaves on both sides.
 *
 * IMPORTANT: every signal here is synthetic. The scores below say how the
 * algorithm behaves on an idealized harmonic series, not how it behaves on a
 * real guitar through a real microphone in a real room. See README, "Real-world
 * evaluation", for how to check that.
 */

import { FrameAnalyzer } from '../src/lib/analyzer.ts';
import { checkExpectedChord, matchChord, type ChordSpec } from '../src/lib/chroma.ts';
import {
  FRAME_SIZE,
  MIN_RUNNER_UP_MARGIN,
  MIN_TOP_SCORE,
} from '../src/lib/thresholds.ts';
import { addHum, addNoise, addNote, chord, scale, VOICINGS } from '../tests/signals.ts';

const SR = 44100;
const analyzer = new FrameAnalyzer(FRAME_SIZE);

const C: ChordSpec = { root: 0, quality: 'major' };
const A: ChordSpec = { root: 9, quality: 'major' };
const Am: ChordSpec = { root: 9, quality: 'minor' };
const Em: ChordSpec = { root: 4, quality: 'minor' };
const G: ChordSpec = { root: 7, quality: 'major' };
const D: ChordSpec = { root: 2, quality: 'major' };

interface Scenario {
  label: string;
  expected: ChordSpec;
  signal: Float32Array;
  /** What the gates are supposed to do. */
  want: 'pass' | 'reject';
  /**
   * Set when the gates are already known NOT to do that, with the reason. A
   * documented gap is not the same as a regression, and the two must not look
   * alike in this output.
   */
  known?: string;
}

function sig(midis: readonly number[], options: Record<string, unknown> = {}): Float32Array {
  return chord([...midis], FRAME_SIZE, SR, {
    amplitude: 0.25,
    harmonics: 8,
    rolloff: 1,
    ...options,
  });
}

/** A correct C with an extra F added on top, at the given level. */
function strayF(amplitude: number): Float32Array {
  const signal = sig(VOICINGS.C);
  addNote(signal, 65, SR, { amplitude, harmonics: 8, rolloff: 1 });
  return signal;
}

const SCENARIOS: Scenario[] = [
  { label: 'C major (clean)', expected: C, signal: sig(VOICINGS.C), want: 'pass' },
  { label: 'Am (clean)', expected: Am, signal: sig(VOICINGS.Am), want: 'pass' },
  { label: 'Em (clean)', expected: Em, signal: sig(VOICINGS.Em), want: 'pass' },
  { label: 'G (clean)', expected: G, signal: sig(VOICINGS.G), want: 'pass' },
  { label: 'D (clean)', expected: D, signal: sig(VOICINGS.D), want: 'pass' },
  { label: 'A major (clean)', expected: A, signal: sig(VOICINGS.A), want: 'pass' },
  { label: 'C bright (rolloff .7)', expected: C, signal: sig(VOICINGS.C, { rolloff: 0.7 }), want: 'pass' },
  { label: 'C dull (rolloff 1.4)', expected: C, signal: sig(VOICINGS.C, { rolloff: 1.4 }), want: 'pass' },
  { label: 'C + noise', expected: C, signal: addNoise(sig(VOICINGS.C), 0.01), want: 'pass' },
  { label: 'C + 60Hz hum', expected: C, signal: addHum(sig(VOICINGS.C), 0.03, SR), want: 'pass' },
  { label: 'C quiet (x0.1)', expected: C, signal: scale(sig(VOICINGS.C), 0.1), want: 'pass' },

  { label: 'C5 power chord', expected: C, signal: sig(VOICINGS.C5), want: 'reject' },
  { label: 'E5 power chord', expected: Em, signal: sig(VOICINGS.E5), want: 'reject' },
  { label: 'single C3', expected: C, signal: sig([48]), want: 'reject' },
  { label: 'single E2', expected: Em, signal: sig([40]), want: 'reject' },
  { label: 'C, third muted', expected: C, signal: sig(VOICINGS.C_noThird), want: 'reject' },
  { label: 'Csus4 played', expected: C, signal: sig(VOICINGS.Csus4), want: 'reject' },
  { label: 'A major, Am wanted', expected: Am, signal: sig(VOICINGS.A), want: 'reject' },
  { label: 'Am, A major wanted', expected: A, signal: sig(VOICINGS.Am), want: 'reject' },
  { label: 'E major, Em wanted', expected: Em, signal: sig(VOICINGS.E), want: 'reject' },
  { label: 'C + stray F', expected: C, signal: sig(VOICINGS.C_wrongNote), want: 'reject' },
  { label: 'G played, C wanted', expected: C, signal: sig(VOICINGS.G), want: 'reject' },
  { label: 'broadband noise', expected: C, signal: addNoise(new Float32Array(FRAME_SIZE), 0.05), want: 'reject' },
  { label: 'C + ringing Bb', expected: C, signal: sig(VOICINGS.C_ringingSeventh), want: 'reject' },

  // The added-wrong-note boundary, and the legitimate case it collides with.
  // These two sit on opposite sides of what the gates are meant to decide and
  // yet the wrong one scores higher, which is why MIN_TOP_SCORE is not the tool
  // for this job. Kept visible so a future threshold change has to confront it.
  {
    label: 'C + added F @.15',
    expected: C,
    signal: strayF(0.15),
    want: 'reject',
    known: 'scores 0.901, above the legitimate bright C at 0.896 — not separable by score',
  },
  { label: 'C + added F @.30', expected: C, signal: strayF(0.3), want: 'reject' },
  { label: 'C bright (rolloff .5)', expected: C, signal: sig(VOICINGS.C, { rolloff: 0.5 }), want: 'pass' },
];

const header = [
  'scenario'.padEnd(22),
  'want'.padEnd(6),
  'score',
  'top',
  'margin'.padEnd(7),
  '#pc',
  '3rd',
  'result',
  'best match',
];
console.log(`\nMIN_TOP_SCORE=${MIN_TOP_SCORE}  MIN_RUNNER_UP_MARGIN=${MIN_RUNNER_UP_MARGIN}\n`);
console.log(header.join('  '));
console.log('-'.repeat(96));

let surprises = 0;

for (const s of SCENARIOS) {
  const observation = analyzer.analyze(s.signal, SR, 0.001);
  if (!observation.chroma) {
    console.log(`${s.label.padEnd(22)}  ${s.want.padEnd(6)}  (no chroma — rejected)`);
    if (s.want === 'pass') surprises++;
    continue;
  }

  const check = checkExpectedChord(observation.chroma, s.expected);
  const best = matchChord(observation.chroma, 1)[0];
  const passes = check.passes && check.score >= MIN_TOP_SCORE;
  const asExpected = passes === (s.want === 'pass');
  if (!asExpected && !s.known) surprises++;

  console.log(
    [
      s.label.padEnd(22),
      s.want.padEnd(6),
      check.score.toFixed(3),
      (check.isTopMatch ? ' Y ' : ' n '),
      (check.margin === Infinity ? 'inf' : check.margin.toFixed(3)).padEnd(7),
      String(check.pitchClassCount).padEnd(3),
      check.hasCharacteristicTone ? ' Y ' : ' n ',
      (passes ? 'PASS' : 'rej ') +
        (asExpected ? '' : s.known ? '  <-- KNOWN GAP' : '  <-- UNEXPECTED'),
      best ? `${best.name}:${best.score.toFixed(3)}` : '-',
    ].join('  '),
  );
}

// Headroom summary: how close the tightest legitimate case is to the gates.
const passing = SCENARIOS.filter((s) => s.want === 'pass').map((s) => {
  const observation = analyzer.analyze(s.signal, SR, 0.001);
  return observation.chroma ? checkExpectedChord(observation.chroma, s.expected) : null;
});
const scores = passing.flatMap((c) => (c ? [c.score] : []));
const margins = passing.flatMap((c) => (c && Number.isFinite(c.margin) ? [c.margin] : []));

console.log('\nHeadroom on legitimate chords (want=pass):');
console.log(`  lowest score  ${Math.min(...scores).toFixed(3)}  vs MIN_TOP_SCORE ${MIN_TOP_SCORE}`);
console.log(`  lowest margin ${Math.min(...margins).toFixed(3)}  vs MIN_RUNNER_UP_MARGIN ${MIN_RUNNER_UP_MARGIN}`);
const known = SCENARIOS.filter((s) => s.known);
if (known.length > 0) {
  console.log('\nKnown gaps (documented, not regressions):');
  for (const s of known) console.log(`  ${s.label}: ${s.known}`);
}
console.log(
  surprises === 0
    ? '\nAll scenarios behaved as intended, known gaps aside.\n'
    : `\n${surprises} scenario(s) did not.\n`,
);
