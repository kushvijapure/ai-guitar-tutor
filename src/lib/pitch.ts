/**
 * Monophonic pitch detection using the YIN algorithm.
 *
 * Used for the tuner and single-note work. Chords need a different approach
 * entirely — autocorrelation locks onto one fundamental and will happily report
 * nonsense for a strummed triad. See chroma.ts for that.
 *
 * YIN is O(window x maxLag) and is the most expensive step in the pipeline, so
 * it runs on decimated audio: guitar fundamentals stop around 1.2 kHz, so
 * quarter-rate loses nothing we use and costs ~16x less.
 */

import { decimate, lowPassTaps, rms } from './dsp';
import { PITCH_DECIMATION, PITCH_MAX_HZ, PITCH_MIN_HZ, SILENCE_RMS_ABSOLUTE } from './thresholds';

export interface PitchResult {
  /** Fundamental frequency in Hz, at the original sample rate. */
  frequency: number;
  /** 0..1. Below ~0.6 the reading is usually noise. */
  clarity: number;
}

/** YIN absolute threshold. Lower = stricter, more dropouts on quiet notes. */
const YIN_THRESHOLD = 0.15;

/** If no dip clears the threshold, the global minimum must at least be this good. */
const YIN_FALLBACK_LIMIT = 0.4;

/**
 * Preallocated YIN detector. Construct once per analysis thread and reuse —
 * the difference and cumulative-mean buffers are the bulk of the allocation.
 */
export class PitchDetector {
  private readonly decimation: number;
  private readonly taps: Float32Array;
  private readonly decimated: Float32Array;
  private readonly diff: Float64Array;
  private readonly cmnd: Float64Array;

  constructor(frameSize: number, decimation: number = PITCH_DECIMATION) {
    this.decimation = decimation;
    this.taps = lowPassTaps(decimation);
    this.decimated = new Float32Array(Math.ceil(frameSize / decimation));

    // Worst case lag is set by the lowest frequency we look for.
    const maxLagBound = Math.ceil(48000 / decimation / PITCH_MIN_HZ) + 2;
    this.diff = new Float64Array(maxLagBound + 1);
    this.cmnd = new Float64Array(maxLagBound + 1);
  }

  detect(
    buffer: Float32Array,
    sampleRate: number,
    minFreq = PITCH_MIN_HZ,
    maxFreq = PITCH_MAX_HZ,
    silenceRms = SILENCE_RMS_ABSOLUTE,
  ): PitchResult | null {
    if (rms(buffer) < silenceRms) return null;

    const n = decimate(buffer, this.decimation, this.taps, this.decimated);
    const rate = sampleRate / this.decimation;
    const samples = this.decimated;

    const maxLag = Math.min(n - 1, Math.floor(rate / minFreq));
    const minLag = Math.max(2, Math.floor(rate / maxFreq));
    if (maxLag <= minLag || maxLag + 1 > this.diff.length) return null;

    const { diff, cmnd } = this;

    // Squared difference function.
    diff[0] = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      const limit = n - lag;
      for (let i = 0; i < limit; i++) {
        const d = samples[i] - samples[i + lag];
        sum += d * d;
      }
      diff[lag] = sum;
    }

    // Cumulative mean normalized difference. This is the step that stops YIN
    // from reporting the octave below, which plain autocorrelation does
    // constantly. Accumulated from lag 1 (not from minLag) so the normalisation
    // matches the published algorithm — starting the sum at minLag forces
    // cmnd[minLag] to 1 and biases the search away from high notes.
    cmnd[0] = 1;
    let running = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      running += diff[lag];
      cmnd[lag] = running === 0 ? 1 : (diff[lag] * lag) / running;
    }

    let bestLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag] < YIN_THRESHOLD) {
        // Walk into the local minimum rather than taking the first crossing.
        while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
        bestLag = lag;
        break;
      }
    }

    if (bestLag < 0) {
      let min = Infinity;
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (cmnd[lag] < min) {
          min = cmnd[lag];
          bestLag = lag;
        }
      }
      if (min > YIN_FALLBACK_LIMIT) return null;
    }

    // Parabolic interpolation around the minimum. Without this, resolution is
    // quantized to integer lags, which after decimation is worth tens of cents.
    const prev = bestLag > 0 ? cmnd[bestLag - 1] : cmnd[bestLag];
    const next = bestLag + 1 <= maxLag ? cmnd[bestLag + 1] : cmnd[bestLag];
    const denom = 2 * (2 * cmnd[bestLag] - prev - next);
    const shift = denom !== 0 ? (next - prev) / denom : 0;
    const refinedLag = bestLag + shift;
    if (refinedLag <= 0) return null;

    const frequency = rate / refinedLag;
    // Interpolation can push the estimate just outside the search band; a
    // reading we did not actually search for is not a reading we should report.
    if (frequency < minFreq * 0.95 || frequency > maxFreq * 1.05) return null;

    return {
      frequency,
      clarity: 1 - Math.min(1, Math.max(0, cmnd[bestLag])),
    };
  }
}

/** Convenience wrapper that allocates per call. For tests and one-off use. */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  minFreq = PITCH_MIN_HZ,
  maxFreq = PITCH_MAX_HZ,
): PitchResult | null {
  return new PitchDetector(buffer.length).detect(buffer, sampleRate, minFreq, maxFreq);
}
