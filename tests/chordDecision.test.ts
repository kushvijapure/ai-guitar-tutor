/**
 * The chord state machine: silence handling, temporal stability, calibration.
 *
 * These drive real synthesized audio through the exact pipeline the browser
 * runs (FrameAnalyzer -> ChordDecider), one hop at a time, so a test can assert
 * on the sequence of states rather than a single snapshot.
 */

import { describe, expect, it } from 'vitest';
import { FrameAnalyzer } from '../src/lib/analyzer';
import { ChordDecider, type ChordDecision, type ChordStatus } from '../src/lib/chordDecision';
import type { ChordSpec } from '../src/lib/chroma';
import {
  CALIBRATION_MS,
  FRAME_SIZE,
  HOP_SIZE,
  NOISE_FLOOR_ADAPT_MAX,
  NOISE_FLOOR_ADAPT_MIN,
  STABILITY_WINDOWS,
} from '../src/lib/thresholds';
import {
  addHum,
  addNoise,
  chord,
  concat,
  DEFAULT_SAMPLE_RATE,
  frames,
  scale,
  silence,
  strum,
  VOICINGS,
} from './signals';

const SR = DEFAULT_SAMPLE_RATE;
/** Milliseconds of audio per hop, for synthetic timestamps. */
const HOP_MS = (HOP_SIZE / SR) * 1000;

const C: ChordSpec = { root: 0, quality: 'major' };
const G: ChordSpec = { root: 7, quality: 'major' };
const Am: ChordSpec = { root: 9, quality: 'minor' };

function sig(midis: readonly number[], samples = FRAME_SIZE * 6, options = {}): Float32Array {
  return chord([...midis], samples, SR, { amplitude: 0.25, harmonics: 8, ...options });
}

interface RunOptions {
  decider?: ChordDecider;
  expected?: ChordSpec | ((index: number) => ChordSpec);
  startMs?: number;
}

/** Feed a signal through the pipeline hop by hop. */
function run(signal: Float32Array, options: RunOptions = {}): ChordDecision[] {
  const analyzer = new FrameAnalyzer(FRAME_SIZE);
  const decider = options.decider ?? new ChordDecider();
  const expectedFor = typeof options.expected === 'function'
    ? options.expected
    : () => (options.expected as ChordSpec | undefined) ?? C;

  const out: ChordDecision[] = [];
  frames(signal, FRAME_SIZE, HOP_SIZE).forEach((frame, i) => {
    const now = (options.startMs ?? 0) + i * HOP_MS;
    // Use a permissive silence floor here; the decider's own noise gate is what
    // these tests are exercising.
    const observation = analyzer.analyze(frame, SR, 0.0005);
    out.push(decider.update({ chroma: observation.chroma, rms: observation.rms, now }, expectedFor(i)));
  });
  return out;
}

const statuses = (decisions: ChordDecision[]): ChordStatus[] => decisions.map((d) => d.status);

describe('confirmation requires temporal stability', () => {
  it('does not confirm on the first good frame', () => {
    const decisions = run(sig(VOICINGS.C));
    expect(decisions[0].status).not.toBe('confirmed');
  });

  it('confirms only after STABILITY_WINDOWS consecutive agreeing frames', () => {
    const decisions = run(sig(VOICINGS.C));
    const firstConfirmed = decisions.findIndex((d) => d.status === 'confirmed');
    expect(firstConfirmed).toBeGreaterThanOrEqual(STABILITY_WINDOWS - 1);
  });

  it('eventually confirms a sustained correct chord', () => {
    expect(statuses(run(sig(VOICINGS.C)))).toContain('confirmed');
  });

  it('reports rising stability while evidence accumulates', () => {
    const decisions = run(sig(VOICINGS.C));
    const stabilities = decisions.slice(0, STABILITY_WINDOWS).map((d) => d.stability);
    for (let i = 1; i < stabilities.length; i++) {
      expect(stabilities[i]).toBeGreaterThanOrEqual(stabilities[i - 1]);
    }
  });

  it('resets stability when the chord momentarily breaks', () => {
    const decider = new ChordDecider();
    const good = sig(VOICINGS.C, FRAME_SIZE * 3);
    const bad = sig(VOICINGS.G, FRAME_SIZE * 3);
    const decisions = run(concat(good, bad, good), { decider });

    // After the interruption, confirmation must be re-earned rather than resumed.
    const brokeAt = decisions.findIndex((d) => d.status === 'wrong' || d.status === 'ambiguous');
    expect(brokeAt).toBeGreaterThan(-1);
    expect(decisions[brokeAt].stability).toBe(0);
  });
});

