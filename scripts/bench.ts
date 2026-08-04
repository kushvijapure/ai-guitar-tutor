/**
 * Reproducible benchmark for the audio analysis path.
 *
 * Run with: npm run bench
 *
 * Reports cost per analysis window and the real-time factor — how much faster
 * than real time the analysis runs. A factor of 1.0 means the machine can only
 * just keep up and any other load will cause dropped windows; the target is
 * comfortably above 10.
 *
 * Caveats worth stating: this runs in Node on one core with a warm JIT and no
 * competing work. The browser runs the same code in a Worker alongside
 * MediaPipe inference on the GPU and React on the main thread, so real headroom
 * is lower. Use this to catch regressions, not to predict field performance —
 * the in-app diagnostics panel (press D during a session) reports what actually
 * happened on the user's machine.
 */

import { FrameAnalyzer } from '../src/lib/analyzer.ts';
import { ChordDecider } from '../src/lib/chordDecision.ts';
import type { ChordSpec } from '../src/lib/chroma.ts';
import { FRAME_SIZE, HOP_SIZE } from '../src/lib/thresholds.ts';
import { chord, silence, VOICINGS } from '../tests/signals.ts';

const SAMPLE_RATES = [44100, 48000];
const ITERATIONS = 400;
const WARMUP = 50;

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function benchmark(label: string, frame: Float32Array, sampleRate: number, silenceRms: number) {
  const analyzer = new FrameAnalyzer(FRAME_SIZE);
  const decider = new ChordDecider();
  const expected: ChordSpec = { root: 0, quality: 'major' };

  for (let i = 0; i < WARMUP; i++) {
    const observation = analyzer.analyze(frame, sampleRate, silenceRms);
    decider.update({ chroma: observation.chroma, rms: observation.rms, now: i * 46 }, expected);
  }

  const timings: number[] = [];
  const started = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const observation = analyzer.analyze(frame, sampleRate, silenceRms);
    decider.update({ chroma: observation.chroma, rms: observation.rms, now: i * 46 }, expected);
    timings.push(performance.now() - t0);
  }
  const wall = performance.now() - started;

  timings.sort((a, b) => a - b);
  const mean = timings.reduce((a, b) => a + b, 0) / timings.length;

  // Each iteration advances the stream by one hop, so that is the audio
  // duration one analysis is responsible for keeping up with.
  const audioMsPerIteration = (HOP_SIZE / sampleRate) * 1000;
  const realTimeFactor = (ITERATIONS * audioMsPerIteration) / wall;

  console.log(
    [
      label.padEnd(26),
      `${sampleRate}`.padEnd(7),
      `${mean.toFixed(3)} ms`.padEnd(11),
      `${percentile(timings, 0.5).toFixed(3)} ms`.padEnd(11),
      `${percentile(timings, 0.95).toFixed(3)} ms`.padEnd(11),
      `${timings[timings.length - 1].toFixed(3)} ms`.padEnd(11),
      `${realTimeFactor.toFixed(1)}x`,
    ].join('  '),
  );

  return { mean, realTimeFactor };
}

console.log(`\nAudio analysis benchmark — frame ${FRAME_SIZE}, hop ${HOP_SIZE}, ${ITERATIONS} iterations`);
console.log(`node ${process.version} on ${process.platform}/${process.arch}\n`);
console.log(
  [
    'scenario'.padEnd(26),
    'rate'.padEnd(7),
    'mean'.padEnd(11),
    'p50'.padEnd(11),
    'p95'.padEnd(11),
    'max'.padEnd(11),
    'realtime',
  ].join('  '),
);
console.log('-'.repeat(100));

const results: Array<{ mean: number; realTimeFactor: number }> = [];

for (const rate of SAMPLE_RATES) {
  const strummed = chord([...VOICINGS.C], FRAME_SIZE, rate, { amplitude: 0.25, harmonics: 8 });
  results.push(benchmark('chord (full analysis)', strummed, rate, 0.004));
}

// The silence path is the common case between strums, and it matters that it is
// nearly free: that early exit is why idle CPU use stays near zero.
for (const rate of SAMPLE_RATES) {
  benchmark('silence (early exit)', silence(FRAME_SIZE), rate, 0.004);
}

const slowest = Math.min(...results.map((r) => r.realTimeFactor));
console.log(`\nWorst real-time factor on the full path: ${slowest.toFixed(1)}x`);
console.log(
  slowest < 5
    ? 'WARNING: less than 5x real time. The browser has far less headroom than this benchmark.\n'
    : 'Comfortable headroom for real-time analysis on this machine.\n',
);
