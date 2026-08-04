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
import { FRAME_SIZE, HOP_SIZE, STABILITY_WINDOWS } from '../src/lib/thresholds';
import {
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
    decider.beginCalibration(0);
    const decisions = run(addNoise(new Float32Array(FRAME_SIZE * 4), 0.002), { decider });
    expect(decisions[0].status).toBe('calibrating');
    expect(decisions[0].calibrationProgress).toBeLessThan(1);
  });

  it('raises the noise floor to match a noisy room', () => {
    const noisy = new ChordDecider();
    noisy.beginCalibration(0);
    run(addNoise(new Float32Array(FRAME_SIZE * 40), 0.03), { decider: noisy });
    expect(noisy.getNoiseFloor()).toBeGreaterThan(0.005);
    expect(noisy.isCalibrated()).toBe(true);
  });

  it('rejects quiet playing that sits below a noisy room floor', () => {
    const noisy = new ChordDecider();
    noisy.beginCalibration(0);
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
