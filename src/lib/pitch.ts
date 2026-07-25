/**
 * Monophonic pitch detection using the YIN algorithm.
 *
 * Used for the tuner and for single-note exercises. Chords need a different
 * approach entirely — autocorrelation locks onto one fundamental and will
 * happily report nonsense for a strummed triad. See chroma.ts for that.
 */

export interface PitchResult {
  /** Fundamental frequency in Hz. */
  frequency: number;
  /** 0..1 confidence. Below ~0.6 the reading is usually noise. */
  clarity: number;
}

/** Below this RMS we assume silence rather than reporting a phantom pitch. */
const SILENCE_RMS = 0.008;

/** YIN absolute threshold. Lower = stricter, more dropouts on quiet notes. */
const YIN_THRESHOLD = 0.15;

/**
 * @param buffer Time-domain samples from an AnalyserNode.
 * @param minFreq Low E on a guitar is ~82 Hz; 70 gives headroom for flat tunings.
 * @param maxFreq High E at the 12th fret is ~659 Hz; 1200 covers most of the neck.
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  minFreq = 70,
  maxFreq = 1200,
): PitchResult | null {
  const size = buffer.length;

  let rms = 0;
  for (let i = 0; i < size; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / size);
  if (rms < SILENCE_RMS) return null;

  const maxLag = Math.min(size - 1, Math.floor(sampleRate / minFreq));
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  if (maxLag <= minLag) return null;

  // Squared difference function.
  const diff = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < size; i++) {
      const d = buffer[i] - buffer[i + lag];
      sum += d * d;
    }
    diff[lag] = sum;
  }

  // Cumulative mean normalized difference — this is the step that stops YIN
  // from picking the octave below, which plain autocorrelation does constantly.
  const cmnd = new Float32Array(maxLag + 1);
  let running = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    running += diff[lag];
    cmnd[lag] = running === 0 ? 1 : (diff[lag] * (lag - minLag + 1)) / running;
  }

  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < YIN_THRESHOLD) {
      // Walk down into the local minimum rather than taking the first crossing.
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
      bestLag = lag;
      break;
    }
  }

  if (bestLag < 0) {
    // No dip cleared the threshold — fall back to the global minimum, but only
    // trust it if it's at least somewhat periodic.
    let min = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag] < min) {
        min = cmnd[lag];
        bestLag = lag;
      }
    }
    if (min > 0.4) return null;
  }

  // Parabolic interpolation around the minimum. Without this, pitch resolution
  // is quantized to integer lags, which at high frets is worth tens of cents.
  const prev = cmnd[bestLag - 1] ?? cmnd[bestLag];
  const next = cmnd[bestLag + 1] ?? cmnd[bestLag];
  const denom = 2 * (2 * cmnd[bestLag] - prev - next);
  const shift = denom !== 0 ? (next - prev) / denom : 0;
  const refinedLag = bestLag + shift;

  return {
    frequency: sampleRate / refinedLag,
    clarity: 1 - Math.min(1, Math.max(0, cmnd[bestLag])),
  };
}
