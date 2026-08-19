import { describe, expect, it } from 'vitest';
import { decimate, Fft, hannWindow, lowPassTaps, peak, rms } from '../src/lib/dsp';
import { HopWindow } from '../src/lib/analyzer';
import { FRAME_SIZE, HOP_SIZE } from '../src/lib/thresholds';

const SR = 44100;

function sine(freq: number, samples: number, sampleRate = SR, amplitude = 1): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

describe('Fft', () => {
  it('rejects non-power-of-two sizes', () => {
    expect(() => new Fft(1000)).toThrow(/power of two/i);
  });

  it('puts a sine in the right bin', () => {
    const size = 4096;
    const fft = new Fft(size);
    const window = hannWindow(size);
    const out = new Float32Array(size / 2 + 1);

    // Choose a frequency that lands exactly on a bin centre.
    const bin = 100;
    const freq = (bin * SR) / size;
    fft.magnitudes(sine(freq, size), window, out);

    let peakBin = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[peakBin]) peakBin = i;
    expect(peakBin).toBe(bin);
  });

  it('scales so a full-scale sine reads about half (Hann coherent gain)', () => {
    const size = 4096;
    const fft = new Fft(size);
    const window = hannWindow(size);
    const out = new Float32Array(size / 2 + 1);
    fft.magnitudes(sine((100 * SR) / size, size, SR, 1), window, out);

    expect(out[100]).toBeGreaterThan(0.4);
    expect(out[100]).toBeLessThan(0.6);
  });

  it('is linear in amplitude, so chroma thresholds do not drift with playing volume', () => {
    const size = 2048;
    const fft = new Fft(size);
    const window = hannWindow(size);
    const loud = new Float32Array(size / 2 + 1);
    const quiet = new Float32Array(size / 2 + 1);
    const freq = (64 * SR) / size;

    fft.magnitudes(sine(freq, size, SR, 1.0), window, loud);
    fft.magnitudes(sine(freq, size, SR, 0.1), window, quiet);

    expect(loud[64] / quiet[64]).toBeCloseTo(10, 0);
  });

  it('separates two tones a few bins apart', () => {
    const size = 8192;
    const fft = new Fft(size);
    const window = hannWindow(size);
    const out = new Float32Array(size / 2 + 1);

    const a = new Float32Array(size);
    const lowFreq = (200 * SR) / size;
    const highFreq = (210 * SR) / size;
    const s1 = sine(lowFreq, size);
    const s2 = sine(highFreq, size);
    for (let i = 0; i < size; i++) a[i] = 0.5 * s1[i] + 0.5 * s2[i];

    fft.magnitudes(a, window, out);
    // Both peaks present, with a dip between them.
    expect(out[200]).toBeGreaterThan(out[205]);
    expect(out[210]).toBeGreaterThan(out[205]);
  });

  it('produces no energy for a silent input', () => {
    const size = 1024;
    const fft = new Fft(size);
    const out = new Float32Array(size / 2 + 1);
    fft.magnitudes(new Float32Array(size), hannWindow(size), out);
    expect(Math.max(...out)).toBe(0);
  });
});

describe('hannWindow', () => {
  it('starts at zero and peaks in the middle', () => {
    const w = hannWindow(1024);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[512]).toBeCloseTo(1, 6);
  });
});

describe('level metering', () => {
  it('computes rms of a sine as amplitude / sqrt(2)', () => {
    expect(rms(sine(440, 4410))).toBeCloseTo(1 / Math.SQRT2, 2);
  });

  it('computes peak', () => {
    expect(peak(sine(440, 4410, SR, 0.3))).toBeCloseTo(0.3, 2);
  });

  it('reports zero for silence', () => {
    expect(rms(new Float32Array(512))).toBe(0);
  });
});

