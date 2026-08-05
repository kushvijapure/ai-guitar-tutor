/**
 * Regression guard for the wrist-continuity backstop in FrettingHandTracker.
 *
 * Identity is checked three ways: the fretting-hand setting, the index in the
 * detection list, and this wrist-continuity threshold. The first two are exact.
 * The third is a threshold, and a threshold has a far side — inside it, two
 * genuinely different hands are blended into the smoother and can be coached.
 *
 * Review measured that far side at HAND_IDENTITY_JUMP_RATIO = 1.0 and found the
 * original false accept reproducing bit-for-bit below it: two frames of "your
 * fingers look well arched" about flat fingers. The ratio was tightened to 0.5.
 *
 * This file began as that measurement and is now assertion. It pins three
 * things: that the fixed region really is fixed, that the *remaining* window is
 * the size we think it is, and that the guard is isotropic. Started descriptive
 * so it could not fail; that is exactly why it had to be rewritten once the
 * ratio was settled — a test that cannot fail is worse than no test.
 *
 * HONEST FRAMING: tightening halved the contamination window. It did not remove
 * it, and no threshold can. The residual below is real and deliberately
 * asserted rather than hidden, so that loosening the ratio breaks this file.
 */

/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import { analyzePosture } from '../src/lib/posture';
import type { FingerName, Landmark } from '../src/lib/posture';
import { POSTURE_WARMUP_FRAMES } from '../src/lib/thresholds';
import { FrettingHandTracker } from '../src/hooks/useHandTracking';
import { makeHand } from './hands';

const ACTIVE: FingerName[] = ['index', 'middle', 'ring'];
const ASPECT = 16 / 9;

/** The fixture's palm length (wrist -> middle MCP) in isotropic units. */
const PALM = 0.25;
/** Mirrors HAND_IDENTITY_JUMP_RATIO, which is module-private in the hook. */
const RATIO = 0.5;
/** Wrist displacement at which the guard should begin firing. */
const THRESHOLD = PALM * RATIO;

const arched = makeHand({ angles: { index: 120, middle: 120, ring: 120 }, aspect: ASPECT });

/** A different, flat hand, displaced by `dx`/`dy` isotropic units. */
const flatAt = (dx: number, dy = 0) =>
  makeHand({ angles: { index: 178, middle: 178, ring: 178 }, aspect: ASPECT, offset: { x: dx, y: dy } });

function warmUp(t: FrettingHandTracker, lm: Landmark[], n = 10) {
  for (let i = 0; i < n; i++) t.track({ frettingHand: 'Left', index: 0, landmarks: lm, aspect: ASPECT });
}

/** Frames of "looks good" produced when a different hand appears at `dx`. */
function falsePraiseFrames(dx: number): number {
  const t = new FrettingHandTracker();
  warmUp(t, arched);
  let praised = 0;
  for (let i = 0; i < 6; i++) {
    const f = t.track({ frettingHand: 'Left', index: 0, landmarks: flatAt(dx), aspect: ASPECT })!;
    const r = analyzePosture({
      landmarks: f.landmarks,
      aspect: ASPECT,
      confidence: 0.95,
      activeFingers: ACTIVE,
      framesObserved: f.framesObserved,
    });
    if (r.quality === 'ok' && r.cues.some((c) => c.id === 'looks-good')) praised++;
  }
  return praised;
}

describe('wrist guard: the fixed region', () => {
  // Every separation at or above the threshold must restart warmup, which makes
  // the next POSTURE_WARMUP_FRAMES report 'unreliable' instead of praising.
  for (const dx of [0.13, 0.15, 0.2, 0.3, 0.45]) {
    it(`produces no false praise at ${(dx / PALM).toFixed(2)} palm-lengths`, () => {
      expect(dx).toBeGreaterThan(THRESHOLD);
      expect(falsePraiseFrames(dx)).toBe(0);
    });
  }

  it('restarts warmup rather than decaying the previous hand into the new one', () => {
    const t = new FrettingHandTracker();
    warmUp(t, arched);
    const f = t.track({ frettingHand: 'Left', index: 0, landmarks: flatAt(0.2), aspect: ASPECT })!;
    expect(f.framesObserved).toBe(1);
  });
});

describe('wrist guard: the residual that tightening did not remove', () => {
  // Asserted, not hidden. Two different hands whose wrists land within half a
  // palm-length of each other are still blended, because nothing else
  // distinguishes them once the setting and the detection index both match.
  // Reachable only when the strumming hand is mislabelled into the fretting
  // slot AND lands very close to where the fretting hand was.
  it('still blends two hands inside the threshold', () => {
    const inside = 0.1;
    expect(inside).toBeLessThan(THRESHOLD);
    expect(falsePraiseFrames(inside)).toBeGreaterThan(0);
  });

  it('bounds the residual: the window is half a palm-length, not a whole one', () => {
    // Pins the tightening itself. At the old ratio of 1.0 this separation
    // blended and produced false praise; it must not any more.
    const oldWindowOnly = 0.2;
    expect(oldWindowOnly).toBeGreaterThan(THRESHOLD);
    expect(oldWindowOnly).toBeLessThan(PALM * 1.0);
    expect(falsePraiseFrames(oldWindowOnly)).toBe(0);
  });
});

describe('wrist guard: isotropy', () => {
  // The bug camera-runtime caught in its own first cut: in raw normalized coords
  // a vertical displacement is divided by height and a horizontal one by width,
  // so on 16:9 the guard was ~1.78x looser in one axis.
  it('treats equal real distances the same regardless of axis or aspect', () => {
    const mismatches: string[] = [];
    for (const aspect of [16 / 9, 4 / 3, 1]) {
      for (const d of [0.05, 0.1, 0.13, 0.2, 0.35]) {
        const probe = (dx: number, dy: number) => {
          const t = new FrettingHandTracker();
          const a = makeHand({ angles: { index: 120, middle: 120, ring: 120 }, aspect });
          for (let i = 0; i < 10; i++) t.track({ frettingHand: 'Left', index: 0, landmarks: a, aspect });
          const moved = makeHand({ angles: { index: 178 }, aspect, offset: { x: dx, y: dy } });
          return t.track({ frettingHand: 'Left', index: 0, landmarks: moved, aspect })!.framesObserved === 1;
        };
        if (probe(d, 0) !== probe(0, d)) mismatches.push(`aspect ${aspect.toFixed(2)}, d=${d}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('wrist guard: legitimate motion must survive', () => {
  // The tightening is only safe if real playing motion stays clear of it. This
  // is the counterweight to the assertions above: without it, "tighter is
  // safer" would ratchet until the app never issues a verdict at all.
  it('tolerates a fast position shift at the real inference interval', () => {
    // ~50 ms between inferences at HAND_TRACKING_FPS = 20. This is the fastest
    // shift in the fixtures, at 0.33 palm-lengths -- 1.5x clear of the guard.
    // SYNTHETIC: not calibrated against a real hand at 20 fps.
    const t = new FrettingHandTracker();
    warmUp(t, arched);
    const shifted = makeHand({
      angles: { index: 120, middle: 120, ring: 120 },
      aspect: ASPECT,
      offset: { x: 0.08, y: 0.02 },
    });
    const f = t.track({ frettingHand: 'Left', index: 0, landmarks: shifted, aspect: ASPECT })!;
    expect(Math.hypot(0.08, 0.02)).toBeLessThan(THRESHOLD);
    expect(f.framesObserved).toBeGreaterThanOrEqual(POSTURE_WARMUP_FRAMES);
  });
});
