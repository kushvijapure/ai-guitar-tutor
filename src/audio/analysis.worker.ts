/**
 * Analysis Worker: FFT, pitch detection, chord decision.
 *
 * Everything expensive lives here so that a slow frame delays a coaching update
 * rather than dropping an audio buffer or stalling React. The main thread only
 * ever sees a small plain object.
 *
 * The Worker also owns the ChordDecider, which means the decision state machine
 * — smoothing, silence decay, temporal stability, noise-floor calibration —
 * advances at the true analysis rate rather than at whatever rate React happens
 * to re-render. Throttling the UI therefore cannot weaken the gates.
 */

import { FrameAnalyzer, HopWindow } from '../lib/analyzer';
import { ChordDecider } from '../lib/chordDecision';
import type { ChordSpec } from '../lib/chroma';
import { FRAME_SIZE, HOP_SIZE } from '../lib/thresholds';
import type { AnalysisStats, FromWorker, ToWorker } from './messages';

let frameSize = FRAME_SIZE;
let hopSize = HOP_SIZE;
let sampleRate = 44100;

let analyzer = new FrameAnalyzer(frameSize);
let decider = new ChordDecider();
let expected: ChordSpec = { root: 0, quality: 'major' };

/** Rolling window of the most recent frameSize samples, and its drop handling. */
let hopWindow = new HopWindow(frameSize, hopSize);

const stats: AnalysisStats = {
  received: 0,
  dropped: 0,
  analysed: 0,
  overBudget: 0,
  meanMs: 0,
  worstMs: 0,
};

function post(message: FromWorker): void {
  (self as unknown as Worker).postMessage(message);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init':
        sampleRate = message.sampleRate;
        frameSize = message.frameSize;
        hopSize = message.hopSize;
        analyzer = new FrameAnalyzer(frameSize);
        decider = new ChordDecider();
        hopWindow = new HopWindow(frameSize, hopSize);
        resetStats();
        break;

      case 'expected':
        expected = message.chord;
        break;

      case 'calibrate':
        // No timestamp: the decider times the window against the frame clock,
        // which is the AudioContext's, not this thread's performance.now().
        decider.beginCalibration();
        break;

      case 'reset':
        decider.reset();
        hopWindow.reset();
        resetStats();
        break;

      case 'audio':
        handleAudio(message.samples, message.time, message.seq);
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

function handleAudio(samples: Float32Array, time: number, seq: number): void {
  stats.received++;

  // HopWindow owns reassembly and, critically, what happens when the main
  // thread has dropped hops to keep this thread from falling further behind:
  // a gap discards the window so nothing is ever analysed across a splice.
  const frame = hopWindow.push(samples, seq);
  stats.dropped = hopWindow.dropped;

  if (!frame) {
    // Still answer, so the sender's outstanding-work count stays exact.
    post({ type: 'ack', seq });
    return;
  }

  const observation = analyzer.analyze(frame, sampleRate, decider.signalGate());
  const decision = decider.update(
    { chroma: observation.chroma, rms: observation.rms, now: time },
    expected,
  );

  stats.analysed++;
  const budgetMs = (hopSize / sampleRate) * 1000;
  if (observation.elapsedMs > budgetMs) stats.overBudget++;

  const analyzerStats = analyzer.stats();
  stats.meanMs = analyzerStats.meanMs;
  stats.worstMs = analyzerStats.worstMs;

  post({
    type: 'decision',
    seq,
    decision,
    pitch: observation.pitch
      ? { frequency: observation.pitch.frequency, clarity: observation.pitch.clarity }
      : null,
    stats: { ...stats },
  });
}

function resetStats(): void {
  stats.received = 0;
  stats.dropped = 0;
  stats.analysed = 0;
  stats.overBudget = 0;
  stats.meanMs = 0;
  stats.worstMs = 0;
  analyzer.resetStats();
}
