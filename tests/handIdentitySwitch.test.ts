/**
 * REGRESSION GUARD — fretting-hand identity switches must restart warmup.
 *
 * Originally a review artefact demonstrating a defect; inverted here to assert
 * the fix. The defect: useHandTracking kept one LandmarkSmoother for "the
 * fretting hand" and reset it only when NO hand was selected. It did not reset
 * when the selected hand changed IDENTITY while remaining selected, via either
 * of two reachable paths:
 *
 *   1. The player changes the "Fretting hand" setting mid-session.
 *   2. MediaPipe trades its two handedness labels between frames — the same
 *      occlusion degradation that motivated refusing when both hands share a
 *      label. That fix covered two hands claiming one label; it did not cover
 *      the labels swapping places.
 *
 * Landmark counts are identical either way, so push() exponentially blended two
 * different hands and framesObserved() kept climbing — the warmup gate never
 * re-armed and analyzePosture issued a confident verdict about a hand that did
 * not exist. Measured before the fix: PRAISE -> PRAISE -> correction, i.e. ~2
 * frames (~100 ms) of "your fingers look well arched" about flat fingers.
 *
 * FrettingHandTracker now owns that decision. These tests drive it directly.
 */

// This test imports the hook, which transitively reaches mediapipeAssets.ts and
// its `import.meta.env`. The test tsconfig types against node, not vite/client,
// so pull Vite's ambient types in here rather than widening the app's config.
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import { analyzePosture } from '../src/lib/posture';
import type { FingerName, Landmark } from '../src/lib/posture';
import { POSTURE_WARMUP_FRAMES } from '../src/lib/thresholds';
import { FrettingHandTracker } from '../src/hooks/useHandTracking';
import { makeHand } from './hands';

const ACTIVE: FingerName[] = ['index', 'middle', 'ring'];
const ASPECT = 16 / 9;

/** A well-arched hand — the one that legitimately earns praise. */
const arched = makeHand({ angles: { index: 120, middle: 120, ring: 120 }, aspect: ASPECT });

/** A hand lying flat on the strings — every active finger should be corrected. */
const flat = makeHand({ angles: { index: 178, middle: 178, ring: 178 }, aspect: ASPECT });

type Verdict = 'PRAISE' | 'correction' | 'declined';

function verdictFor(landmarks: Landmark[], framesObserved: number): Verdict {
  const report = analyzePosture({
    landmarks,
    aspect: ASPECT,
    confidence: 0.95,
    activeFingers: ACTIVE,
    framesObserved,
  });
  if (report.quality !== 'ok') return 'declined';
  return report.cues.some((c) => c.id === 'looks-good') ? 'PRAISE' : 'correction';
}

/** Feed one hand repeatedly under a stable identity, returning the tracker. */
function warmUp(tracker: FrettingHandTracker, landmarks: Landmark[], frames = 10) {
  let last = null as ReturnType<FrettingHandTracker['track']>;
  for (let i = 0; i < frames; i++) {
    last = tracker.track({ frettingHand: 'Left', index: 0, landmarks, aspect: ASPECT });
  }
  return last;
}

describe('the two hands really are judged as opposites', () => {
  it('confirms the fixture, so the tests below mean something', () => {
    expect(verdictFor(arched, POSTURE_WARMUP_FRAMES)).toBe('PRAISE');
    expect(verdictFor(flat, POSTURE_WARMUP_FRAMES)).toBe('correction');
  });
});

describe('a settled hand still earns a verdict', () => {
  it('completes warmup and reports normally when the hand does not change', () => {
    const tracker = new FrettingHandTracker();

    const first = tracker.track({ frettingHand: 'Left', index: 0, landmarks: arched, aspect: ASPECT })!;
    expect(first.framesObserved).toBe(1);
    expect(verdictFor(first.landmarks, first.framesObserved)).toBe('declined');

    const settled = warmUp(tracker, arched, POSTURE_WARMUP_FRAMES + 5)!;
    expect(settled.framesObserved).toBeGreaterThanOrEqual(POSTURE_WARMUP_FRAMES);
    expect(verdictFor(settled.landmarks, settled.framesObserved)).toBe('PRAISE');
  });
});

