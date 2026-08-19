/**
 * Every tunable in the analysis pipeline, in one place, with the reasoning.
 *
 * These are engineering judgements, not measured optima. None of them has been
 * validated against a corpus of real guitar recordings — see README, "Real-world
 * evaluation". Where a number is a guess, this file says so.
 *
 * The governing principle: a false "correct!" teaches the player that a wrong
 * shape is right, which is worse than staying silent. Every gate below is
 * therefore biased toward refusing to answer.
 */

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * 8192 samples is ~186 ms at 44.1 kHz. Long, but chroma needs low-frequency
 * resolution: at the low E (82.4 Hz) a semitone spans only ~4.9 Hz, and an
 * 8192-point FFT at 44.1 kHz gives 5.4 Hz bins. Halving this would smear the
 * bottom two strings into neighbouring pitch classes.
 */
export const FRAME_SIZE = 8192;

/** 2048-sample hop => ~46 ms, ~21 analyses/second. Fast enough to feel live. */
export const HOP_SIZE = 2048;

/**
 * How many hops may be outstanding in the analysis Worker before the main
 * thread starts dropping them.
 *
 * postMessage queues without bound. If the Worker ever falls behind — a GC
 * pause, a throttled background tab, a slow machine — hops accumulate at 8 KB
 * and ~46 ms of latency each, and the coach ends up commenting on audio from
 * several seconds ago while memory climbs. Dropping the newest hop instead
 * bounds latency to MAX_INFLIGHT_HOPS x 46 ms (~280 ms at 6).
 *
 * Dropping is safe because the Worker treats a gap in the sequence as a
 * discontinuity and refills its whole window before analysing again, so no
 * decision is ever computed from spliced audio. Normal operation sits at 0-1
 * outstanding, so this only engages under genuine overload.
 *
 * Cost, measured in Chrome at 48 kHz rather than estimated: mean 4.43 ms per
 * analysis, worst 45 ms, against a 42.7 ms hop budget — one frame over budget,
 * the first, while cold. Comfortable, but roughly 4x the ~1 ms this comment
 * previously claimed. That figure came from a synthetic load under automated
 * Chrome, so re-measure on target hardware rather than trusting it.
 */
export const MAX_INFLIGHT_HOPS = 6;

/**
 * YIN is O(window x maxLag), the single most expensive step in the pipeline.
 * Guitar fundamentals top out around 1.2 kHz, so quarter rate (11 kHz, Nyquist
 * 5.5 kHz) discards nothing we use.
 *
 * Measured on an 8192-sample frame (npm run bench, M-series, node 24):
 *   1x  5.413 ms/frame
 *   2x  1.320 ms/frame
 *   4x  0.438 ms/frame
 *
 * At the prototype's 60 Hz main-thread cadence, the 1x path cost ~325 ms of CPU
 * per second — about a third of a core, on the thread React renders from.
 *
 * Requires an anti-alias filter first, or content above the new Nyquist folds
 * back into the guitar's range and YIN locks onto the alias; see decimate().
 */
export const PITCH_DECIMATION = 4;

/** Guitar range for pitch detection, with headroom for flat/drop tunings. */
export const PITCH_MIN_HZ = 70;
export const PITCH_MAX_HZ = 1200;

// ---------------------------------------------------------------------------
// Signal presence
// ---------------------------------------------------------------------------

/**
 * Hard RMS floor. Below this we call it silence regardless of calibration —
 * it protects against a calibration run that happened in an unusually loud
 * room and set the floor absurdly high.
 */
export const SILENCE_RMS_ABSOLUTE = 0.004;

/**
 * How far above the measured room noise floor the signal must sit before we
 * treat it as "the player is playing". 3x linear (~9.5 dB) is a compromise:
 * lower and hum/hiss starts triggering analysis, higher and a quiet acoustic
 * in a treated room never registers.
 */
export const NOISE_FLOOR_MARGIN = 3;

