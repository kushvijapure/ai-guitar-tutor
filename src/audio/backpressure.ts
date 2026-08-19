/**
 * Bounded backpressure for the capture -> Worker hop stream.
 *
 * `postMessage` queues without bound. If the analysis Worker falls behind — a
 * GC pause, a throttled background tab, a slow machine — hops accumulate at
 * 8 KB and ~46 ms of latency each, and the coach ends up commenting on audio
 * from several seconds ago while memory climbs. So the sender refuses to
 * forward once too many hops are outstanding.
 *
 * The whole scheme rests on one claim: a hop the main thread refuses to forward
 * must be *visible* to the Worker, so the Worker can throw its rolling window
 * away and refill before analysing again. Otherwise it splices audio from
 * opposite sides of the gap into one frame and the FFT reads the discontinuity
 * as broadband energy nobody played — a decision computed from audio that was
 * never performed.
 *
 * Making that claim true needs two counters that the original implementation
 * conflated into one:
 *
 *   captureSeq   advances for EVERY hop the worklet delivers, including the
 *                ones discarded here. This is what makes a discard observable:
 *                the next hop that *is* forwarded carries a sequence number
 *                that skipped the discarded ones, and HopWindow reads that skip
 *                as the discontinuity it is.
 *
 *   inFlight     advances only for hops actually handed to the Worker, and
 *                retreats exactly once per Worker answer. This is what bounds
 *                the queue. It must not be derived from sequence numbers,
 *                because sequence numbers now contain deliberate holes.
 *
 * With a single counter advanced only on send — the previous behaviour — a
 * discard produced no hole at all, so the Worker could not tell that anything
 * had been lost, the splice guard never fired, and the dropped-hop diagnostic
 * read zero while hops were being thrown away.
 *
 * Extracted from the hook rather than inlined so this protocol can be driven
 * against the real Worker in a test. The hook holds no copy of this logic; it
 * calls `offer()` and posts, which is the whole of the sender.
 */
export class HopDispatcher {
  /** Hops seen from the worklet, forwarded or not. The next `seq` to issue. */
  private captureSeq = 0;
  /** Hops handed to the Worker and not yet answered. */
  private inFlight = 0;
  /** Highest seq the Worker has answered, for rejecting stale/duplicate replies. */
  private lastAnsweredSeq = -1;
  /** Highest seq actually forwarded, for rejecting answers to hops never sent. */
  private lastSentSeq = -1;
  /** Hops refused because the Worker was too far behind. */
  private discardedHops = 0;

  /**
   * Hops that may be outstanding in the Worker before the sender starts
   * discarding. Bounds added latency to maxInFlight x the hop period.
   */
  readonly maxInFlight: number;

  constructor(maxInFlight: number) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error(`bad backpressure limit: ${maxInFlight}`);
    }
    this.maxInFlight = maxInFlight;
  }

  /**
   * Account for one hop arriving from the capture worklet.
   *
   * Consumes a capture sequence number unconditionally — that is the point —
   * and returns it if the hop should be forwarded, or null if the Worker is too
   * far behind and the hop must be dropped. A null return means the caller
   * should let the samples fall out of scope; the hole it leaves in the
   * sequence is the Worker's notice that its window is no longer contiguous.
   */
  offer(): number | null {
    const seq = this.captureSeq++;
    if (this.inFlight >= this.maxInFlight) {
      this.discardedHops++;
      return null;
    }
    this.inFlight++;
    this.lastSentSeq = seq;
    return seq;
  }

  /**
   * Account for one Worker answer — an 'ack' or a 'decision', which the message
   * contract guarantees is exactly one per forwarded hop.
   *
   * Retreats `inFlight` by one, never by the sequence delta: the delta counts
   * discarded hops that were never in flight in the first place, and crediting
   * those would let the queue grow past the bound.
   *
   * Ignores anything that is not a first answer to a hop we actually sent. A
   * duplicate or reordered reply would otherwise credit a slot twice and let
   * the sender overshoot; an answer to a seq never sent would mean the counters
   * had already lost track. Neither can drive the count negative.
   *
   * @returns whether the answer was counted, for tests and diagnostics.
   */
  answered(seq: number): boolean {
    if (!Number.isInteger(seq)) return false;
    if (seq <= this.lastAnsweredSeq) return false; // stale or duplicate
    if (seq > this.lastSentSeq) return false; // never forwarded
    this.lastAnsweredSeq = seq;
    this.inFlight--;
    return true;
  }

  /**
   * Forget everything. Used when a session stops or restarts, so a fresh Worker
   * is never judged against the previous one's outstanding work and a restarted
   * sequence is not read as an enormous gap.
   */
  reset(): void {
    this.captureSeq = 0;
    this.inFlight = 0;
    this.lastAnsweredSeq = -1;
    this.lastSentSeq = -1;
    this.discardedHops = 0;
  }

  /**
   * Hops refused because of backpressure, counted where the refusal happens.
   *
   * Authoritative, unlike the Worker's gap-derived count: hops discarded before
   * the first forward, or after the last one, leave no gap for the Worker to
   * observe. Anything above zero in steady state means the analysis thread is
   * not keeping up.
   */
  get discarded(): number {
    return this.discardedHops;
  }

  /** Hops handed to the Worker and not yet answered. Never negative. */
  get outstanding(): number {
    return this.inFlight;
  }

  /** Hops seen from the worklet, forwarded or not. */
  get captured(): number {
    return this.captureSeq;
  }
}
