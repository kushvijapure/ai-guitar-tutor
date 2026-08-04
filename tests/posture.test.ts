import { describe, expect, it } from 'vitest';
import {
  activeFingersFor,
  analyzePosture,
  LandmarkSmoother,
  resolveHandedness,
  toIsotropic,
  type FingerName,
  type Landmark,
} from '../src/lib/posture';
import { OPEN_CHORDS } from '../src/lessons/openChords';
import { POSTURE_WARMUP_FRAMES } from '../src/lib/thresholds';
import { corrupt, makeHand, makeWorldHand, truncate } from './hands';

const ASPECT = 16 / 9;

/** Analyze with the defaults the tests mostly want: warmed up, confident. */
function analyze(landmarks: Landmark[], activeFingers: FingerName[], extra = {}) {
  return analyzePosture({
    landmarks,
    aspect: ASPECT,
    confidence: 0.95,
    framesObserved: POSTURE_WARMUP_FRAMES,
    activeFingers,
    ...extra,
  });
}

describe('activeFingersFor', () => {
  it('extracts only the fingers a chord actually frets', () => {
    // Em is 022000 fingered with middle and ring.
    const em = OPEN_CHORDS.find((c) => c.id === 'em')!;
    expect(activeFingersFor(em.fingers)).toEqual(['middle', 'ring']);
  });

  it('handles a chord using three fingers', () => {
    const c = OPEN_CHORDS.find((c) => c.id === 'c')!;
    expect(activeFingersFor(c.fingers)).toEqual(['index', 'middle', 'ring']);
  });

  it('returns nothing for an all-open shape', () => {
    expect(activeFingersFor([0, null, null, null, null, null])).toEqual([]);
  });
});

describe('chord-aware finger selection', () => {
  it('does not warn about a flat finger the chord does not use', () => {
    // Index is lying dead flat, but Em only frets middle and ring.
    const hand = makeHand({ angles: { index: 179, middle: 120, ring: 120, pinky: 179 } });
    const report = analyze(hand, ['middle', 'ring']);

    expect(report.quality).toBe('ok');
    expect(report.cues.some((c) => c.id.startsWith('flat'))).toBe(false);
    expect(report.measurements.index).toBeUndefined();
    expect(report.measurements.pinky).toBeUndefined();
  });

  it('does warn about a flat finger the chord does use', () => {
    const hand = makeHand({ angles: { index: 120, middle: 179, ring: 120, pinky: 120 } });
    const report = analyze(hand, ['middle', 'ring']);

    expect(report.quality).toBe('ok');
    const cue = report.cues.find((c) => c.id === 'flat-middle');
    expect(cue).toBeDefined();
    expect(cue!.severity).toBe('warn');
  });

  it('escalates when two active fingers are flat', () => {
    const hand = makeHand({ angles: { middle: 175, ring: 172 } });
    const report = analyze(hand, ['middle', 'ring']);
    expect(report.cues.find((c) => c.id === 'flat-fingers')?.severity).toBe('bad');
  });

  it('only measures the active fingers', () => {
    const hand = makeHand();
    const report = analyze(hand, ['index', 'ring']);
    expect(Object.keys(report.measurements).sort()).toEqual(['index', 'ring']);
    expect(report.assessedFingers).toEqual(['index', 'ring']);
  });
});

