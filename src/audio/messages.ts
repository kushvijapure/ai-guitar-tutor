/** Message contract between the main thread and the analysis Worker. */

import type { ChordDecision } from '../lib/chordDecision';
import type { ChordSpec } from '../lib/chroma';

export interface AnalysisStats {
  /** Hops received from the capture worklet. */
  received: number;
  /**
   * Hops the main thread refused to forward because the Worker was already
   * MAX_INFLIGHT_HOPS behind. Inferred from gaps in the sequence number, so it
   * is counted where the rest of the stats live rather than tracked separately.
   * Anything above zero in steady state means the analysis thread is not
   * keeping up.
   */
  dropped: number;
  /** Full frames actually analysed. */
  analysed: number;
  /**
   * Analyses whose wall-clock cost exceeded the hop period. Sustained
   * over-budget frames mean the analysis thread cannot keep up in real time.
   */
  overBudget: number;
  meanMs: number;
  worstMs: number;
}

export type ToWorker =
  | { type: 'init'; sampleRate: number; frameSize: number; hopSize: number }
  | { type: 'expected'; chord: ChordSpec }
  | { type: 'calibrate' }
  | { type: 'reset' }
  /**
   * One hop of audio. `samples.buffer` is transferred, so the sender must treat
   * the array as gone the instant postMessage returns.
   *
   * `seq` increases by one per hop the main thread forwards and never resets
   * except on init/reset. The Worker uses it two ways: to acknowledge progress
   * so the sender can measure how far behind it is, and to notice that hops
   * were skipped — a gap means its rolling window is no longer contiguous.
   */
  | { type: 'audio'; seq: number; samples: Float32Array; rms: number; time: number };

/**
 * Every 'audio' message is answered exactly once, with a 'decision' if the
 * frame was analysed or an 'ack' if it only filled the window. That one-for-one
 * guarantee is what lets the main thread compute outstanding work as
 * (last sent seq - last answered seq); if warm-up frames went unanswered the
 * count would never return to zero and the sender would drop everything.
 */
export type FromWorker =
  | {
      type: 'decision';
      seq: number;
      decision: ChordDecision;
      pitch: PitchReading | null;
      stats: AnalysisStats;
    }
  | { type: 'ack'; seq: number }
  | { type: 'error'; message: string };

export interface PitchReading {
  frequency: number;
  clarity: number;
}
