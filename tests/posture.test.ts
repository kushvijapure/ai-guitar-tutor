import { describe, expect, it } from 'vitest';
import {
  activeFingersFor,
  analyzePosture,
  LandmarkSmoother,
  resolveHandedness,
  selectFrettingHand,
  toIsotropic,
  unassessable,
  type FingerName,
  type Landmark,
} from '../src/lib/posture';
import { OPEN_CHORDS } from '../src/lessons/openChords';
import {
  FLAT_FINGER_ANGLE,
  MIN_HAND_CONFIDENCE,
  POSTURE_WARMUP_FRAMES,
} from '../src/lib/thresholds';
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
    expect(resolveHandedness('', true)).toBe('');
  });

  it('is its own inverse for unmirrored input', () => {
    // Applying the correction twice must return the original label, or the
    // convention is not a simple mirror and the reasoning behind it is wrong.
    for (const label of ['Left', 'Right']) {
      expect(resolveHandedness(resolveHandedness(label, false), false)).toBe(label);
    }
  });
});

/**
 * Handedness end to end, which is the part most likely to be silently wrong.
 *
 * These tests encode MediaPipe's *documented* convention — handedness is
 * reported as if the input image were mirrored — as a model, then assert that
 * resolveHandedness + selectFrettingHand compose to recover the physically
 * correct hand. They therefore verify the code is self-consistent with the
 * documented convention. They CANNOT verify the convention itself; only a real
 * camera and a real hand can do that.
 */
