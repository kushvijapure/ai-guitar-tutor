/**
 * Turns a stream of per-frame chroma observations into a decision about whether
 * the expected chord is being played.
 *
 * Split out from the audio plumbing on purpose: this is pure, synchronous, and
 * driven entirely by its arguments, so the tests can push a scripted sequence of
 * frames through it (silence, then a strum, then silence again) and assert on
 * the exact state transitions without a browser or an AudioContext.
 *
 * The states are deliberately more granular than correct/incorrect. "I can hear
 * you but I can't tell" and "you played something else" are different messages,
 * and collapsing them into one bar was how the prototype ended up asserting
 * things it could not support.
 */

import {
  checkExpectedChord,
  isBenignRival,
  matchChord,
  missingTones,
  type Chroma,
  type ChordMatch,
  type ChordSpec,
  type ExpectedChordCheck,
} from './chroma';
import {
  CALIBRATION_MS,
  CALIBRATION_PERCENTILE,
  CHROMA_SMOOTHING,
  DEFAULT_NOISE_FLOOR,
  MAX_PITCH_CLASSES,
  MIN_PITCH_CLASSES,
  MIN_TOP_SCORE,
  NOISE_FLOOR_ADAPT_MAX,
  NOISE_FLOOR_ADAPT_MIN,
  NOISE_FLOOR_ADAPT_RATE,
  NOISE_FLOOR_MARGIN,
  SILENCE_DECAY,
  SILENCE_RESET_MS,
  SILENCE_RMS_ABSOLUTE,
  STABILITY_WINDOWS,
  WRONG_CHORD_MARGIN,
} from './thresholds';

export type ChordStatus =
  /** Measuring the room's noise floor; not yet judging anything. */
  | 'calibrating'
  /** Nothing above the noise floor. */
  | 'silent'
  /** Signal present, evidence still accumulating. */
  | 'listening'
  /** Enough signal, but competing interpretations are too close to separate. */
  | 'ambiguous'
  /** The right chord is the best reading, but a defining tone is not sounding. */
  | 'incomplete'
  /** A different chord is clearly being played. */
  | 'wrong'
  /** Every gate passed, held stable across multiple windows. */
  | 'confirmed';

export interface ChordDecision {
  status: ChordStatus;
  /** Cosine similarity for the expected chord, 0..1. For the meter only. */
  score: number;
  /** Progress toward temporal confirmation, 0..1. */
  stability: number;
  /** Per-frame gate results, null when there was nothing to evaluate. */
  check: ExpectedChordCheck | null;
  /** Best readings of what is actually sounding, for "heard:" display. */
  heard: ChordMatch[];
  /** Chord tones not sounding, or null when the signal cannot support advice. */
  missing: string[] | null;
  /** Frame level against the measured room floor, in dB. */
  snrDb: number;
  /** Raw RMS of the frame. */
  level: number;
  /** 0..1 while calibrating. */
  calibrationProgress: number;
}

export interface AnalysisFrame {
  /** Normalized pitch-class profile, or null if the frame had no usable energy. */
  chroma: Chroma | null;
  /** RMS of the time-domain frame. */
  rms: number;
  /** Monotonic timestamp in milliseconds. */
  now: number;
}

const IDLE: ChordDecision = {
  status: 'silent',
  score: 0,
  stability: 0,
  check: null,
  heard: [],
  missing: null,
  snrDb: -Infinity,
  level: 0,
  calibrationProgress: 1,
};

export class ChordDecider {
  private smoothed: Float32Array | null = null;
  private lastSignalAt: number | null = null;
  private agreeing = 0;
  private lastExpectedKey = '';

  private noiseFloor = DEFAULT_NOISE_FLOOR;
  /** The floor as measured by the last calibration. Bounds adaptive drift. */
  private calibratedFloor = DEFAULT_NOISE_FLOOR;
  private calibrationPending = false;
  private calibrationStart: number | null = null;
  private calibrationSamples: number[] = [];
  private calibrated = false;

  /**
   * Begin (or restart) noise-floor measurement. The caller is expected to ask
   * the player not to play during this window.
   *
   * Deliberately takes no timestamp. The window is timed against the clock
   * carried by the frames themselves, latched on the first frame that arrives
   * after this call.
   *
   * This used to accept a `now`, and the Worker passed performance.now() while
   * the frames carried AudioContext.currentTime * 1000. Those two clocks share
   * no origin: performance.now() is milliseconds since page load, currentTime
   * restarts near zero for every AudioContext. On a page that had been open for
   * 30 seconds the elapsed time computed here went strongly negative and
   * calibration never finished, so the coach sat in 'calibrating' and judged
   * nothing for the whole session. Taking the start time from the same clock as
   * the frames makes that class of mismatch impossible to reintroduce.
   */
  beginCalibration(): void {
    this.calibrationPending = true;
    this.calibrationStart = null;
    this.calibrationSamples = [];
    this.calibrated = false;
  }

