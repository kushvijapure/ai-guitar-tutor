/**
 * Recovery from a calibration run in a noisy room.
 *
 * The failure: calibrate while something loud is happening, the noise floor is
 * set from that, the signal gate lands above anything the player produces, and
 * the app is deaf for the rest of the session. The level meter visibly moves
 * while the chord panel says "waiting for you to play", and no amount of
 * playing changes it — adaptive drift is clamped and cannot climb back down
 * that far by design.
 *
 * These drive real synthesized audio through the exact pipeline the browser
 * runs (FrameAnalyzer -> ChordDecider), so the RMS values the detector sees are
 * the ones the DSP actually produces, not numbers chosen to make it fire.
 */

import { describe, expect, it } from 'vitest';
import { FrameAnalyzer } from '../src/lib/analyzer';
import { ChordDecider, type ChordDecision } from '../src/lib/chordDecision';
import type { ChordSpec } from '../src/lib/chroma';
import {
  CALIBRATION_MS,
  FRAME_SIZE,
  HOP_SIZE,
  NOISE_FLOOR_ADAPT_MIN,
  UNUSABLE_GATE_FRAMES,
} from '../src/lib/thresholds';
import { addNoise, chord, concat, DEFAULT_SAMPLE_RATE, frames, silence, VOICINGS } from './signals';

const SR = DEFAULT_SAMPLE_RATE;
const HOP_MS = (HOP_SIZE / SR) * 1000;
const C: ChordSpec = { root: 0, quality: 'major' };

/** Samples of audio that produce roughly `frames` analysis windows. */
const forFrames = (n: number) => FRAME_SIZE + n * HOP_SIZE;

/** Room tone only, at the given noise amplitude. */
function room(level: number, samples: number, seed = 1): Float32Array {
  return addNoise(silence(samples), level, seed);
}

/** A held C, quiet enough to be plausible for a guitar heard across a room. */
function playing(roomLevel: number, samples: number, amplitude = 0.02, seed = 2): Float32Array {
  const signal = chord([...VOICINGS.C], samples, SR, { amplitude, harmonics: 8 });
  return addNoise(signal, roomLevel, seed);
}

/**
 * A whole session, hop by hop, with calibration triggered at chosen points.
 *
 * `calibrateAt` holds sample offsets; calibration begins on the first frame at
 * or past each one, which is what a click on "Recalibrate noise" amounts to.
 */
function session(signal: Float32Array, calibrateAt: number[] = [0]) {
  const analyzer = new FrameAnalyzer(FRAME_SIZE);
  const decider = new ChordDecider();
  const pending = [...calibrateAt];
  const out: ChordDecision[] = [];

  frames(signal, FRAME_SIZE, HOP_SIZE).forEach((frame, i) => {
    const offset = i * HOP_SIZE;
    while (pending.length > 0 && offset >= pending[0]) {
      pending.shift();
      decider.beginCalibration();
    }
    const now = i * HOP_MS;
    // The gate the worker would pass, so the analyzer skips exactly the frames
    // the decider is about to ignore — including, crucially, the ones this test
    // is about.
    const observation = analyzer.analyze(frame, SR, decider.signalGate());
    out.push(decider.update({ chroma: observation.chroma, rms: observation.rms, now }, C));
  });

  return { decisions: out, decider };
}

/** Enough audio for the detector's patience window, with margin. */
const DEAF_SAMPLES = forFrames(UNUSABLE_GATE_FRAMES + 12);
/** Room tone for a moment after calibration, which is what arms the detector. */
const PAUSE_SAMPLES = forFrames(8);
const CALIBRATION_SAMPLES = Math.ceil((CALIBRATION_MS / 1000) * SR) + FRAME_SIZE;

const LOUD_ROOM = 0.12;
const QUIET_ROOM = 0.002;