describe('silence clears previous evidence', () => {
  it('reports silence for a silent signal', () => {
    expect(statuses(run(silence(FRAME_SIZE * 4)))).toEqual(
      expect.arrayContaining(['silent']),
    );
  });

  it('does not carry a confirmed chord through silence', () => {
    const decisions = run(concat(sig(VOICINGS.C), silence(FRAME_SIZE * 4)));
    expect(decisions[decisions.length - 1].status).toBe('silent');
  });

  it('does not let a previous chord contaminate the next one', () => {
    // The prototype kept its smoothed chroma forever, so a C followed by a G
    // was judged against a blend of the two. Here the G must not be accepted
    // as a C, and the C's evidence must be gone by the time G is judged.
    const decider = new ChordDecider();
    const decisions = run(
      concat(sig(VOICINGS.C, FRAME_SIZE * 4), silence(FRAME_SIZE * 4), sig(VOICINGS.G, FRAME_SIZE * 4)),
      { decider, expected: C },
    );

    const tail = decisions.slice(-4);
    expect(tail.every((d) => d.status !== 'confirmed')).toBe(true);
  });

  it('recognises a new chord cleanly after silence', () => {
    const decider = new ChordDecider();
    const decisions = run(
      concat(sig(VOICINGS.C, FRAME_SIZE * 4), silence(FRAME_SIZE * 5), sig(VOICINGS.G, FRAME_SIZE * 6)),
      { decider, expected: (i) => (i < 6 ? C : G) },
    );
    expect(statuses(decisions.slice(-4))).toContain('confirmed');
  });

  it('decays the smoothed chroma during silence rather than freezing it', () => {
    const decider = new ChordDecider();
    run(sig(VOICINGS.C, FRAME_SIZE * 4), { decider });
    const afterSilence = run(silence(FRAME_SIZE * 4), { decider, startMs: 1000 });
    expect(afterSilence.every((d) => d.status === 'silent')).toBe(true);
  });
});

describe('states are distinguished, not collapsed into right/wrong', () => {
  it('says "wrong" when a clearly different chord is played', () => {
    const decisions = run(sig(VOICINGS.G), { expected: C });
    expect(statuses(decisions)).toContain('wrong');
  });

  it('says "incomplete" for a power chord, not "wrong"', () => {
    // The player is on the right root and probably the right shape; they are
    // just not sounding the third. That is different from playing a G.
    const decisions = run(sig(VOICINGS.C5), { expected: C });
    expect(statuses(decisions)).toContain('incomplete');
    expect(statuses(decisions)).not.toContain('confirmed');
  });

  it('says "incomplete" when the third is muted', () => {
    const decisions = run(sig(VOICINGS.C_noThird), { expected: C });
    expect(statuses(decisions)).toContain('incomplete');
  });

  it('says "incomplete" for a single note', () => {
    const decisions = run(sig([48]), { expected: C });
    expect(statuses(decisions)).toContain('incomplete');
    expect(statuses(decisions)).not.toContain('confirmed');
  });

  it('never confirms broadband noise', () => {
    const noise = addNoise(new Float32Array(FRAME_SIZE * 6), 0.08);
    expect(statuses(run(noise, { expected: C }))).not.toContain('confirmed');
  });

  it('offers missing-tone advice only in the incomplete state', () => {
    for (const decision of run(sig(VOICINGS.G), { expected: C })) {
      if (decision.status !== 'incomplete') expect(decision.missing).toBeNull();
    }
  });

  it('does name the missing tone when the shape is right but a string is dead', () => {
    const decisions = run(sig(VOICINGS.C_noThird), { expected: C });
    const withAdvice = decisions.find((d) => d.status === 'incomplete' && d.missing);
    expect(withAdvice?.missing).toContain('E');
  });
});

