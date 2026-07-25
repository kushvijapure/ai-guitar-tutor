/**
 * Sanity checks for the audio DSP against synthetic signals.
 * Run with: npm run verify
 *
 * This is not a substitute for testing with a real guitar — it only proves the
 * maths is wired up correctly, not that it survives room noise and pickup hum.
 */

import { detectPitch } from '../src/lib/pitch.ts';
import { computeChroma, matchChord, missingTones } from '../src/lib/chroma.ts';
import { midiToFreq, freqToNote, nearestString } from '../src/lib/notes.ts';

const SAMPLE_RATE = 44100;
let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

/** Sine with a couple of harmonics, roughly like a plucked string. */
function tone(freq: number, samples: number): Float32Array {
  const buf = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    buf[i] =
      0.6 * Math.sin(2 * Math.PI * freq * t) +
      0.25 * Math.sin(2 * Math.PI * freq * 2 * t) +
      0.1 * Math.sin(2 * Math.PI * freq * 3 * t);
  }
  return buf;
}

console.log('\nPitch detection (YIN)');
for (const [name, midi] of [['E2 low string', 40], ['A2', 45], ['A4 reference', 69], ['E4 high string', 64]] as const) {
  const expected = midiToFreq(midi);
  const result = detectPitch(tone(expected, 4096), SAMPLE_RATE);
  const cents = result ? Math.abs(1200 * Math.log2(result.frequency / expected)) : Infinity;
  check(`${name} @ ${expected.toFixed(1)} Hz`, cents < 10, result ? `${result.frequency.toFixed(1)} Hz, ${cents.toFixed(1)} cents off` : 'no detection');
}

console.log('\nSilence rejection');
const quiet = new Float32Array(4096);
check('silence returns null', detectPitch(quiet, SAMPLE_RATE) === null);
const noise = new Float32Array(4096).map(() => (Math.random() - 0.5) * 0.002);
check('low-level noise returns null', detectPitch(noise, SAMPLE_RATE) === null);

console.log('\nNote naming');
const a4 = freqToNote(440);
check('440 Hz is A4', a4.name === 'A' && a4.octave === 4, `${a4.name}${a4.octave}`);
const flat = freqToNote(440 * Math.pow(2, -20 / 1200));
check('20 cents flat reads negative', flat.cents < -15 && flat.cents > -25, `${flat.cents} cents`);
const nearE = nearestString(80);
check('80 Hz snaps to low E', nearE.string.label === 'E2', `${nearE.string.label} ${nearE.cents} cents`);

/** Build a fake FFT magnitude spectrum (dBFS) with energy at the given notes. */
function spectrum(midiNotes: number[], bins = 4096): Float32Array {
  const data = new Float32Array(bins).fill(-120);
  const nyquist = SAMPLE_RATE / 2;
  for (const midi of midiNotes) {
    // Fundamental plus two harmonics, as a real string would produce.
    for (const [mult, db] of [[1, -12], [2, -22], [3, -30]] as const) {
      const freq = midiToFreq(midi) * mult;
      const bin = Math.round((freq / nyquist) * bins);
      if (bin < bins) data[bin] = Math.max(data[bin], db);
    }
  }
  return data;
}

console.log('\nChord recognition (chroma)');
const cases: Array<[string, number[], string]> = [
  ['C major (open)', [48, 52, 55, 60, 64], 'C'],
  ['A minor', [45, 52, 57, 60, 64], 'Am'],
  ['E minor', [40, 47, 52, 55, 59, 64], 'Em'],
  ['G major', [43, 47, 50, 55, 59, 67], 'G'],
  ['D major', [50, 57, 62, 66], 'D'],
];

for (const [label, notes, expected] of cases) {
  const chroma = computeChroma(spectrum(notes), SAMPLE_RATE);
  const matches = chroma ? matchChord(chroma, 3) : [];
  const top = matches[0];
  check(`${label} -> ${expected}`, top?.name === expected, top ? `got ${top.name} @ ${top.score.toFixed(3)}` : 'no match');
}

console.log('\nMissing-tone diagnosis');
// C major with the E (the third) left out — the classic "muted 4th string" error.
const noThird = computeChroma(spectrum([48, 55, 60]), SAMPLE_RATE);
const gaps = noThird ? missingTones(noThird, 0, 'major') : [];
check('C major without the third reports E missing', gaps.includes('E'), `missing: [${gaps.join(', ')}]`);

const complete = computeChroma(spectrum([48, 52, 55, 60]), SAMPLE_RATE);
const noGaps = complete ? missingTones(complete, 0, 'major') : ['?'];
check('complete C major reports nothing missing', noGaps.length === 0, `missing: [${noGaps.join(', ')}]`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