describe('calibration in a noisy room', () => {
  it('leaves the app deaf, which is the failure being fixed', () => {
    const { decisions, decider } = session(
      concat(
        room(LOUD_ROOM, CALIBRATION_SAMPLES),
        room(QUIET_ROOM, PAUSE_SAMPLES),
        playing(QUIET_ROOM, DEAF_SAMPLES),
      ),
    );

    const afterCalibration = decisions.filter((d) => d.status !== 'calibrating');
    // Not one frame is ever heard, despite a chord being played throughout.
    expect(afterCalibration.every((d) => d.status === 'silent')).toBe(true);
    // And the meter is not showing nothing — there is plainly signal.
    const loudest = Math.max(...afterCalibration.map((d) => d.level));
    expect(loudest).toBeGreaterThan(0.01);
    // Adaptive drift cannot rescue it. It is clamped below, and it is pulled
    // back upward by the very audio it is ignoring — the inaudible chord counts
    // as "silence" and so feeds the floor estimate. The gate therefore stays
    // above everything the player produces, for the whole session. Speaking up
    // is the only recovery available.
    expect(decider.getNoiseFloor()).toBeGreaterThanOrEqual(
      decider.getCalibratedFloor() * NOISE_FLOOR_ADAPT_MIN - 1e-9,
    );
    expect(decider.signalGate()).toBeGreaterThan(loudest);
  });

  it('says so explicitly rather than sitting silent', () => {
    const { decisions } = session(
      concat(
        room(LOUD_ROOM, CALIBRATION_SAMPLES),
        room(QUIET_ROOM, PAUSE_SAMPLES),
        playing(QUIET_ROOM, DEAF_SAMPLES),
      ),
    );

    expect(decisions[decisions.length - 1].calibrationUnusable).toBe(true);

    // It waits for the evidence rather than firing on the first odd frame.
    const first = decisions.findIndex((d) => d.calibrationUnusable);
    expect(first).toBeGreaterThanOrEqual(UNUSABLE_GATE_FRAMES);

    // And it stays a claim about calibration, not about the chord: the state
    // machine is untouched, still reporting silence.
    expect(decisions[first].status).toBe('silent');
    expect(decisions[first].check).toBeNull();
    expect(decisions[first].heard).toEqual([]);
  });

  it('recovers on recalibration in a quiet room, and then hears the player', () => {
    const before = concat(
      room(LOUD_ROOM, CALIBRATION_SAMPLES),
      room(QUIET_ROOM, PAUSE_SAMPLES),
      playing(QUIET_ROOM, DEAF_SAMPLES),
    );
    const { decisions } = session(
      concat(
        before,
        // The player reads the message, stops, and clicks "Recalibrate noise".
        room(QUIET_ROOM, CALIBRATION_SAMPLES),
        playing(QUIET_ROOM, forFrames(12)),
      ),
      [0, before.length],
    );

    // It was flagged...
    expect(decisions.some((d) => d.calibrationUnusable)).toBe(true);
    // ...and the second calibration clears it and does not bring it back.
    const retry = decisions.slice(decisions.findLastIndex((d) => d.status === 'calibrating'));
    expect(retry.some((d) => d.calibrationUnusable)).toBe(false);
    // ...and the same playing that was inaudible before is now heard.
    expect(retry.some((d) => d.status !== 'silent' && d.status !== 'calibrating')).toBe(true);
  });

  it('clears the flag the moment anything gets through', () => {
    const { decisions } = session(
      concat(
        room(LOUD_ROOM, CALIBRATION_SAMPLES),
        room(QUIET_ROOM, PAUSE_SAMPLES),
        playing(QUIET_ROOM, DEAF_SAMPLES),
        // Loud enough to clear even the inflated gate.
        playing(QUIET_ROOM, forFrames(10), 0.4),
      ),
    );

    expect(decisions.some((d) => d.calibrationUnusable)).toBe(true);
    const heard = decisions.findIndex((d) => d.status !== 'silent' && d.status !== 'calibrating');
    expect(heard).toBeGreaterThan(0);
    expect(decisions.slice(heard).every((d) => !d.calibrationUnusable)).toBe(true);
  });
});