describe('low input levels', () => {
  it('treats a signal below the noise gate as silence, not as a chord', () => {
    const quiet = scale(sig(VOICINGS.C), 0.002);
    expect(statuses(run(quiet, { expected: C })).every((s) => s === 'silent')).toBe(true);
  });

  it('still works for a quiet but audible chord', () => {
    const quiet = scale(sig(VOICINGS.C), 0.08);
    expect(statuses(run(quiet, { expected: C }))).toContain('confirmed');
  });
});

describe('strum attack and decay', () => {
  it('does not confirm during the strum transient alone', () => {
    // Notes enter 25 ms apart; during the spread the chord is genuinely
    // incomplete and must not be confirmed.
    const signal = strum([...VOICINGS.C], FRAME_SIZE * 2, SR, { amplitude: 0.3, spreadSeconds: 0.03 });
    const decisions = run(signal, { expected: C });
    expect(decisions[0].status).not.toBe('confirmed');
  });

  it('confirms once a strummed chord has settled', () => {
    const signal = strum([...VOICINGS.C], FRAME_SIZE * 10, SR, {
      amplitude: 0.4,
      spreadSeconds: 0.02,
      decay: 4,
    });
    expect(statuses(run(signal, { expected: C }))).toContain('confirmed');
  });

  it('falls back to silence as the strum dies away', () => {
    const signal = concat(
      strum([...VOICINGS.C], FRAME_SIZE * 6, SR, { amplitude: 0.4, decay: 0.25 }),
      silence(FRAME_SIZE * 3),
    );
    const decisions = run(signal, { expected: C });
    expect(decisions[decisions.length - 1].status).toBe('silent');
  });
});

describe('noise-floor calibration', () => {
  it('reports calibrating while measuring', () => {
    const decider = new ChordDecider();
    decider.beginCalibration();
    const decisions = run(addNoise(new Float32Array(FRAME_SIZE * 4), 0.002), { decider });
    expect(decisions[0].status).toBe('calibrating');
    expect(decisions[0].calibrationProgress).toBeLessThan(1);
  });

  it('raises the noise floor to match a noisy room', () => {
    const noisy = new ChordDecider();
    noisy.beginCalibration();
    run(addNoise(new Float32Array(FRAME_SIZE * 40), 0.03), { decider: noisy });
    expect(noisy.getNoiseFloor()).toBeGreaterThan(0.005);
    expect(noisy.isCalibrated()).toBe(true);
  });

  it('rejects quiet playing that sits below a noisy room floor', () => {
    const noisy = new ChordDecider();
    noisy.beginCalibration();
    run(addNoise(new Float32Array(FRAME_SIZE * 40), 0.05), { decider: noisy });

    // A chord quieter than the measured room noise must not be analysed.
    const quiet = scale(sig(VOICINGS.C), 0.02);
    const decisions = run(quiet, { decider: noisy, expected: C, startMs: 10_000 });
    expect(decisions.every((d) => d.status === 'silent')).toBe(true);
  });

  it('falls back to the default floor when calibration saw nothing', () => {
    const decider = new ChordDecider();
    expect(decider.getNoiseFloor()).toBeGreaterThan(0);
  });
});

