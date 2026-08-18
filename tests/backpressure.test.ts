import { describe, expect, it, vi } from 'vitest';
import { HopDispatcher } from '../src/audio/backpressure';
import type { AnalysisStats, FromWorker, ToWorker } from '../src/audio/messages';
import { FRAME_SIZE, HOP_SIZE, MAX_INFLIGHT_HOPS } from '../src/lib/thresholds';

/**
 * The capture -> Worker backpressure protocol, driven end to end.
 *
 * This exercises the SHIPPING sender (HopDispatcher, the whole of useAudio's
 * hop handler) against the SHIPPING Worker (analysis.worker.ts, imported with a
 * stubbed `self`, so the real message handler, the real HopWindow, the real
 * FrameAnalyzer and the real ChordDecider all run). Nothing here reimplements
 * the protocol; the test only decides when the worklet delivers a hop, when the
 * Worker gets to run, and when its replies come back — which is exactly the
 * freedom a real browser has, and exactly what makes overload reproducible.
 *
 * The existing HopWindow tests in dsp.test.ts hand the window a gap directly.
 * That proves the window reacts to a gap; it cannot prove the sender ever
 * produces one. It did not: the overload check returned before the sequence
 * number advanced, so a discarded hop left the stream contiguous, the Worker
 * could not see the loss, and it spliced audio from opposite sides of the gap
 * into one analysis window while reporting zero drops. These tests fail against
 * that behaviour.
 */

/** Hops needed to fill one analysis window. */
const HOPS_PER_FRAME = FRAME_SIZE / HOP_SIZE;

/** Loud hop and quiet hop. A window is all of one or all of the other unless it was spliced. */
const LOUD = 0.5;
const QUIET = 0.02;

interface Analysed {
  seq: number;
  /** RMS of the window the Worker actually analysed. Exact for constant hops. */
  level: number;
  /** The Worker's own gap-derived drop count at that moment. */
  workerDropped: number;
}

/**
 * A capture worklet, a main thread and an analysis Worker, with the clock in
 * the test's hands.
 *
 * `offer` is one hop arriving from the worklet. `runWorker` is the Worker
 * getting CPU. `deliver` is its replies reaching the main thread. Holding the
 * last two back is how a slow Worker is simulated: messages sit in the
 * postMessage queue, the in-flight count stays high, and the sender starts
 * discarding — the real overload path, not a mocked one.
 */
class Pipeline {
  readonly dispatcher = new HopDispatcher(MAX_INFLIGHT_HOPS);
  /** Sent by the main thread, not yet processed by the Worker. */
  private readonly queue: ToWorker[] = [];
  /** Posted by the Worker, not yet processed by the main thread. */
  private readonly replies: FromWorker[] = [];
  private handle: (event: { data: ToWorker }) => void = () => {};
  private time = 0;

  /** Capture sequence numbers actually forwarded, in order. */
  readonly forwarded: number[] = [];
  /** Every window the Worker analysed. */
  readonly analysed: Analysed[] = [];
  readonly errors: string[] = [];
  /** The most recent stats the main thread would publish to React. */
  published: AnalysisStats | null = null;

  static async create(): Promise<Pipeline> {
    const pipeline = new Pipeline();
    // A fresh module instance per pipeline: the Worker holds its state in
    // module scope, exactly as it does in the browser, where each session gets
    // a new Worker.
    vi.resetModules();
    const stub = {
      onmessage: null as null | ((event: { data: ToWorker }) => void),
      postMessage: (message: FromWorker) => pipeline.replies.push(message),
    };
    vi.stubGlobal('self', stub);
    await import('../src/audio/analysis.worker');
    if (!stub.onmessage) throw new Error('the worker installed no message handler');
    pipeline.handle = stub.onmessage;

    pipeline.send({ type: 'init', sampleRate: 48000, frameSize: FRAME_SIZE, hopSize: HOP_SIZE });
    pipeline.runWorker();
    pipeline.deliver();
    return pipeline;
  }

