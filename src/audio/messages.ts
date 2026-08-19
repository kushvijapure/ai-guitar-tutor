/** Message contract between the main thread and the analysis Worker. */

import type { ChordDecision } from '../lib/chordDecision';
import type { ChordSpec } from '../lib/chroma';

export interface AnalysisStats {
  /** Hops received from the capture worklet. */
  received: number;
  /**
   * Hops the main thread refused to forward because the Worker was already
   * MAX_INFLIGHT_HOPS behind. Anything above zero in steady state means the
   * analysis thread is not keeping up.
   *
   * The Worker fills this in from gaps in the sequence number, which is what it
   * can see. The main thread then OVERWRITES it with its own count before
   * publishing, because gaps cannot express a hop discarded before the first
   * forward or after the last — there is no later hop to carry the hole. The
   * two agree everywhere both can observe; see tests/backpressure.test.ts.
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
   * `seq` is a CAPTURE sequence number: it advances by one for every hop the
   * worklet delivers, INCLUDING hops the main thread discards under
   * backpressure, and never resets except on init/reset. So the numbers that
   * arrive here are contiguous in normal operation and contain a hole of
   * exactly the size of each discard otherwise, which is how the Worker learns
   * its rolling window is no longer contiguous.
   *
   * It is deliberately NOT the sender's measure of how far behind the Worker
   * is. That is a separate in-flight count on the sender, because this one now
   * contains deliberate holes and differencing it would count discarded hops as
   * outstanding work. See HopDispatcher.
   */
  | { type: 'audio'; seq: number; samples: Float32Array; rms: number; time: number };

/**
 * Every 'audio' message is answered exactly once, with a 'decision' if the
 * frame was analysed or an 'ack' if it only filled the window — including when
 * analysis threw, where an 'error' is followed by an 'ack' for the same seq.
 *
 * That one-for-one guarantee is what lets the main thread hold an in-flight
 * count that it increments on send and decrements on answer. If warm-up or
 * failed frames went unanswered the count would never return to zero and the
 * sender would end up discarding everything, permanently.
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