/** Length of the "stay quiet" calibration at session start. */
export const CALIBRATION_MS = 1500;

/**
 * Calibration uses a high percentile rather than the mean so that one cough or
 * chair creak during the quiet period does not inflate the floor for the whole
 * session.
 */
export const CALIBRATION_PERCENTILE = 0.8;

/** Fallback floor if calibration is skipped or produced nothing usable. */
export const DEFAULT_NOISE_FLOOR = SILENCE_RMS_ABSOLUTE;

/**
 * Per-silent-frame rate at which the noise floor drifts toward the level
 * actually observed between strums. 0.02 at ~21 fps has a time constant of
 * ~2.4 s, which tracks a fan switching on without chasing the tail of a decaying
 * chord.
 */
export const NOISE_FLOOR_ADAPT_RATE = 0.02;

/**
 * Hard band the adapted floor is clamped to, as a multiple of the calibrated
 * floor. This is a safety bound, not a tuning knob: adaptation is fed by frames
 * that are by definition below the gate, and the gate is NOISE_FLOOR_MARGIN
 * times the floor, so an unclamped average can ratchet upward without limit —
 * each rise admits louder frames as "silence", which raises the floor again,
 * until the player's actual guitar reads as silence. 4x gives real rooms room
 * to drift while making runaway impossible.
 */
export const NOISE_FLOOR_ADAPT_MIN = 0.25;
export const NOISE_FLOOR_ADAPT_MAX = 4;

/**
 * How many frames of "there is sound here and we are calling it silence" must
 * accumulate before the app says the calibration is unusable.
 *
 * This is a patience window, NOT a detection threshold. What counts as sound is
 * decided entirely by NOISE_FLOOR_MARGIN and SILENCE_RMS_ABSOLUTE — the gates
 * that already exist — measured against the quietest this room has actually
 * been since calibration. This number only decides how long we wait before
 * saying so, and changing it cannot make the app accept or reject a chord.
 *
 * 64 frames is ~3.0 s at the 21.5 Hz analysis rate. Long enough that a passing
 * lorry or a chair scrape cannot trigger the message, short enough that a
 * player who has been strumming into a deaf app finds out quickly. Not measured
 * against real sessions; nothing here has been. See ChordDecider for what the
 * detection itself rests on.
 */
export const UNUSABLE_GATE_FRAMES = 64;

// ---------------------------------------------------------------------------
// Chroma
// ---------------------------------------------------------------------------

/** Bins outside this range contribute nothing but noise to a pitch-class profile. */
export const CHROMA_MIN_HZ = 70;
export const CHROMA_MAX_HZ = 2000;

/**
 * Spectral floor relative to the loudest bin in the frame. Relative rather than
 * absolute so it tracks playing dynamics instead of assuming a fixed input gain.
 */
export const SPECTRAL_FLOOR_DB = -55;

/** Exponential smoothing on chroma across frames. Raw frames flicker during decay. */
export const CHROMA_SMOOTHING = 0.6;

/**
 * When the signal drops below the noise floor, the smoothed chroma decays by
 * this factor per frame instead of persisting. At ~21 fps a factor of 0.55
 * takes the previous chord to under 5% of its level in ~5 frames (~230 ms), so
 * the next chord is not judged against the last one's residue.
 */
export const SILENCE_DECAY = 0.55;

/** After this long below the noise floor, the chroma is dropped entirely. */
export const SILENCE_RESET_MS = 400;

// ---------------------------------------------------------------------------
// Chord decision gates
// ---------------------------------------------------------------------------