describe('fretting-hand selection, end to end', () => {
  type Physical = 'Left' | 'Right';

  /** What MediaPipe labels a given physical hand, per its documented convention. */
  function labelFor(physical: Physical, inputMirrored: boolean): string {
    if (inputMirrored) return physical;
    return physical === 'Left' ? 'Right' : 'Left';
  }

  /** Build the tracked-hand list the hook would build, tagged with ground truth. */
  function track(physicals: Physical[], inputMirrored: boolean) {
    return physicals.map((physical) => ({
      physical,
      handedness: resolveHandedness(labelFor(physical, inputMirrored), inputMirrored),
    }));
  }

  for (const inputMirrored of [false, true]) {
    const mode = inputMirrored ? 'mirrored' : 'unmirrored';

    it(`picks the physical left hand for a right-handed player (${mode} input)`, () => {
      // Standard right-handed player: frets with the left hand.
      const hands = track(['Left', 'Right'], inputMirrored);
      const chosen = selectFrettingHand(hands, 'Left');

      expect(chosen.index).toBe(0);
      expect(hands[chosen.index].physical).toBe('Left');
    });

    it(`picks the physical right hand for a left-handed player (${mode} input)`, () => {
      // Left-handed player on a left-handed guitar: frets with the right hand.
      const hands = track(['Left', 'Right'], inputMirrored);
      const chosen = selectFrettingHand(hands, 'Right');

      expect(chosen.index).toBe(1);
      expect(hands[chosen.index].physical).toBe('Right');
    });

    it(`works when only the fretting hand is visible (${mode} input)`, () => {
      // The common case: the strumming hand is out of shot below the frame.
      const hands = track(['Left'], inputMirrored);
      expect(hands[selectFrettingHand(hands, 'Left').index].physical).toBe('Left');
    });

    it(`does not select the strumming hand when it is the only one visible (${mode})`, () => {
      const hands = track(['Right'], inputMirrored);
      const chosen = selectFrettingHand(hands, 'Left');

      expect(chosen.index).toBe(-1);
      // Not an "unable to assess" state — the panel says "no hand in frame".
      expect(chosen.reason).toBeNull();
    });

    it(`is not affected by detection order (${mode} input)`, () => {
      const hands = track(['Right', 'Left'], inputMirrored);
      expect(hands[selectFrettingHand(hands, 'Left').index].physical).toBe('Left');
    });
  }

  it('declines when two hands both claim to be the fretting hand', () => {
    // MediaPipe does mislabel both hands the same way when one is occluded,
    // which on a guitar is routine. Picking the first would be a coin flip.
    const hands = [{ handedness: 'Left' }, { handedness: 'Left' }];
    const chosen = selectFrettingHand(hands, 'Left');

    expect(chosen.index).toBe(-1);
    expect(chosen.reason).toMatch(/can't tell which one/i);
  });

  it('declines for a left-handed player when both hands read as Right', () => {
    const hands = [{ handedness: 'Right' }, { handedness: 'Right' }];
    expect(selectFrettingHand(hands, 'Right').index).toBe(-1);
  });

  it('still selects when the ambiguity is on the other hand', () => {
    // Two 'Right' and one 'Left': the fretting hand is unambiguous.
    const hands = [{ handedness: 'Right' }, { handedness: 'Left' }, { handedness: 'Right' }];
    expect(selectFrettingHand(hands, 'Left').index).toBe(1);
  });

  it('returns nothing when no hand is detected at all', () => {
    expect(selectFrettingHand([], 'Left')).toEqual({ index: -1, reason: null });
  });

  it('never matches an unclassified hand', () => {
    const hands = [{ handedness: 'Unknown' }, { handedness: 'Unknown' }];
    expect(selectFrettingHand(hands, 'Left').index).toBe(-1);
    expect(selectFrettingHand(hands, 'Right').index).toBe(-1);
  });
});

describe('unassessable', () => {
  it('produces a silent, cue-free report', () => {
    const report = unassessable('two hands look alike', ['middle', 'ring']);
    expect(report.quality).toBe('unreliable');
    expect(report.reason).toBe('two hands look alike');
    expect(report.cues).toEqual([]);
    expect(report.assessedFingers).toEqual(['middle', 'ring']);
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

  it('restarts warmup after a dropout, so no verdict rides on stale landmarks', () => {
    const smoother = new LandmarkSmoother(0.65);
    for (let i = 0; i < POSTURE_WARMUP_FRAMES + 3; i++) smoother.push(makeHand());
    expect(smoother.framesObserved()).toBeGreaterThanOrEqual(POSTURE_WARMUP_FRAMES);

    smoother.push(null);
    smoother.push(makeHand());
    expect(smoother.framesObserved()).toBe(1);

    // ...and that first post-dropout frame must not be judged.
    const report = analyze(makeHand(), ['middle'], { framesObserved: 1 });
    expect(report.quality).toBe('unreliable');
  });

  it('starts a differently-sized landmark set from scratch rather than blending', () => {
    const smoother = new LandmarkSmoother(0.65);
    smoother.push(makeHand());
    smoother.push(truncate(makeHand(), 10));
    expect(smoother.framesObserved()).toBe(1);
  });
});

describe('unused fingers are never judged', () => {
  it('does not report a partial read for an unmeasurable finger the chord skips', () => {
    // The pinky is foreshortened into uselessness, but Em does not use it.
    const hand = makeHand({ angles: { middle: 120, ring: 122 }, shorten: { pinky: 0.02 } });
    const report = analyze(hand, ['middle', 'ring']);

    expect(report.quality).toBe('ok');
    expect(report.cues.some((c) => c.id === 'partial')).toBe(false);
    // Praise is still legitimate: every finger being judged checked out.
    expect(report.cues[0].severity).toBe('good');
  });

  it('does not warn about an over-curled finger the chord skips', () => {
    const hand = makeHand({ angles: { index: 40, pinky: 35, middle: 120, ring: 120 } });
    const report = analyze(hand, ['middle', 'ring']);
    expect(report.cues.some((c) => c.id === 'over-curled')).toBe(false);
  });

  it('judges all four when the shape needs all four', () => {
    const hand = makeHand({ angles: { index: 179, middle: 120, ring: 120, pinky: 120 } });
    const report = analyze(hand, ['index', 'middle', 'ring', 'pinky']);

    expect(report.assessedFingers).toHaveLength(4);
    expect(report.cues.find((c) => c.id === 'flat-index')?.severity).toBe('warn');
  });

  it('assesses exactly the fingers it says it assessed', () => {
    for (const active of [['index'], ['middle', 'ring'], ['index', 'middle', 'ring', 'pinky']] as FingerName[][]) {
      const report = analyze(makeHand(), active);
      expect(report.assessedFingers).toEqual(active);
      expect(Object.keys(report.measurements).sort()).toEqual([...active].sort());
    }
  });
});

describe('threshold boundaries', () => {
  it('does not warn just under the flat-finger threshold', () => {
    const report = analyze(makeHand({ angles: { middle: FLAT_FINGER_ANGLE - 2 } }), ['middle']);
    expect(report.cues.some((c) => c.id.startsWith('flat'))).toBe(false);
  });

  it('warns just over the flat-finger threshold', () => {
    const report = analyze(makeHand({ angles: { middle: FLAT_FINGER_ANGLE + 2 } }), ['middle']);
    expect(report.cues.some((c) => c.id === 'flat-middle')).toBe(true);
  });

  it('accepts confidence exactly at the gate', () => {
    const report = analyze(makeHand(), ['middle'], { confidence: MIN_HAND_CONFIDENCE });
    expect(report.quality).toBe('ok');
  });

  it('rejects confidence just below the gate', () => {
    const report = analyze(makeHand(), ['middle'], { confidence: MIN_HAND_CONFIDENCE - 0.01 });
    expect(report.quality).toBe('unreliable');
  });

  it('accepts the first frame that completes warmup', () => {
    const report = analyze(makeHand(), ['middle'], { framesObserved: POSTURE_WARMUP_FRAMES });
    expect(report.quality).toBe('ok');
  });

  it('declines a confidence of zero', () => {
    const report = analyze(makeHand(), ['middle'], { confidence: 0 });
    expect(report.quality).toBe('unreliable');
  });
});

describe('extreme and degenerate input', () => {
  it('declines a hand clipped at each frame edge in turn', () => {
    const offsets = [
      { x: -0.45, y: 0 },
      { x: 0.45, y: 0 },
      { x: 0, y: -0.45 },
      { x: 0, y: 0.28 },
    ];
    for (const offset of offsets) {
      const report = analyze(makeHand({ offset }), ['middle', 'ring']);
      expect(report.quality).toBe('unreliable');
      expect(report.cues).toEqual([]);
    }
  });

  it('refuses an anatomically impossible joint angle instead of coaching it', () => {
    // A PIP cannot fold to 5 degrees. Reading one means the landmarks are
    // wrong, so "you are over-curling" would be confident advice built on noise.
    const report = analyze(makeHand({ angles: { middle: 5 } }), ['middle']);

    expect(report.measurements.middle?.reliable).toBe(false);
    expect(report.measurements.middle?.reason).toMatch(/anatomic/i);
    expect(report.quality).toBe('unreliable');
    expect(report.cues).toEqual([]);
  });

  it('still coaches a genuinely tight but possible finger', () => {
    // 70 degrees is near the real anatomical limit: tight enough to be worth a
    // cue, but a shape a hand can actually make. The plausibility gate must not
    // swallow this — it only exists to catch the impossible.
    const report = analyze(makeHand({ angles: { middle: 70 } }), ['middle']);

    expect(report.quality).toBe('ok');
    expect(report.measurements.middle?.reliable).toBe(true);
    expect(report.cues.some((c) => c.id === 'over-curled')).toBe(true);
  });

  it('does not let one impossible finger poison a measurable one', () => {
    const report = analyze(makeHand({ angles: { middle: 120, ring: 5 } }), ['middle', 'ring']);

    expect(report.quality).toBe('ok');
    expect(report.measurements.middle?.reliable).toBe(true);
    expect(report.measurements.ring?.reliable).toBe(false);
    // Partial read: no praise, and an explicit note about the finger it missed.
    expect(report.cues.some((c) => c.severity === 'good')).toBe(false);
    expect(report.cues.some((c) => c.id === 'partial')).toBe(true);
  });

  it('declines an empty landmark array', () => {
    expect(analyze([], ['middle']).quality).toBe('unreliable');
  });

  it('declines when one landmark short of a full hand', () => {
    expect(analyze(truncate(makeHand(), 20), ['middle']).quality).toBe('unreliable');
  });

  it('declines when the wrist itself is corrupt', () => {
    // The wrist sets the hand scale everything else is measured against.
    expect(analyze(corrupt(makeHand(), 0), ['middle']).quality).toBe('unreliable');
  });

  it('declines a chord that frets nothing rather than praising an idle hand', () => {
    const report = analyze(makeHand(), []);
    expect(report.quality).toBe('unreliable');
    expect(report.cues).toEqual([]);
  });
});

describe('the core invariant: uncertainty is never dressed up as a verdict', () => {
  /** Every way we know of to make the input untrustworthy. */
  const untrustworthy: Array<[string, () => ReturnType<typeof analyze>]> = [
    ['no landmarks', () => analyze([], ['middle'])],
    ['partial landmarks', () => analyze(truncate(makeHand(), 12), ['middle'])],
    ['corrupt wrist', () => analyze(corrupt(makeHand(), 0), ['middle'])],
    ['corrupt active joint', () => analyze(corrupt(makeHand(), 10), ['middle'])],
    ['low confidence', () => analyze(makeHand(), ['middle'], { confidence: 0.3 })],
    ['not warmed up', () => analyze(makeHand(), ['middle'], { framesObserved: 0 })],
    ['clipped at edge', () => analyze(makeHand({ offset: { x: -0.45, y: 0 } }), ['middle'])],
    ['too far away', () => analyze(makeHand({ scale: 0.2 }), ['middle'])],
    ['foreshortened', () => analyze(makeHand({ shorten: { middle: 0.02 } }), ['middle'])],
    ['no fretted fingers', () => analyze(makeHand(), [])],
  ];

  for (const [name, run] of untrustworthy) {
    it(`emits neither correction nor praise: ${name}`, () => {
      const report = run();
      expect(report.quality).toBe('unreliable');
      // Not one cue of any severity — no correction, and crucially no praise.
      expect(report.cues).toEqual([]);
      // ...and it says why, so the player can fix the setup.
      expect(report.reason).toBeTruthy();
    });
  }

  it('never praises and corrects in the same breath', () => {
    const shapes: Array<Partial<Record<FingerName, number>>> = [
      { middle: 120, ring: 125 },
      { middle: 179, ring: 125 },
      { middle: 60, ring: 125 },
      { middle: 179, ring: 176 },
      { middle: 90, ring: 90 },
    ];
    for (const angles of shapes) {
      const report = analyze(makeHand({ angles }), ['middle', 'ring']);
      const praised = report.cues.some((c) => c.severity === 'good');
      const corrected = report.cues.some((c) => c.severity === 'warn' || c.severity === 'bad');
      expect(praised && corrected).toBe(false);
    }
  });

  it('only ever praises fingers it actually measured', () => {
    const report = analyze(makeHand({ angles: { middle: 120, ring: 120 } }), ['middle', 'ring']);
    const praise = report.cues.find((c) => c.severity === 'good');
    expect(praise).toBeDefined();
    for (const finger of report.assessedFingers) {
      expect(report.measurements[finger]?.reliable).toBe(true);
    }
  });
});
