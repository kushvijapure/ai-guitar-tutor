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

/**
 * Reassembles hop-sized chunks into overlapping analysis windows.
 *
 * The capture worklet delivers one hop at a time; analysis needs a full
 * frameSize window that advances by one hop. This owns the single buffer that
 * slides along, so nothing is allocated per hop.
 *
 * It also owns what happens when hops go missing. The main thread drops hops
 * when the analysis thread falls behind (see MAX_INFLIGHT_HOPS), and a window
 * assembled across a gap is audio that was never played — a splice puts a
 * discontinuity in the middle of the frame, which the FFT reads as broadband
 * energy that was not there. Rather than analyse that, a gap throws the window
 * away and refills it from scratch. Under overload the coach therefore says
 * less; it does not say something invented.
 *
 * Lives here rather than in the Worker so it can be tested directly. The
 * buffer-management bugs this guards against (off-by-one windows, splices
 * treated as signal) are invisible from outside the Worker.
 */
export class HopWindow {
  readonly frameSize: number;
  readonly hopSize: number;
  /** Hops needed to fill the window from empty. */
  readonly hopsPerFrame: number;

  private readonly ring: Float32Array;
  private hopsBuffered = 0;
  private lastSeq = -1;
  private droppedHops = 0;

  constructor(frameSize: number, hopSize: number) {
    if (hopSize <= 0 || frameSize < hopSize) {
      throw new Error(`bad framing: frameSize ${frameSize}, hopSize ${hopSize}`);
    }
    this.frameSize = frameSize;
    this.hopSize = hopSize;
    this.hopsPerFrame = Math.ceil(frameSize / hopSize);
    this.ring = new Float32Array(frameSize);
  }

  /** Total hops known to have been dropped before reaching us. */
  get dropped(): number {
    return this.droppedHops;
  }

  /**
   * Add one hop.
   *
   * @param seq Monotonic hop counter from the sender. A jump means hops were
   *            dropped in between.
   * @returns The full window, ready to analyse, or null while it is still
   *          filling. The returned array is reused on every call — analyse it
   *          before pushing again, and never retain it.
   */
  push(samples: Float32Array, seq: number): Float32Array | null {
    if (this.lastSeq >= 0 && seq > this.lastSeq + 1) {
      this.droppedHops += seq - this.lastSeq - 1;
      this.hopsBuffered = 0;
      this.ring.fill(0);
    }
    this.lastSeq = seq;

    // Slide along by one hop. copyWithin is a memmove, far cheaper than
    // reallocating or rebuilding the frame each time.
    const count = Math.min(samples.length, this.hopSize);
    this.ring.copyWithin(0, count);
    this.ring.set(samples.subarray(0, count), this.frameSize - count);

    // Until the window is genuinely full it is part zero-padding, which reads
    // as a quiet ambiguous chord rather than as nothing.
    if (this.hopsBuffered < this.hopsPerFrame) {
      this.hopsBuffered++;
      return null;
    }
    return this.ring;
  }

  /** Forget all buffered audio and sequence history. */
  reset(): void {
    this.hopsBuffered = 0;
    this.lastSeq = -1;
    this.droppedHops = 0;
    this.ring.fill(0);
  }
}