describe('decimation', () => {
  const taps = lowPassTaps(4);

  it('has unity DC gain', () => {
    const sum = taps.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('preserves an in-band tone', () => {
    const input = sine(220, 8192);
    const out = new Float32Array(2048);
    const n = decimate(input, 4, taps, out);
    expect(n).toBe(2048);

    // Interior samples only — the zero-padded edges are attenuated by design.
    expect(rms(out.subarray(100, 1900))).toBeGreaterThan(0.5);
  });

  it('attenuates content above the new Nyquist, preventing aliasing', () => {
    // 8 kHz would fold to 3.025 kHz at the decimated rate of 11.025 kHz.
    const input = sine(8000, 8192);
    const out = new Float32Array(2048);
    decimate(input, 4, taps, out);
    expect(rms(out.subarray(100, 1900))).toBeLessThan(0.05);
  });

  it('does not read past the end of the input', () => {
    const out = new Float32Array(64);
    expect(() => decimate(new Float32Array(128), 4, taps, out)).not.toThrow();
  });
});

/**
 * Hop reassembly and drop handling.
 *
 * This is the plumbing between the capture worklet and the analyser. It used to
 * live inline in the Worker where nothing could reach it, which mattered because
 * its failure modes are silent: an off-by-one leaves the window permanently
 * part zero-padded, and a splice across dropped hops puts a discontinuity in the
 * middle of a frame that the FFT reads as broadband energy nobody played.
 */
describe('HopWindow', () => {
  const FRAME = 16;
  const HOP = 4;

  /** A hop whose samples are all `value`, so window contents are checkable. */
  const hop = (value: number) => new Float32Array(HOP).fill(value);

  it('rejects framing that cannot work', () => {
    expect(() => new HopWindow(4, 0)).toThrow(/framing/i);
    expect(() => new HopWindow(4, 8)).toThrow(/framing/i);
  });

  it('withholds a window until it is genuinely full', () => {
    const w = new HopWindow(FRAME, HOP);
    // Four hops of four samples fill a sixteen-sample frame; none before that
    // may be analysed, or the analyser sees zero-padding as quiet audio.
    expect(w.push(hop(1), 0)).toBeNull();
    expect(w.push(hop(2), 1)).toBeNull();
    expect(w.push(hop(3), 2)).toBeNull();
    expect(w.push(hop(4), 3)).toBeNull();
    expect(w.push(hop(5), 4)).not.toBeNull();
  });

  it('produces a contiguous window in arrival order', () => {
    const w = new HopWindow(FRAME, HOP);
    for (let i = 0; i < 4; i++) w.push(hop(i + 1), i);
    const frame = w.push(hop(5), 4)!;
    // Oldest hop first, newest at the end.
    expect(Array.from(frame)).toEqual([
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4, 4,
      5, 5, 5, 5,
    ]);
  });

  it('advances by exactly one hop per push', () => {
    const w = new HopWindow(FRAME, HOP);
    for (let i = 0; i < 5; i++) w.push(hop(i + 1), i);
    const frame = w.push(hop(6), 5)!;
    expect(Array.from(frame.subarray(FRAME - HOP))).toEqual([6, 6, 6, 6]);
    expect(Array.from(frame.subarray(0, HOP))).toEqual([3, 3, 3, 3]);
  });

  it('reuses one buffer rather than allocating per hop', () => {
    const w = new HopWindow(FRAME, HOP);
    for (let i = 0; i < 4; i++) w.push(hop(i), i);
    const a = w.push(hop(9), 4);
    const b = w.push(hop(9), 5);
    expect(a).toBe(b);
  });

  it('counts hops the sender dropped', () => {
    const w = new HopWindow(FRAME, HOP);
    w.push(hop(1), 0);
    expect(w.dropped).toBe(0);
    w.push(hop(2), 4); // 1, 2 and 3 never arrived
    expect(w.dropped).toBe(3);
    w.push(hop(3), 6); // 5 never arrived
    expect(w.dropped).toBe(4);
  });

  it('refuses to analyse across a gap, and refills first', () => {
    const w = new HopWindow(FRAME, HOP);
    for (let i = 0; i < 5; i++) w.push(hop(1), i);
    expect(w.push(hop(1), 5)).not.toBeNull(); // steady state

    // A dropped hop invalidates the window: the next pushes must go back to
    // returning null until a full frame of contiguous audio has arrived again.
    expect(w.push(hop(2), 8)).toBeNull();
    expect(w.push(hop(2), 9)).toBeNull();
    expect(w.push(hop(2), 10)).toBeNull();
    expect(w.push(hop(2), 11)).toBeNull();
    expect(w.push(hop(2), 12)).not.toBeNull();
  });

  it('never emits a window containing pre-gap audio', () => {
    const w = new HopWindow(FRAME, HOP);
    for (let i = 0; i < 6; i++) w.push(hop(7), i); // fill with 7s
    // Drop a hop, then push only 3s. Any 7 surviving into an emitted window
    // would be a splice: audio from before the gap glued to audio from after.
    let emitted: Float32Array | null = null;
    for (let i = 10; i < 20 && !emitted; i++) emitted = w.push(hop(3), i);
    expect(emitted).not.toBeNull();
    expect(Array.from(emitted!).every((v) => v === 3)).toBe(true);
  });

  it('forgets everything on reset', () => {
    const w = new HopWindow(FRAME, HOP);
    for (let i = 0; i < 6; i++) w.push(hop(1), i);
    w.reset();
    expect(w.dropped).toBe(0);
    // Sequence history is gone too, so restarting at 0 is not read as a gap.
    expect(w.push(hop(1), 0)).toBeNull();
    expect(w.dropped).toBe(0);
  });

  it('uses the real pipeline framing', () => {
    const w = new HopWindow(FRAME_SIZE, HOP_SIZE);
    expect(w.hopsPerFrame).toBe(4);
    for (let i = 0; i < w.hopsPerFrame; i++) {
      expect(w.push(new Float32Array(HOP_SIZE), i)).toBeNull();
    }
    expect(w.push(new Float32Array(HOP_SIZE), w.hopsPerFrame)).not.toBeNull();
  });
});