  /** Reset all evidence. Used when a session stops or the lesson chord changes. */
  reset(): void {
    this.smoothed = null;
    this.lastSignalAt = null;
    this.agreeing = 0;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  /**
   * The floor as last measured by calibration, before any adaptive drift.
   *
   * Adaptation is bounded relative to this rather than to the current value —
   * bounding it relative to the current value is precisely the ratchet the
   * clamp exists to prevent.
   */
  getCalibratedFloor(): number {
    return this.calibratedFloor;
  }

  /**
   * RMS below which a frame is treated as silence.
   *
   * Exposed so the analyzer can skip the FFT and YIN entirely for frames this
   * decider would ignore anyway — that early exit is most of the reason idle
   * CPU use is near zero between strums.
   */
  signalGate(): number {
    return Math.max(SILENCE_RMS_ABSOLUTE, this.noiseFloor * NOISE_FLOOR_MARGIN);
  }

  update(frame: AnalysisFrame, expected: ChordSpec): ChordDecision {
    const { rms, now } = frame;

    // ---- Calibration -----------------------------------------------------
    if (this.calibrationPending) {
      // Latch the window's origin to the frame clock, whatever that clock is.
      if (this.calibrationStart === null) this.calibrationStart = now;
      const elapsed = now - this.calibrationStart;
      this.calibrationSamples.push(rms);

      if (elapsed < CALIBRATION_MS) {
        return {
          ...IDLE,
          status: 'calibrating',
          level: rms,
          calibrationProgress: Math.max(0, Math.min(1, elapsed / CALIBRATION_MS)),
        };
      }

      this.finishCalibration();
    }

    // ---- Signal presence -------------------------------------------------
    const hasSignal = rms >= this.signalGate();
    const snrDb = this.noiseFloor > 0 ? 20 * Math.log10(rms / this.noiseFloor) : -Infinity;

    // A new expected chord invalidates accumulated agreement, otherwise the
    // stability earned on the previous chord would carry over and the next one
    // could confirm almost instantly.
    const key = `${expected.root}:${expected.quality}`;
    if (key !== this.lastExpectedKey) {
      this.lastExpectedKey = key;
      this.agreeing = 0;
    }

    if (!hasSignal) {
      return this.handleSilence(now, rms, snrDb);
    }
    this.lastSignalAt = now;

    if (!frame.chroma) {
      // Level cleared the gate but the spectrum had nothing usable in the
      // guitar's range — broadband noise, or hum below the chroma band.
      this.agreeing = 0;
      return { ...IDLE, status: 'listening', level: rms, snrDb };
    }

    // ---- Smoothing -------------------------------------------------------
    if (!this.smoothed) {
      this.smoothed = new Float32Array(frame.chroma);
    } else {
      const s = this.smoothed;
      for (let i = 0; i < 12; i++) {
        s[i] = s[i] * CHROMA_SMOOTHING + frame.chroma[i] * (1 - CHROMA_SMOOTHING);
      }
    }
    const chroma = this.smoothed;

    // ---- Gates -----------------------------------------------------------
    const check = checkExpectedChord(chroma, expected);
    const heard = matchChord(chroma, 2);

    const scoreOk = check.score >= MIN_TOP_SCORE;
    const framePasses = check.passes && scoreOk;

    if (framePasses) {
      this.agreeing = Math.min(STABILITY_WINDOWS, this.agreeing + 1);
    } else {
      // Drop straight to zero rather than decrementing: a chord that flickers
      // in and out of correctness has not been held, and letting agreement
      // survive a bad frame is how a brief accidental match sneaks through.
      this.agreeing = 0;
    }

    const status: ChordStatus = framePasses
      ? this.agreeing >= STABILITY_WINDOWS
        ? 'confirmed'
        : 'listening'
      : classify(check, scoreOk, heard, expected);

    // Missing-tone advice is only meaningful when the player is on the right
    // shape but not sounding all of it. If they played a different chord
    // outright, "you're missing C and E" is technically true and useless — the
    // useful message is "that's a G". Computing it only for 'incomplete' means
    // the UI cannot show it in the wrong context even by accident.
    const missing = status === 'incomplete' ? missingTones(chroma, expected, snrDb) : null;

    return {
      status,
      score: check.score,
      stability: this.agreeing / STABILITY_WINDOWS,
      check,
      heard,
      missing,
      snrDb,
      level: rms,
      calibrationProgress: 1,
    };
  }

  private handleSilence(now: number, level: number, snrDb: number): ChordDecision {
    this.agreeing = 0;
    this.adaptNoiseFloor(level);

    // Decay rather than freeze. If the previous chord's chroma simply persisted,
    // the next chord would be judged against a blend of itself and its
    // predecessor — the stale-evidence bug this rewrite exists to fix.
    if (this.smoothed) {
      const silentFor = this.lastSignalAt === null ? Infinity : now - this.lastSignalAt;
      if (silentFor > SILENCE_RESET_MS) {
        this.smoothed = null;
      } else {
        for (let i = 0; i < 12; i++) this.smoothed[i] *= SILENCE_DECAY;
      }
    }

    return { ...IDLE, status: 'silent', level, snrDb, calibrationProgress: 1 };
  }

  private finishCalibration(): void {
    const samples = this.calibrationSamples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    this.calibrationPending = false;
    this.calibrationStart = null;
    this.calibrationSamples = [];
    this.calibrated = true;

    if (samples.length === 0) {
      this.noiseFloor = DEFAULT_NOISE_FLOOR;
      this.calibratedFloor = this.noiseFloor;
      return;
    }

    // A high percentile, not the mean: one chair creak during the quiet window
    // should not set the floor for the whole session, but neither should we
    // take the single quietest frame and then treat room tone as signal.
    const idx = Math.min(samples.length - 1, Math.floor(samples.length * CALIBRATION_PERCENTILE));
    this.noiseFloor = Math.max(samples[idx], 1e-6);
    this.calibratedFloor = this.noiseFloor;
  }

  /**
   * Slow drift of the noise floor toward the level actually observed while
   * nothing is being played.
   *
   * Only silent frames feed this, and the result is clamped to a fixed band
   * around the calibrated floor. Both restrictions matter. Adapting on frames
   * that cleared the gate would let a sustained note pull the floor up; and an
   * unclamped exponential average fed by frames that are *by definition* below
   * the gate (which sits at NOISE_FLOOR_MARGIN x the floor) can ratchet: each
   * rise lifts the gate, which admits louder frames as "silence", which lifts
   * the floor again, until real playing reads as silence and the coach goes
   * deaf. The clamp makes that runaway impossible.
   *
   * A step change in room noise *above* the gate is not recovered here — those
   * frames are not silence, so they never reach this path. That case needs a
   * fresh calibration, which the UI can trigger.
   */
  private adaptNoiseFloor(level: number): void {
    // A digitally silent frame is a legitimate observation of "quieter than the
    // calibrated floor" and is allowed to pull the estimate down; the lower
    // clamp is what stops it reaching zero.
    if (!Number.isFinite(level) || level < 0) return;
    const next = this.noiseFloor + (level - this.noiseFloor) * NOISE_FLOOR_ADAPT_RATE;
    const low = this.calibratedFloor * NOISE_FLOOR_ADAPT_MIN;
    const high = this.calibratedFloor * NOISE_FLOOR_ADAPT_MAX;
    this.noiseFloor = Math.min(high, Math.max(low, Math.max(next, 1e-6)));
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }
}

/** Why did this frame fail? Ordered most-specific first. */
function classify(
  check: ExpectedChordCheck,
  scoreOk: boolean,
  heard: ChordMatch[],
  expected: ChordSpec,
): ChordStatus {
  // A flat pitch-class profile is noise, not an attempt at a chord. Saying
  // anything about the player's fingers here would be inventing information.
  if (check.pitchClassCount > MAX_PITCH_CLASSES) return 'ambiguous';

  // Too few distinct notes to be a chord at all — a single note, a power chord,
  // or a mostly-muted strum. Reported as incomplete rather than wrong because
  // the player is probably on the right shape but choking strings.
  if (check.pitchClassCount < MIN_PITCH_CLASSES) return 'incomplete';

  if (check.isTopMatch) {
    // Right chord on top, but the tone that defines its quality is not sounding
    // loudly enough to be distinguishable from the root's own harmonics.
    if (!check.hasCharacteristicTone) return 'incomplete';
    // Right chord on top, but something else is nearly as good a reading.
    return scoreOk ? 'ambiguous' : 'listening';
  }

  // Something else is on top. Only call it wrong if that something else is
  // itself a confident reading; otherwise we are just unsure.
  //
  // A same-root extension on top is not "something else". If the player was
  // asked for C and a ringing Bb makes C7 the best reading, they are on the
  // right shape and telling them they played the wrong chord is exactly the
  // confidently-wrong coaching this module exists to avoid. Measured: a C
  // voicing with an accidental Bb reads C7 0.923 / C 0.840, a gap of 0.083 that
  // cleared WRONG_CHORD_MARGIN and produced a 'wrong' verdict. Such a frame
  // still cannot be confirmed — it fails the top-match gate — so demoting it to
  // 'ambiguous' withholds praise without inventing a fault.
  const top = heard[0];
  if (
    top &&
    !isBenignRival(expected, top) &&
    top.score >= MIN_TOP_SCORE &&
    check.score < top.score - WRONG_CHORD_MARGIN
  ) {
    return 'wrong';
  }
  return 'ambiguous';
}