  /** One hop from the capture worklet. Returns the seq forwarded, or null if discarded. */
  offer(value: number): number | null {
    this.time += (HOP_SIZE / 48000) * 1000;
    const seq = this.dispatcher.offer();
    if (seq === null) return null;
    const samples = new Float32Array(HOP_SIZE).fill(value);
    this.send({ type: 'audio', seq, samples, rms: Math.abs(value), time: this.time });
    this.forwarded.push(seq);
    return seq;
  }

  /** Give the Worker CPU for up to `count` queued messages. */
  runWorker(count = Number.POSITIVE_INFINITY): void {
    for (let i = 0; i < count && this.queue.length > 0; i++) {
      this.handle({ data: this.queue.shift()! });
    }
  }

  /** Let the main thread process everything the Worker has posted. */
  deliver(): void {
    for (const reply of this.replies.splice(0)) {
      // Mirrors useAudio's worker.onmessage exactly.
      if (reply.type === 'error') {
        this.errors.push(reply.message);
        continue;
      }
      this.dispatcher.answered(reply.seq);
      if (reply.type === 'ack') continue;
      this.analysed.push({
        seq: reply.seq,
        level: reply.decision.level,
        workerDropped: reply.stats.dropped,
      });
      this.published = { ...reply.stats, dropped: this.dispatcher.discarded };
    }
  }

  /** A Worker that is keeping up: one hop in, processed, answered. */
  flow(value: number, count = 1): void {
    for (let i = 0; i < count; i++) {
      this.offer(value);
      this.runWorker();
      this.deliver();
    }
  }

  send(message: ToWorker): void {
    this.queue.push(message);
  }

  /** Gaps in what the Worker actually received, as (missing count) per hole. */
  holes(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.forwarded.length; i++) {
      const missing = this.forwarded[i] - this.forwarded[i - 1] - 1;
      if (missing > 0) out.push(missing);
    }
    return out;
  }
}