/**
 * Minimum cosine similarity for the top match. Synthetic clean triads score
 * 0.94-0.98; power chords and single notes land at 0.77-0.91. This sits above
 * the noise but is NOT by itself sufficient — see the gates below, which are
 * what actually separate a triad from a loud single note.
 *
 * Deliberately NOT raised to close the added-wrong-note gap. A correct C with
 * an extra F added at half the chord's level scores 0.901 while a legitimate
 * bright C (rolloff 0.5) scores 0.896 — the wrong reading scores higher, so
 * every value that rejects the first rejects the second too.
 *
 * Precisely: NO THRESHOLD ON THIS SCORE separates those two cases. That is a
 * narrower claim than "they cannot be separated", and the distinction matters
 * to whoever picks this up next. A different discriminant plausibly could —
 * review suggested harmonic explicability, since F is not a low-order harmonic
 * of C, E or G, whereas a bright C's extra pitch classes are exactly the
 * low-order harmonics of its own chord tones. Pitch-class count does not help
 * (both show 5). That is unbuilt and unvalidated: it needs the real-audio
 * corpus described in the README, not synthetic headroom, because real
 * inharmonicity and room modes would drive false rejects.
 *
 * See tests/chords.test.ts, "rejects a stray F once it is as prominent as the
 * chord tones", for the measurements.
 */
export const MIN_TOP_SCORE = 0.86;

/**
 * The top match must beat the runner-up by this much. This backs up the
 * characteristic-tone gate against major/minor and triad/sus ambiguity: those
 * pairs differ by one pitch class and score within a few percent of each other
 * when the third is weak.
 *
 * Extensions of the same chord (C vs C7, Am vs Am7) legitimately score close
 * together, so they are excluded from the margin test — see isBenignRival().
 *
 * Set to 0.04 from measurement, not taste. Open Em is the tightest legitimate
 * case in the current lesson: the shape contains a single G against three E's
 * and two B's, so it only clears G major by 0.066 on a clean synthetic signal.
 * A 0.06 threshold left 0.006 of headroom, which real signal variation would
 * eat. Lowering it costs nothing in false positives — every rejected case in
 * scripts/measure-gates.ts fails on the top-match or characteristic-tone gate
 * first, not on margin.
 */
export const MIN_RUNNER_UP_MARGIN = 0.04;

/**
 * A pitch class counts as "sounding" at this fraction of the peak chroma bin.
 * Calibrated against the harmonic series: a single plucked string puts its 3rd
 * harmonic (the fifth) at ~0.29 of the fundamental's chroma energy and its 5th
 * harmonic (the major third) at ~0.11, so 0.30 keeps a lone note at one
 * pitch class instead of three.
 */
export const PRESENCE_THRESHOLD = 0.3;

/**
 * A triad needs three distinct sounding pitch classes. This is the gate that
 * rejects power chords (two classes) and single notes (one), both of which
 * otherwise score 0.84+ against a major template purely from harmonics.
 */
export const MIN_PITCH_CLASSES = 3;

/**
 * ...and no more than this many, because a chord is a *sparse* pitch-class
 * profile. Broadband noise produces a flat chroma in which all twelve classes
 * clear the presence threshold, which otherwise satisfies both the pitch-class
 * count and the characteristic-tone test — measured at 12/12 classes present
 * for white noise. Real strummed voicings in this lesson reach 4.
 */
export const MAX_PITCH_CLASSES = 6;

/**
 * Expected chroma energy at the major third purely as leakage from the root's
 * 5th harmonic, as a fraction of the root's own chroma energy.
 *
 * For a 1/h amplitude series the root's pitch class collects harmonics 1, 2, 4
 * and 8 (1 + 1/2 + 1/4 + 1/8 = 1.875) while the major third collects only
 * harmonic 5 (1/5 = 0.2), giving 0.2/1.875 = 0.107. Real guitar timbres are
 * more harmonically rich than 1/h, so this is set roughly 2x higher.
 */
export const MAJOR_THIRD_HARMONIC_LEAKAGE = 0.22;

/**
 * How far the third must exceed the leakage estimate before we believe it was
 * actually fretted. Applies only to major thirds: the minor third (3 semitones)
 * and the fourth (5, for sus4) do not appear in the low harmonic series of the
 * root at all, so any energy there is real.
 */
