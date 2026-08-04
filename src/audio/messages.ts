/** Message contract between the main thread and the analysis Worker. */

import type { ChordDecision } from '../lib/chordDecision';
import type { ChordSpec } from '../lib/chroma';

export interface AnalysisStats {
  /** Hops received from the capture worklet. */
  received: number;
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
  | { type: 'audio'; samples: Float32Array; rms: number; time: number };

export type FromWorker =
  | { type: 'decision'; decision: ChordDecision; pitch: PitchReading | null; stats: AnalysisStats }
  | { type: 'error'; message: string };

export interface PitchReading {
  frequency: number;
  clarity: number;
}