describe('changing the expected chord', () => {
  it('does not inherit stability earned on the previous chord', () => {
    const decider = new ChordDecider();
    // Confirm a C, then switch the target to Am mid-stream while still playing C.
    const decisions = run(sig(VOICINGS.C, FRAME_SIZE * 10), {
      decider,
      expected: (i) => (i < 6 ? C : Am),
    });
    const afterSwitch = decisions.slice(6);
    expect(afterSwitch[0].stability).toBe(0);
    expect(afterSwitch.every((d) => d.status !== 'confirmed')).toBe(true);
  });
});

describe('reset', () => {
  it('clears accumulated evidence', () => {
    const decider = new ChordDecider();
    run(sig(VOICINGS.C), { decider });
    decider.reset();
    const after = run(sig(VOICINGS.C, FRAME_SIZE * 2), { decider, startMs: 5000 });
    expect(after[0].status).not.toBe('confirmed');
  });
});

describe('calibration is timed against the frame clock', () => {
  /**
   * Regression. beginCalibration() used to take a timestamp, and the Worker
   * passed performance.now() while the frames carried
   * AudioContext.currentTime * 1000. Those clocks share no origin:
   * performance.now() counts from page load, currentTime restarts near zero for
   * each AudioContext. Elapsed time went negative and calibration never
   * finished, so the coach sat in 'calibrating' and judged nothing all session.
   */
  const quietRoom = (n = 60) => addNoise(new Float32Array(FRAME_SIZE * n), 0.002);

  it.each([0, 30_000, 900_000])(
    'finishes calibration when frames start at %i ms',
    (startMs) => {
      const decider = new ChordDecider();
      decider.beginCalibration();
      const decisions = run(quietRoom(), { decider, startMs });
      expect(decider.isCalibrated()).toBe(true);
      expect(decisions[decisions.length - 1].status).not.toBe('calibrating');
    },
  );

  it('spends about CALIBRATION_MS calibrating, whatever the clock origin', () => {
    const decider = new ChordDecider();
    decider.beginCalibration();
    const decisions = run(quietRoom(), { decider, startMs: 900_000 });
    const calibrating = decisions.filter((d) => d.status === 'calibrating').length;
    const want = CALIBRATION_MS / HOP_MS;
    expect(calibrating).toBeGreaterThanOrEqual(Math.floor(want) - 1);
    expect(calibrating).toBeLessThanOrEqual(Math.ceil(want) + 1);
  });

  it('judges chords normally once calibration has finished', () => {
    const decider = new ChordDecider();
    decider.beginCalibration();
    // Quiet room first, then the player actually plays. A clock mismatch here
    // blocked every chord for the whole session, not just the quiet window.
    const decisions = run(
      concat(quietRoom(50), sig(VOICINGS.C, FRAME_SIZE * 8)),
      { decider, expected: C, startMs: 750_000 },
    );
    expect(statuses(decisions)).toContain('confirmed');
  });

  it('reports calibration progress rising to completion', () => {
    const decider = new ChordDecider();
    decider.beginCalibration();
    const decisions = run(quietRoom(), { decider, startMs: 12_345 });
    const progress = decisions
      .filter((d) => d.status === 'calibrating')
      .map((d) => d.calibrationProgress);
    expect(progress[0]).toBeLessThan(0.2);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
    expect(progress[progress.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe('the noise floor adapts without running away', () => {
  /**
   * These drive the decider directly with frame levels rather than through the
   * FFT. Noise-floor tracking depends only on RMS, so synthesizing and
   * transforming audio would cost seconds per test to exercise nothing extra —
   * and a test that slow is one CPU contention turns into a spurious failure.
   */
  function feed(decider: ChordDecider, level: number, frames: number, startMs: number): void {
    for (let i = 0; i < frames; i++) {
      decider.update({ chroma: null, rms: level, now: startMs + i * HOP_MS }, C);
    }
  }

  /** A calibrated decider, floor measured at roughly `level`. */
  function calibratedAt(level: number): ChordDecider {
    const decider = new ChordDecider();
    decider.beginCalibration();
    feed(decider, level, 60, 0);
    return decider;
  }

  it('drifts down when the room turns out quieter than at calibration', () => {
    const decider = calibratedAt(0.02);
    const calibrated = decider.getNoiseFloor();
    // The fan goes off. The floor should follow rather than staying deaf to
    // quiet playing for the rest of the session.
    feed(decider, 0, 400, 10_000);
    expect(decider.getNoiseFloor()).toBeLessThan(calibrated);
  });

  it('does not drift below its floor no matter how long the room stays silent', () => {
    const decider = calibratedAt(0.02);
    const anchor = decider.getCalibratedFloor();
    feed(decider, 0, 5000, 10_000);
    expect(decider.getNoiseFloor()).toBeCloseTo(anchor * NOISE_FLOOR_ADAPT_MIN, 10);
  });

  it('never lets sustained near-gate noise ratchet the gate upward', () => {
    // The dangerous feedback loop: adaptation is fed by frames below the gate,
    // and the gate is a multiple of the floor, so every rise admits louder
    // frames as "silence" and lifts the floor again — until the guitar itself
    // reads as silence and the coach goes permanently deaf.
    const decider = calibratedAt(0.01);
    const anchor = decider.getCalibratedFloor();

    // Noise re-aimed just under the gate after every round, so it keeps
    // applying upward pressure as the floor moves.
    const pressure = (rounds: number, from: number) => {
      for (let round = 0; round < rounds; round++) {
        feed(decider, decider.signalGate() * 0.95, 200, from + round * 20_000);
      }
    };

    pressure(4, 20_000);
    const afterFour = decider.getNoiseFloor();
    pressure(4, 200_000);
    const afterEight = decider.getNoiseFloor();

    // Hard bound, measured against the calibration rather than against the
    // drifting value — bounding it against itself is the ratchet.
    expect(afterEight).toBeLessThanOrEqual(anchor * NOISE_FLOOR_ADAPT_MAX);
    // The clamp is doing real work here, not sitting unused: the pressure is
    // enough to pin the floor at the cap, and it stops there instead of
    // climbing further over the next four rounds.
    expect(afterEight).toBeCloseTo(anchor * NOISE_FLOOR_ADAPT_MAX, 10);
    expect(afterEight).toBeCloseTo(afterFour, 10);
  });

  it('does not adapt on frames that cleared the gate', () => {
    // A sustained chord must not drag the floor up behind it.
    const decider = calibratedAt(0.004);
    const before = decider.getNoiseFloor();
    feed(decider, decider.signalGate() * 50, 400, 20_000);
    expect(decider.getNoiseFloor()).toBeCloseTo(before, 10);
  });

  it('still hears a real chord after a long stretch of near-gate noise', () => {
    // The whole point of bounding the drift: normal playing must still register
    // once the room settles. This one goes through the real pipeline, because
    // that is the claim being made.
    const decider = calibratedAt(0.01);
    for (let round = 0; round < 8; round++) {
      feed(decider, decider.signalGate() * 0.95, 200, 20_000 + round * 20_000);
    }
    const decisions = run(sig(VOICINGS.C, FRAME_SIZE * 10), {
      decider,
      expected: C,
      startMs: 600_000,
    });
    expect(statuses(decisions)).toContain('confirmed');
  });
});

describe('a same-root extension is not "the wrong chord"', () => {
  /**
   * Measured before the fix: a C voicing with a Bb ringing reads C7 at 0.923
   * against C at 0.840. That 0.083 gap cleared WRONG_CHORD_MARGIN, so the coach
   * told a player who was on the correct shape that they had played the wrong
   * chord. isBenignRival() already encoded that same-root extensions are not a
   * different chord; the verdict just was not consulting it.
   */
  const ringing = () => sig(VOICINGS.C_ringingSeventh, FRAME_SIZE * 8);

  it('never calls a C with a ringing Bb "wrong" when C was asked for', () => {
    expect(statuses(run(ringing(), { expected: C }))).not.toContain('wrong');
  });

  it('still withholds confirmation for it', () => {
    // Not wrong is not the same as correct: the extra note means the expected
    // chord is not the top reading, so it must not be confirmed either.
    expect(statuses(run(ringing(), { expected: C }))).not.toContain('confirmed');
  });

  it('offers no missing-tone advice for it', () => {
    for (const d of run(ringing(), { expected: C })) {
      if (d.status !== 'incomplete') expect(d.missing).toBeNull();
    }
  });

  it('still calls a genuinely different chord wrong', () => {
    // The guard must not have blunted the wrong-chord verdict in general.
    expect(statuses(run(sig(VOICINGS.G, FRAME_SIZE * 8), { expected: C }))).toContain('wrong');
  });
});

describe('false positives are rejected across the whole state machine', () => {
  /** Nothing in this list may ever reach 'confirmed'. */
  const mustNeverConfirm: Array<[string, Float32Array, ChordSpec]> = [
    ['C5 power chord', sig(VOICINGS.C5, FRAME_SIZE * 10), C],
    ['E5 power chord', sig(VOICINGS.E5, FRAME_SIZE * 10), { root: 4, quality: 'minor' }],
    ['single low E', sig([40], FRAME_SIZE * 10), { root: 4, quality: 'minor' }],
    ['single C3', sig([48], FRAME_SIZE * 10), C],
    ['octaves only', sig([48, 60], FRAME_SIZE * 10), C],
    ['third muted', sig(VOICINGS.C_noThird, FRAME_SIZE * 10), C],
    ['stray F added', sig(VOICINGS.C_wrongNote, FRAME_SIZE * 10), C],
    ['Csus4 for C', sig(VOICINGS.Csus4, FRAME_SIZE * 10), C],
    ['A major for Am', sig(VOICINGS.A, FRAME_SIZE * 10), Am],
    ['Am for A major', sig(VOICINGS.Am, FRAME_SIZE * 10), { root: 9, quality: 'major' }],
    ['E major for Em', sig(VOICINGS.E, FRAME_SIZE * 10), { root: 4, quality: 'minor' }],
    ['G played, C wanted', sig(VOICINGS.G, FRAME_SIZE * 10), C],
    ['broadband noise', addNoise(new Float32Array(FRAME_SIZE * 10), 0.08), C],
    ['loud broadband noise', addNoise(new Float32Array(FRAME_SIZE * 10), 0.3), C],
    ['mains hum alone', addHum(new Float32Array(FRAME_SIZE * 10), 0.06, SR), C],
    ['hum over a power chord', addHum(sig(VOICINGS.C5, FRAME_SIZE * 10), 0.03, SR), C],
    ['noise over a muted third', addNoise(sig(VOICINGS.C_noThird, FRAME_SIZE * 10), 0.02), C],
    ['chord below the gate', scale(sig(VOICINGS.C, FRAME_SIZE * 10), 0.002), C],
  ];

  it.each(mustNeverConfirm)('never confirms: %s', (_label, signal, expected) => {
    expect(statuses(run(signal, { expected }))).not.toContain('confirmed');
  });

  it.each(mustNeverConfirm)('never claims stability for: %s', (_label, signal, expected) => {
    // Stability reaching 1 is what confirmation is built on; if it ever gets
    // there for one of these, confirmation is one frame away.
    expect(run(signal, { expected }).every((d) => d.stability < 1)).toBe(true);
  });

  it.each([32000, 44100, 48000])('rejects a power chord at %i Hz over time', (rate) => {
    const analyzer = new FrameAnalyzer(FRAME_SIZE);
    const decider = new ChordDecider();
    const signal = chord([...VOICINGS.C5], FRAME_SIZE * 10, rate, {
      amplitude: 0.25,
      harmonics: 8,
    });
    const hopMs = (HOP_SIZE / rate) * 1000;
    const out: ChordStatus[] = [];
    frames(signal, FRAME_SIZE, HOP_SIZE).forEach((frame, i) => {
      const observation = analyzer.analyze(frame, rate, 0.0005);
      out.push(
        decider.update({ chroma: observation.chroma, rms: observation.rms, now: i * hopMs }, C)
          .status,
      );
    });
    expect(out).not.toContain('confirmed');
  });

  it.each([32000, 44100, 48000])('still confirms a real C at %i Hz', (rate) => {
    const analyzer = new FrameAnalyzer(FRAME_SIZE);
    const decider = new ChordDecider();
    const signal = chord([...VOICINGS.C], FRAME_SIZE * 10, rate, {
      amplitude: 0.25,
      harmonics: 8,
    });
    const hopMs = (HOP_SIZE / rate) * 1000;
    const out: ChordStatus[] = [];
    frames(signal, FRAME_SIZE, HOP_SIZE).forEach((frame, i) => {
      const observation = analyzer.analyze(frame, rate, 0.0005);
      out.push(
        decider.update({ chroma: observation.chroma, rms: observation.rms, now: i * hopMs }, C)
          .status,
      );
    });
    expect(out).toContain('confirmed');
  });

  it('does not confirm a wrong chord played immediately after a correct one', () => {
    // No silence in between, so the smoothed chroma crosses the boundary. The
    // blend must not keep confirming C once the player has moved to G.
    const decider = new ChordDecider();
    const decisions = run(
      concat(sig(VOICINGS.C, FRAME_SIZE * 8), sig(VOICINGS.G, FRAME_SIZE * 8)),
      { decider, expected: C },
    );
    expect(statuses(decisions.slice(-5))).not.toContain('confirmed');
  });

  it.each([1, 2, 4, 8])(
    'confirms a new chord after a %i-frame silence without inheriting the old one',
    (gapFrames) => {
      const decider = new ChordDecider();
      const decisions = run(
        concat(
          sig(VOICINGS.C, FRAME_SIZE * 4),
          silence(FRAME_SIZE * gapFrames),
          sig(VOICINGS.G, FRAME_SIZE * 6),
        ),
        { decider, expected: G },
      );
      // The C section must never read as a G...
      const firstConfirmed = decisions.findIndex((d) => d.status === 'confirmed');
      expect(firstConfirmed).toBeGreaterThan(-1);
      // ...and confirmation must only arrive well after the silence.
      expect(decisions.slice(0, 4).every((d) => d.status !== 'confirmed')).toBe(true);
    },
  );
});

describe('missing-tone advice cannot leak out of the incomplete state', () => {
  const scenarios: Array<[string, Float32Array, ChordSpec]> = [
    ['a different chord', sig(VOICINGS.G, FRAME_SIZE * 8), C],
    ['major/minor confusion', sig(VOICINGS.A, FRAME_SIZE * 8), Am],
    ['broadband noise', addNoise(new Float32Array(FRAME_SIZE * 8), 0.08), C],
    ['mains hum', addHum(new Float32Array(FRAME_SIZE * 8), 0.06, SR), C],
    ['silence', silence(FRAME_SIZE * 8), C],
    ['a correct chord', sig(VOICINGS.C, FRAME_SIZE * 8), C],
    ['a ringing seventh', sig(VOICINGS.C_ringingSeventh, FRAME_SIZE * 8), C],
    ['a stray F', sig(VOICINGS.C_wrongNote, FRAME_SIZE * 8), C],
  ];

  it.each(scenarios)('offers no advice outside incomplete: %s', (_label, signal, expected) => {
    for (const d of run(signal, { expected })) {
      if (d.status !== 'incomplete') expect(d.missing).toBeNull();
    }
  });

  it('never names a missing tone while calibrating', () => {
    const decider = new ChordDecider();
    decider.beginCalibration();
    for (const d of run(sig(VOICINGS.C_noThird, FRAME_SIZE * 8), { decider, expected: C })) {
      if (d.status === 'calibrating') expect(d.missing).toBeNull();
    }
  });
});
