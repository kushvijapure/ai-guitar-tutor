import { describe, expect, it } from 'vitest';
import { decimate, Fft, hannWindow, lowPassTaps, peak, rms } from '../src/lib/dsp';

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