describe('what the detector refuses to claim', () => {
  it('stays quiet when calibration was honest and the player is simply not playing', () => {
    const { decisions } = session(
      concat(room(QUIET_ROOM, CALIBRATION_SAMPLES), room(QUIET_ROOM, DEAF_SAMPLES)),
    );
    expect(decisions.every((d) => !d.calibrationUnusable)).toBe(true);
  });

  it('stays quiet when calibration was honest and the player is heard', () => {
    const { decisions } = session(
      concat(
        room(QUIET_ROOM, CALIBRATION_SAMPLES),
        room(QUIET_ROOM, PAUSE_SAMPLES),
        playing(QUIET_ROOM, DEAF_SAMPLES),
      ),
    );
    expect(decisions.some((d) => d.status !== 'silent' && d.status !== 'calibrating')).toBe(true);
    expect(decisions.every((d) => !d.calibrationUnusable)).toBe(true);
  });

  it('stays quiet in a room that is genuinely and continuously loud', () => {
    // Calibration measured this room correctly; it is just a loud room, and a
    // quiet guitar in it really is below the noise. Nothing about the
    // calibration is wrong, so there is nothing to report — telling the player
    // to recalibrate would send them round a loop that cannot help.
    const { decisions } = session(
      concat(
        room(LOUD_ROOM, CALIBRATION_SAMPLES),
        room(LOUD_ROOM, PAUSE_SAMPLES),
        playing(LOUD_ROOM, DEAF_SAMPLES),
      ),
    );
    expect(decisions.every((d) => !d.calibrationUnusable)).toBe(true);
  });

  it('stays quiet while adaptive drift can still fix the gate itself', () => {
    // Calibration was only mildly off — the room settled a little afterwards,
    // within the band NOISE_FLOOR_ADAPT_MIN allows the floor to drift across.
    // The app may be briefly deaf, but the mechanism that already exists will
    // walk the floor down on its own, so telling the player their calibration
    // was ruined would be both wrong and useless. The detector deliberately
    // waits until drift has provably run out of range.
    const CAL = Math.ceil((CALIBRATION_MS / 1000) * SR) + FRAME_SIZE;
    const { decisions, decider } = session(
      concat(
        room(0.02, CAL),
        room(0.014, PAUSE_SAMPLES, 3),
        room(0.045, DEAF_SAMPLES, 5), // audible, ignored, sustained
      ),
    );

    // The preconditions this test exists to cover really do hold: the app IS
    // deaf to sustained sound that a floor matching the room would have passed.
    const after = decisions.filter((d) => d.status !== 'calibrating');
    expect(after.every((d) => d.status === 'silent')).toBe(true);
    const quietest = Math.min(...after.map((d) => d.level));
    const loudest = Math.max(...after.map((d) => d.level));
    expect(loudest).toBeGreaterThan(quietest * 3);
    expect(decider.signalGate()).toBeGreaterThan(loudest);
    // ...and yet the room stayed within reach of adaptive drift.
    expect(quietest).toBeGreaterThan(decider.getCalibratedFloor() * NOISE_FLOOR_ADAPT_MIN);

    expect(decisions.every((d) => !d.calibrationUnusable)).toBe(true);
  });

  it('stays quiet before any calibration has completed', () => {
    const decider = new ChordDecider();
    const analyzer = new FrameAnalyzer(FRAME_SIZE);
    const signal = playing(QUIET_ROOM, DEAF_SAMPLES);
    // No beginCalibration() at all: the default floor is in force.
    const out = frames(signal, FRAME_SIZE, HOP_SIZE).map((frame, i) =>
      decider.update(
        {
          ...analyzer.analyze(frame, SR, decider.signalGate()),
          now: i * HOP_MS,
        },
        C,
      ),
    );
    expect(out.every((d) => !d.calibrationUnusable)).toBe(true);
  });
});