describe('PIP angle measurement', () => {
  it('uses MCP -> PIP -> DIP and recovers the true angle', () => {
    for (const trueAngle of [95, 120, 150, 170]) {
      const hand = makeHand({ angles: { middle: trueAngle } });
      const report = analyze(hand, ['middle']);
      expect(report.measurements.middle!.reliable).toBe(true);
      expect(report.measurements.middle!.angle).toBeCloseTo(trueAngle, 0);
    }
  });

  it('is unaffected by a non-square frame, because y is rescaled', () => {
    // The same hand encoded for a 16:9 and a 4:3 camera must measure the same.
    const wide = analyze(makeHand({ angles: { middle: 130 }, aspect: 16 / 9 }), ['middle']);
    const narrow = analyzePosture({
      landmarks: makeHand({ angles: { middle: 130 }, aspect: 4 / 3 }),
      aspect: 4 / 3,
      confidence: 0.95,
      framesObserved: POSTURE_WARMUP_FRAMES,
      activeFingers: ['middle'],
    });

    expect(wide.measurements.middle!.angle).toBeCloseTo(130, 0);
    expect(narrow.measurements.middle!.angle).toBeCloseTo(130, 0);
  });

  it('would be wrong without aspect correction — proving the correction matters', () => {
    // Feed raw image landmarks through as if they were already isotropic.
    const raw = makeHand({ angles: { middle: 130 }, aspect: 16 / 9 });
    const uncorrected = toIsotropic(raw, 1); // i.e. no correction at all
    const mcp = uncorrected[9];
    const pip = uncorrected[10];
    const dip = uncorrected[11];
    const v1 = { x: mcp.x - pip.x, y: mcp.y - pip.y };
    const v2 = { x: dip.x - pip.x, y: dip.y - pip.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const skewed =
      (Math.acos(dot / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y))) * 180) / Math.PI;

    // Skewed by enough to cross a cue threshold — this is the bug being fixed.
    expect(Math.abs(skewed - 130)).toBeGreaterThan(8);
  });

  it('prefers world landmarks when supplied', () => {
    const report = analyzePosture({
      landmarks: makeHand({ angles: { middle: 100 } }),
      worldLandmarks: makeWorldHand({ angles: { middle: 145 } }),
      aspect: ASPECT,
      confidence: 0.95,
      framesObserved: POSTURE_WARMUP_FRAMES,
      activeFingers: ['middle'],
    });
    expect(report.measurements.middle!.angle).toBeCloseTo(145, 0);
  });
});

describe('extreme angles', () => {
  it('flags an over-curled finger', () => {
    const hand = makeHand({ angles: { middle: 60 } });
    const report = analyze(hand, ['middle']);
    expect(report.cues.some((c) => c.id === 'over-curled')).toBe(true);
  });

  it('handles a fully straight finger without producing NaN', () => {
    const hand = makeHand({ angles: { middle: 180 } });
    const report = analyze(hand, ['middle']);
    expect(Number.isFinite(report.measurements.middle!.angle)).toBe(true);
    expect(report.measurements.middle!.angle).toBeCloseTo(180, 0);
  });

  it('never praises a hand that has a problem', () => {
    const hand = makeHand({ angles: { middle: 179, ring: 120 } });
    const report = analyze(hand, ['middle', 'ring']);
    expect(report.cues.some((c) => c.severity === 'good')).toBe(false);
  });
});

describe('reliability gating', () => {
  it('reports unreliable when landmarks are missing entirely', () => {
    const report = analyze(truncate(makeHand(), 10), ['middle']);
    expect(report.quality).toBe('unreliable');
    expect(report.cues).toHaveLength(0);
  });

  it('reports unreliable when a needed landmark is NaN', () => {
    const report = analyze(corrupt(makeHand(), 10), ['middle']);
    expect(report.quality).toBe('unreliable');
    expect(report.cues).toHaveLength(0);
  });

  it('ignores a NaN landmark belonging to an unused finger', () => {
    // Index PIP is corrupt, but the chord only needs middle and ring.
    const report = analyze(corrupt(makeHand(), 6), ['middle', 'ring']);
    expect(report.quality).toBe('ok');
  });

  it('reports unreliable before the smoother has warmed up', () => {
    const report = analyze(makeHand(), ['middle'], { framesObserved: POSTURE_WARMUP_FRAMES - 1 });
    expect(report.quality).toBe('unreliable');
    expect(report.reason).toMatch(/steady read/i);
  });

  it('reports unreliable when tracking confidence is low', () => {
    const report = analyze(makeHand(), ['middle'], { confidence: 0.4 });
    expect(report.quality).toBe('unreliable');
    expect(report.cues).toHaveLength(0);
  });

  it('reports unreliable when the hand is clipped at the frame edge', () => {
    const report = analyze(makeHand({ offset: { x: -0.45, y: 0 } }), ['middle']);
    expect(report.quality).toBe('unreliable');
    expect(report.reason).toMatch(/edge of the frame/i);
  });

  it('reports unreliable when the hand is too far away', () => {
    const report = analyze(makeHand({ scale: 0.2 }), ['middle']);
    expect(report.quality).toBe('unreliable');
    expect(report.reason).toMatch(/too far/i);
  });

  it('marks a severely foreshortened finger unreliable rather than guessing', () => {
    // Middle phalanx projects to a fraction of the proximal one.
    const hand = makeHand({ shorten: { middle: 0.02 } });
    const report = analyze(hand, ['middle']);
    expect(report.measurements.middle?.reliable).toBe(false);
    expect(report.quality).toBe('unreliable');
  });

  it('never emits praise when an active finger could not be measured', () => {
    const hand = makeHand({ angles: { middle: 120, ring: 120 }, shorten: { ring: 0.02 } });
    const report = analyze(hand, ['middle', 'ring']);
    expect(report.cues.some((c) => c.severity === 'good')).toBe(false);
    expect(report.cues.some((c) => c.id === 'partial')).toBe(true);
  });

  it('praises only when every active finger checked out', () => {
    const hand = makeHand({ angles: { middle: 120, ring: 125 } });
    const report = analyze(hand, ['middle', 'ring']);
    expect(report.cues[0].severity).toBe('good');
  });
});

