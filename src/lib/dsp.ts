/**
 * Signal-processing primitives: FFT, windowing, decimation, level metering.
 *
 * Why we own an FFT instead of using AnalyserNode.getFloatFrequencyData:
 *
 *  1. AnalyserNode only exists on the main thread. Analysis needs to run in a
 *     Worker so a slow frame cannot stall React.
 *  2. AnalyserNode applies its own smoothingTimeConstant and dB conversion,
 *     which means the numbers the chord matcher sees depend on browser
 *     internals we cannot reproduce in a test.
 *  3. Owning it makes the entire audio path a pure function from time-domain
 *     samples to a decision, so the tests can drive real synthesized waveforms
 *     through the exact code the browser runs, rather than a hand-built
 *     spectrum that only resembles one.
 *
 * Everything here preallocates. These run ~21x/second on the analysis thread
 * and must not produce garbage.
 */

/** In-place iterative radix-2 Cooley-Tukey FFT with precomputed tables. */
export class Fft {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);

    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    // Bit-reversal permutation, computed once.
    const bits = Math.log2(size);
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
  }

  /**
   * Magnitude spectrum of a real signal.
   *
   * @param input  Time-domain samples, length === size.
   * @param window Per-sample window coefficients, length === size.
   * @param out    Receives linear magnitudes for bins 0..size/2, length === size/2 + 1.
   */
  magnitudes(input: Float32Array, window: Float32Array, out: Float32Array): void {
    const { size, re, im, reverse, cosTable, sinTable } = this;

    // Load bit-reversed and windowed in one pass; imaginary part is zero.
    for (let i = 0; i < size; i++) {
      const src = reverse[i];
      re[i] = input[src] * window[src];
      im[i] = 0;
    }

    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let base = 0; base < size; base += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = cosTable[k];
          const wi = sinTable[k];
          const a = base + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }

    const bins = size / 2;
    // Scale so a full-scale sine reads ~1 regardless of FFT size. The 2/size
    // factor accounts for energy split across the mirrored negative frequencies.
    const scale = 2 / size;
    for (let i = 0; i <= bins; i++) {
      out[i] = Math.hypot(re[i], im[i]) * scale;
    }
  }
}

/** Periodic Hann window. Sidelobes at -31 dB, which is enough to keep a loud
 *  low string from smearing across the pitch classes either side of it. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}

export function rms(buffer: Float32Array, length = buffer.length): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / length);
}

export function peak(buffer: Float32Array, length = buffer.length): number {
  let max = 0;
  for (let i = 0; i < length; i++) {
    const v = buffer[i] < 0 ? -buffer[i] : buffer[i];
    if (v > max) max = v;
  }
  return max;
}

/**
 * Windowed-sinc low-pass taps for use before decimation.
 *
 * Cutoff is set to 80% of the post-decimation Nyquist, leaving a transition
 * band so the stopband is genuinely attenuated rather than just beginning to
 * roll off at the fold point. Without this filter, cymbal/fret noise above the
 * new Nyquist aliases down into the guitar's range and YIN locks onto it.
 */
export function lowPassTaps(factor: number, taps = 33): Float32Array {
  const h = new Float32Array(taps);
  const fc = (0.5 / factor) * 0.8; // cycles/sample
  const mid = (taps - 1) / 2;
  let sum = 0;

  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    // Hamming window on the sinc keeps the stopband ripple around -53 dB.
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }

  for (let i = 0; i < taps; i++) h[i] /= sum; // unity DC gain
  return h;
}

/**
 * Low-pass then keep every `factor`-th sample.
 *
 * The filter is only evaluated at output positions, so the cost is
 * (outputLength x taps) rather than (inputLength x taps).
 *
 * @returns Number of samples written to `out`.
 */
export function decimate(
  input: Float32Array,
  factor: number,
  taps: Float32Array,
  out: Float32Array,
): number {
  const half = (taps.length - 1) >> 1;
  const outLength = Math.min(out.length, Math.floor(input.length / factor));

  for (let o = 0; o < outLength; o++) {
    const centre = o * factor;
    let acc = 0;
    for (let t = 0; t < taps.length; t++) {
      const idx = centre + t - half;
      // Zero-pad at the edges. The first/last few output samples are therefore
      // slightly attenuated, which does not matter for periodicity detection.
      if (idx >= 0 && idx < input.length) acc += input[idx] * taps[t];
    }
    out[o] = acc;
  }

  return outLength;
}