describe('identity switch restarts warmup', () => {
  it('restarts when the player changes the fretting-hand setting mid-session', () => {
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);

    const after = tracker.track({ frettingHand: 'Right', index: 0, landmarks: flat, aspect: ASPECT })!;
    expect(after.framesObserved).toBe(1);
  });

  it('restarts when MediaPipe swaps its two handedness labels', () => {
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);

    // Same setting, but the hand matching it is now the other detection.
    const after = tracker.track({ frettingHand: 'Left', index: 1, landmarks: flat, aspect: ASPECT })!;
    expect(after.framesObserved).toBe(1);
  });

  it('restarts on a wrist jump too large to be one hand moving', () => {
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);

    // Setting and index both unchanged — only spatial continuity is broken.
    const teleported = makeHand({ angles: { index: 178 }, aspect: ASPECT, offset: { x: 0.3, y: 0 } });
    const after = tracker.track({ frettingHand: 'Left', index: 0, landmarks: teleported, aspect: ASPECT })!;
    expect(after.framesObserved).toBe(1);
  });

  it('does NOT restart for ordinary hand movement', () => {
    // The guard must not be so tight that a hand shifting position re-arms
    // warmup every frame — that would mean never issuing a verdict at all.
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);

    const nudged = makeHand({ angles: { index: 120 }, aspect: ASPECT, offset: { x: 0.02, y: 0.01 } });
    const after = tracker.track({ frettingHand: 'Left', index: 0, landmarks: nudged, aspect: ASPECT })!;
    expect(after.framesObserved).toBeGreaterThan(POSTURE_WARMUP_FRAMES);
  });

  it('restarts after a dropout, as it always did', () => {
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);
    tracker.reset();

    const after = tracker.track({ frettingHand: 'Left', index: 0, landmarks: arched, aspect: ASPECT })!;
    expect(after.framesObserved).toBe(1);
  });
});

describe('THE REGRESSION: no praise survives a hand switch', () => {
  it('never praises the flat hand after the switch', () => {
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);

    const verdicts: Verdict[] = [];
    for (let frame = 0; frame < 10; frame++) {
      // From here on the camera is looking at the flat hand, and only the flat
      // hand. Nothing about the arched hand is still true.
      const f = tracker.track({ frettingHand: 'Left', index: 1, landmarks: flat, aspect: ASPECT })!;
      verdicts.push(verdictFor(f.landmarks, f.framesObserved));
    }

    // The defect was verdicts[0] === 'PRAISE'. Now the first frames decline
    // outright, and no frame anywhere praises a hand whose fingers are flat.
    expect(verdicts).not.toContain('PRAISE');
    expect(verdicts[0]).toBe('declined');
    // ...and it must still recover to a real correction rather than declining
    // forever, or the fix has just traded a false accept for a dead panel.
    expect(verdicts).toContain('correction');
  });

  it('declines for the whole warmup, not just the first frame', () => {
    const tracker = new FrettingHandTracker();
    warmUp(tracker, arched);

    for (let frame = 1; frame < POSTURE_WARMUP_FRAMES; frame++) {
      const f = tracker.track({ frettingHand: 'Left', index: 1, landmarks: flat, aspect: ASPECT })!;
      expect(f.framesObserved).toBe(frame);
      expect(verdictFor(f.landmarks, f.framesObserved)).toBe('declined');
    }
  });
});

describe('world-landmark smoother stays in step with the image smoother', () => {
  const archedWorld = makeHand({ angles: { index: 120, middle: 120, ring: 120 }, aspect: 1 });

  it('reports the shorter of the two histories', () => {
    const tracker = new FrettingHandTracker();
    for (let i = 0; i < 8; i++) {
      tracker.track({
        frettingHand: 'Left',
        index: 0,
        landmarks: arched,
        worldLandmarks: archedWorld,
        aspect: ASPECT,
      });
    }

    const f = tracker.track({
      frettingHand: 'Left',
      index: 0,
      landmarks: arched,
      worldLandmarks: archedWorld,
      aspect: ASPECT,
    })!;
    expect(f.worldLandmarks).toBeDefined();
    expect(f.framesObserved).toBe(9);
  });

  it('re-arms warmup for world landmarks that disappear and come back', () => {
    // Angles are measured from world landmarks when present, so a satisfied
    // image-derived gate paired with one frame of world history would be a
    // verdict on effectively unsmoothed coordinates.
    const tracker = new FrettingHandTracker();
    for (let i = 0; i < 8; i++) {
      tracker.track({
        frettingHand: 'Left',
        index: 0,
        landmarks: arched,
        worldLandmarks: archedWorld,
        aspect: ASPECT,
      });
    }

    // World data drops out for a frame; image tracking continues uninterrupted.
    const gap = tracker.track({ frettingHand: 'Left', index: 0, landmarks: arched, aspect: ASPECT })!;
    expect(gap.worldLandmarks).toBeUndefined();
    expect(gap.framesObserved).toBeGreaterThanOrEqual(POSTURE_WARMUP_FRAMES);

    // It returns. The world smoother has one frame, so the gate must say so.
    const back = tracker.track({
      frettingHand: 'Left',
      index: 0,
      landmarks: arched,
      worldLandmarks: archedWorld,
      aspect: ASPECT,
    })!;
    expect(back.framesObserved).toBe(1);
  });
});