export const THIRD_SAFETY_FACTOR = 1.5;

/**
 * How far a competing chord must beat the expected one before we tell the
 * player they played the wrong chord (as opposed to "I can't tell"). Naming the
 * wrong chord confidently is its own kind of bad coaching.
 */
export const WRONG_CHORD_MARGIN = 0.05;

/**
 * Consecutive analysis windows that must all agree before a chord is confirmed.
 * At a 46 ms hop, 4 windows is ~185 ms — long enough to reject the transient
 * chaos of a strum attack, short enough not to feel laggy.
 */
export const STABILITY_WINDOWS = 4;

/**
 * How long a chord must be held after confirmation before the lesson advances.
 * Distinct from STABILITY_WINDOWS: stability decides "this is a C", the hold
 * decides "they can keep it clean".
 */
export const HOLD_SECONDS = 1.5;

/**
 * Missing-tone advice is suppressed unless the chroma is at least this
 * trustworthy. Naming a specific absent note from a noisy frame is exactly the
 * kind of confident-and-wrong output this project is trying to avoid.
 */
export const MISSING_TONE_MIN_SNR = 6;

/** A chord tone counts as present for missing-tone advice at this level. */
export const MISSING_TONE_PRESENCE = 0.35;

// ---------------------------------------------------------------------------
// Hand tracking / posture
// ---------------------------------------------------------------------------

/** MediaPipe inference cap. Hand shape does not change meaningfully faster. */
export const HAND_TRACKING_FPS = 20;

/** React state update cap. Internal analysis runs faster; the UI does not need to. */
export const UI_UPDATE_HZ = 12;

/**
 * Landmark smoothing across frames (exponential). MediaPipe landmarks jitter by
 * a few pixels frame to frame, which swings a joint angle by several degrees —
 * enough to flip a cue on and off if measured raw.
 */
export const LANDMARK_SMOOTHING = 0.65;

/** Frames of smoothed history required before any posture judgement is offered. */
export const POSTURE_WARMUP_FRAMES = 5;

/**
 * MediaPipe's per-hand detection confidence below which we decline to judge.
 * The model reports a score for the hand as a whole; a low score usually means
 * partial occlusion, which is exactly when finger angles go wrong.
 */
export const MIN_HAND_CONFIDENCE = 0.7;

/**
 * Landmarks this close to (or past) the frame edge mean the hand is clipped and
 * the joints we need may be outside the image. Expressed in normalized units.
 */
export const EDGE_MARGIN = 0.02;

/**
 * PIP angle above which a finger is judged to be lying flat. Measured
 * MCP -> PIP -> DIP, so 180 is a straight finger.
 *
 * NOTE: this is a plausible value, not a measured one. It has not been checked
 * against players whose fingers were independently judged flat by a teacher.
 */
export const FLAT_FINGER_ANGLE = 158;

/** PIP angle below which the knuckle has buckled and the tip has no support. */
export const OVERCURL_FINGER_ANGLE = 75;

/**
 * Minimum bone length for a joint angle to mean anything, as a fraction of hand
 * size (wrist to middle-finger MCP). Expressed as a fraction so it works both
 * in image-normalized coordinates and in MediaPipe's metric world landmarks.
 *
 * A finger pointing straight at the camera projects to almost nothing, and the
 * angle measured across two near-zero-length bones is pure landmark noise.
 */
export const MIN_BONE_FRACTION = 0.12;

/**
 * Above this ratio between the two bones meeting at the PIP joint, the finger
 * is severely foreshortened — angled toward or away from the camera — and the
 * measured angle says more about the viewing angle than about the finger.
 */
export const MAX_BONE_LENGTH_RATIO = 2.5;

/**
 * Minimum hand size (wrist to middle MCP) as a fraction of the frame's smaller
 * dimension. A hand this small is too far away for landmark precision to
 * support any judgement about individual finger joints.
 */
export const MIN_HAND_SCALE = 0.08;
