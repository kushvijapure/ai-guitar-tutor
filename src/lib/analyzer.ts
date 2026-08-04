/**
 * One analysis window in, one observation out.
 *
 * Everything is preallocated in the constructor: this runs ~21 times a second
 * on the analysis thread and must not generate garbage, because a GC pause here
 * shows up as the coach freezing mid-strum.
 *
 * Pure and synchronous by design — the Worker calls it, and so do the tests and
 * the benchmark, so all three exercise identical code.
 */

import { Fft, hannWindow, rms } from './dsp';
import { computeChroma, type Chroma } from './chroma';
import { PitchDetector, type PitchResult } from './pitch';
import { FRAME_SIZE, PITCH_DECIMATION } from './thresholds';

export interface FrameObservation {
  /** Normalized pitch-class profile, or null if the frame carried no usable energy. */
  chroma: Chroma | null;
  /** Monophonic pitch, or null when silent/unclear/polyphonic. */
  pitch: PitchResult | null;
  /** RMS of the frame. */
  rms: number;
  /** Wall-clock cost of this analysis, in milliseconds. */
  elapsedMs: number;
}

export class FrameAnalyzer {
  readonly frameSize: number;
  private readonly fft: Fft;
  private readonly window: Float32Array;
  private readonly magnitudes: Float32Array;
  private readonly chroma: Float32Array;
  private readonly pitchDetector: PitchDetector;

  /** Analyses since construction, and how long they took in total. */
  private analysed = 0;
  private totalMs = 0;
  private worstMs = 0;

  constructor(frameSize: number = FRAME_SIZE, pitchDecimation: number = PITCH_DECIMATION) {
    this.frameSize = frameSize;
    this.fft = new Fft(frameSize);
    this.window = hannWindow(frameSize);
    this.magnitudes = new Float32Array(frameSize / 2 + 1);
    this.chroma = new Float32Array(12);
    this.pitchDetector = new PitchDetector(frameSize, pitchDecimation);
  }

  /**
   * @param samples    Exactly frameSize time-domain samples.
   * @param sampleRate Rate those samples were captured at.
   * @param silenceRms Level below which we skip the expensive work entirely.
   */
  analyze(samples: Float32Array, sampleRate: number, silenceRms: number): FrameObservation {
    const started = now();
    const level = rms(samples);

    // Cheap exit. Below the floor there is nothing to find, and skipping the
    // FFT and YIN here is most of the reason idle CPU is near zero.
    if (level < silenceRms) {
      const elapsedMs = now() - started;
      this.record(elapsedMs);
      return { chroma: null, pitch: null, rms: level, elapsedMs };
    }

    this.fft.magnitudes(samples, this.window, this.magnitudes);
    const chroma = computeChroma(this.magnitudes, sampleRate, this.frameSize, this.chroma);
    const pitch = this.pitchDetector.detect(samples, sampleRate, undefined, undefined, silenceRms);

    const elapsedMs = now() - started;
    this.record(elapsedMs);
    return { chroma, pitch, rms: level, elapsedMs };
  }

  stats() {
    return {
      analysed: this.analysed,
      meanMs: this.analysed === 0 ? 0 : this.totalMs / this.analysed,
      worstMs: this.worstMs,
    };
  }

  resetStats(): void {
    this.analysed = 0;
    this.totalMs = 0;
    this.worstMs = 0;
  }

  private record(ms: number): void {
    this.analysed++;
    this.totalMs += ms;
    if (ms > this.worstMs) this.worstMs = ms;
  }
}

/** performance.now() where available, so this module works in Node and in workers. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