describe('capture -> worker backpressure', () => {
  it('forwards every hop contiguously while the worker keeps up', async () => {
    const p = await Pipeline.create();
    p.flow(LOUD, 12);

    expect(p.forwarded).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(p.holes()).toEqual([]);
    expect(p.dispatcher.discarded).toBe(0);
    expect(p.dispatcher.outstanding).toBe(0);
    expect(p.errors).toEqual([]);

    // Nothing is analysed until a full window of real audio exists.
    expect(p.analysed.map((a) => a.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(p.analysed.every((a) => a.workerDropped === 0)).toBe(true);
    for (const a of p.analysed) expect(a.level).toBeCloseTo(LOUD, 4);
  });

  it('stops forwarding once the worker is MAX_INFLIGHT_HOPS behind, and stays bounded', async () => {
    const p = await Pipeline.create();
    // The worker never runs, so nothing is ever answered.
    for (let i = 0; i < 200; i++) {
      p.offer(LOUD);
      expect(p.dispatcher.outstanding).toBeLessThanOrEqual(MAX_INFLIGHT_HOPS);
    }

    expect(p.forwarded.length).toBe(MAX_INFLIGHT_HOPS);
    expect(p.dispatcher.outstanding).toBe(MAX_INFLIGHT_HOPS);
    expect(p.dispatcher.discarded).toBe(200 - MAX_INFLIGHT_HOPS);
    expect(p.dispatcher.captured).toBe(200);
  });

  it('leaves a real hole in the sequence when one capture hop is discarded', async () => {
    const p = await Pipeline.create();

    // Saturate: MAX_INFLIGHT_HOPS forwarded, none answered.
    for (let i = 0; i < MAX_INFLIGHT_HOPS; i++) p.offer(LOUD);
    const lastBefore = p.forwarded[p.forwarded.length - 1];

    // One hop arrives with no room for it. It must still consume a sequence number.
    expect(p.offer(LOUD)).toBeNull();
    expect(p.dispatcher.discarded).toBe(1);

    // The worker catches up by exactly one, freeing exactly one slot.
    p.runWorker(1);
    p.deliver();
    expect(p.dispatcher.outstanding).toBe(MAX_INFLIGHT_HOPS - 1);

    // THE defect: at bf2f3b2 this hop carried lastBefore + 1, so the worker
    // could not tell a hop had been thrown away.
    const next = p.offer(LOUD);
    expect(next).toBe(lastBefore + 2);
    expect(p.holes()).toEqual([1]);
  });

  it('leaves a hole of exactly the right size when several hops are discarded', async () => {
    const p = await Pipeline.create();
    for (let i = 0; i < MAX_INFLIGHT_HOPS; i++) p.offer(LOUD);
    const lastBefore = p.forwarded[p.forwarded.length - 1];

    for (let i = 0; i < 5; i++) expect(p.offer(LOUD)).toBeNull();

    p.runWorker();
    p.deliver();
    expect(p.dispatcher.outstanding).toBe(0);

    expect(p.offer(LOUD)).toBe(lastBefore + 6);
    expect(p.holes()).toEqual([5]);
    expect(p.dispatcher.discarded).toBe(5);
  });

  it('discards the window on the hole, refills, and never analyses spliced audio', async () => {
    const p = await Pipeline.create();

    // Steady state on loud audio, decisions flowing.
    p.flow(LOUD, HOPS_PER_FRAME + 4);
    expect(p.analysed.length).toBeGreaterThan(0);

    // The worker stalls. Fill its queue, then keep receiving hops with nowhere
    // to put them.
    for (let i = 0; i < MAX_INFLIGHT_HOPS; i++) p.offer(LOUD);
    const dropped = 5;
    for (let i = 0; i < dropped; i++) expect(p.offer(LOUD)).toBeNull();

    // The worker catches up on the loud hops it did receive.
    p.runWorker();
    p.deliver();
    const analysedBeforeGap = p.analysed.length;
    const lastLoudSeq = p.forwarded[p.forwarded.length - 1];

    // Audio resumes, at a clearly different level. Anything the worker emits
    // that mixes the two is a window assembled across the discarded hops.
    p.flow(QUIET, HOPS_PER_FRAME + 3);

    const afterGap = p.analysed.slice(analysedBeforeGap);
    expect(afterGap.length).toBeGreaterThan(0);

    // The hole is real, and the worker saw all of it.
    expect(p.holes()).toEqual([dropped]);
    expect(afterGap[0].workerDropped).toBe(dropped);

    // The window was thrown away and refilled: no decision for a full frame's
    // worth of hops after the gap. At bf2f3b2 the very first post-gap hop
    // produced a decision, because the window had never been invalidated.
    const firstPostGapSeq = lastLoudSeq + dropped + 1;
    expect(afterGap[0].seq).toBe(firstPostGapSeq + HOPS_PER_FRAME);

    // And the audio in it was all post-gap. A spliced window of k loud hops and
    // (HOPS_PER_FRAME - k) quiet ones lands strictly between the two levels.
    for (const a of afterGap) expect(a.level).toBeCloseTo(QUIET, 4);
    for (const a of p.analysed) {
      const clean = Math.abs(a.level - LOUD) < 1e-3 || Math.abs(a.level - QUIET) < 1e-3;
      expect(clean, `window at seq ${a.seq} had rms ${a.level}: spliced audio`).toBe(true);
    }
  });

  it('reports the true number of discarded hops', async () => {
    const p = await Pipeline.create();
    p.flow(LOUD, HOPS_PER_FRAME + 2);
    for (let i = 0; i < MAX_INFLIGHT_HOPS; i++) p.offer(LOUD);
    for (let i = 0; i < 9; i++) p.offer(LOUD);
    p.runWorker();
    p.deliver();
    p.flow(LOUD, HOPS_PER_FRAME + 2);

    // The sender counted them where the refusal happened...
    expect(p.dispatcher.discarded).toBe(9);
    // ...the worker independently inferred the same number from the hole...
    expect(p.analysed[p.analysed.length - 1].workerDropped).toBe(9);
    // ...and what reaches the diagnostics panel is the sender's count.
    expect(p.published?.dropped).toBe(9);
    expect(p.published?.received).toBeGreaterThan(0);
  });

  it('returns to contiguous forwarding once the worker recovers', async () => {
    const p = await Pipeline.create();
    for (let i = 0; i < MAX_INFLIGHT_HOPS + 4; i++) p.offer(LOUD);
    p.runWorker();
    p.deliver();
    expect(p.dispatcher.outstanding).toBe(0);

    const before = p.dispatcher.discarded;
    p.flow(LOUD, 20);
    // Not one further hop refused, and only the original hole in the stream.
    expect(p.dispatcher.discarded).toBe(before);
    expect(p.holes()).toEqual([4]);
    expect(p.dispatcher.outstanding).toBe(0);
  });

  it('resets every counter on restart', async () => {
    const p = await Pipeline.create();
    for (let i = 0; i < MAX_INFLIGHT_HOPS + 3; i++) p.offer(LOUD);
    expect(p.dispatcher.discarded).toBe(3);

    // Stopping a session tears the worker down and resets the sender; starting
    // again must not read the restarted sequence as an enormous gap.
    p.dispatcher.reset();
    expect(p.dispatcher.discarded).toBe(0);
    expect(p.dispatcher.outstanding).toBe(0);
    expect(p.dispatcher.captured).toBe(0);

    const fresh = await Pipeline.create();
    fresh.flow(LOUD, HOPS_PER_FRAME + 2);
    expect(fresh.forwarded[0]).toBe(0);
    expect(fresh.holes()).toEqual([]);
    expect(fresh.analysed[0].workerDropped).toBe(0);
  });

  it('releases the in-flight slot even when analysis throws', async () => {
    const p = await Pipeline.create();
    p.flow(LOUD, 2);

    // A fault inside the worker. 'error' carries no seq, so without an
    // accompanying ack this hop would stay outstanding forever and the sender
    // would eventually discard everything.
    const seq = p.dispatcher.offer()!;
    p.send({ type: 'audio', seq, samples: null, rms: 0, time: 0 } as unknown as ToWorker);
    expect(p.dispatcher.outstanding).toBe(1);
    p.runWorker();
    p.deliver();

    expect(p.errors.length).toBe(1);
    expect(p.dispatcher.outstanding).toBe(0);

    // And the pipeline keeps working afterwards.
    p.flow(LOUD, HOPS_PER_FRAME + 2);
    expect(p.dispatcher.discarded).toBe(0);
  });
});

describe('HopDispatcher answer accounting', () => {
  it('ignores duplicate and stale answers rather than crediting a slot twice', () => {
    const d = new HopDispatcher(4);
    const a = d.offer()!;
    const b = d.offer()!;
    expect(d.outstanding).toBe(2);

    expect(d.answered(b)).toBe(true);
    expect(d.outstanding).toBe(1);
    // A duplicate of the answer already counted.
    expect(d.answered(b)).toBe(false);
    // An answer for an older hop, arriving late.
    expect(d.answered(a)).toBe(false);
    expect(d.outstanding).toBe(1);
  });

  it('ignores answers for hops that were never forwarded', () => {
    const d = new HopDispatcher(2);
    d.offer();
    d.offer();
    expect(d.offer()).toBeNull(); // discarded, never sent
    expect(d.answered(2)).toBe(false); // the discarded hop's seq
    expect(d.answered(99)).toBe(false);
    expect(d.outstanding).toBe(2);
  });

  it('never drives the outstanding count negative', () => {
    const d = new HopDispatcher(2);
    const seq = d.offer()!;
    d.answered(seq);
    for (let i = 0; i < 10; i++) d.answered(seq);
    expect(d.outstanding).toBe(0);
    // Still able to send afterwards, and still bounded.
    d.offer();
    d.offer();
    expect(d.offer()).toBeNull();
    expect(d.outstanding).toBe(2);
  });

  it('rejects a backpressure limit that cannot work', () => {
    expect(() => new HopDispatcher(0)).toThrow(/backpressure/i);
    expect(() => new HopDispatcher(1.5)).toThrow(/backpressure/i);
  });
});