describe('claims we cannot support', () => {
  it('makes no claim about the fretboard, which it cannot see', () => {
    const hand = makeHand();
    const report = analyze(hand, ['middle', 'ring']);
    const text = report.cues.map((c) => c.message).join(' ');
    expect(text).not.toMatch(/parallel to the fretboard/i);
  });

  it('marks wrist and thumb observations as tentative, never as corrections', () => {
    // A steeply angled knuckle line, which the old code called a wrist error.
    const hand = makeHand();
    hand[5] = { x: 0.45, y: 0.30 * ASPECT, z: 0 };
    hand[17] = { x: 0.47, y: 0.55 * ASPECT, z: 0 };
    const report = analyze(hand, ['middle', 'ring']);

    for (const cue of report.cues) {
      if (cue.id === 'palm-rolled' || cue.id === 'thumb-extended') {
        expect(cue.tentative).toBe(true);
        expect(cue.severity).toBe('info');
      }
    }
  });
});

describe('resolveHandedness', () => {
  // MediaPipe assumes a mirrored (selfie) input. We feed it the raw video, so
  // its labels arrive inverted and must be flipped back.
  it('flips the label when the input was not mirrored', () => {
    expect(resolveHandedness('Left', false)).toBe('Right');
    expect(resolveHandedness('Right', false)).toBe('Left');
  });

  it('passes the label through when the input was mirrored', () => {
    expect(resolveHandedness('Left', true)).toBe('Left');
    expect(resolveHandedness('Right', true)).toBe('Right');
  });

  it('leaves unknown labels alone', () => {
    expect(resolveHandedness('Unknown', false)).toBe('Unknown');
  });
});

describe('LandmarkSmoother', () => {
  it('counts frames and reports warmup progress', () => {
    const smoother = new LandmarkSmoother(0.5);
    expect(smoother.framesObserved()).toBe(0);
    smoother.push(makeHand());
    expect(smoother.framesObserved()).toBe(1);
    smoother.push(makeHand());
    expect(smoother.framesObserved()).toBe(2);
  });

  it('damps jitter', () => {
    const smoother = new LandmarkSmoother(0.8);
    const steady = makeHand({ angles: { middle: 120 } });
    for (let i = 0; i < 20; i++) smoother.push(steady);

    // One badly jittered frame should barely move the smoothed output.
    const jittered = makeHand({ angles: { middle: 175 } });
    const out = smoother.push(jittered)!;
    const before = steady[10];
    expect(Math.abs(out[10].x - before.x)).toBeLessThan(0.02);
  });

  it('resets when tracking is lost', () => {
    const smoother = new LandmarkSmoother();
    smoother.push(makeHand());
    smoother.push(null);
    expect(smoother.framesObserved()).toBe(0);
  });
});
