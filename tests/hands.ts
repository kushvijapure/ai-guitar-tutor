/**
 * Synthetic hand landmark sets for the posture tests.
 *
 * The hand is built in ISOTROPIC coordinates (one unit means the same distance
 * on both axes, expressed in frame widths) and then encoded into MediaPipe's
 * image-normalized convention by scaling y by the aspect ratio. That mirrors
 * exactly what a camera does, so a test can build a finger at a known true
 * angle and check that analyzePosture recovers it — which is only possible if
 * the aspect correction is actually applied.
 */

import type { FingerName, Landmark } from '../src/lib/posture';

const FINGER_X: Record<FingerName, number> = {
  index: 0.42,
  middle: 0.5,
  ring: 0.58,
  pinky: 0.66,
};

const MCP_INDEX: Record<FingerName, number> = { index: 5, middle: 9, ring: 13, pinky: 17 };

/** Phalanx lengths in isotropic units. Proportions are roughly anatomical. */
const PROXIMAL = 0.1;
const MIDDLE = 0.065;
const DISTAL = 0.05;

const WRIST_ISO = { x: 0.5, y: 0.45 };
const MCP_Y = 0.2;

export interface HandOptions {
  /** PIP joint angle per finger, degrees. 180 = straight. Default 120 (nicely arched). */
  angles?: Partial<Record<FingerName, number>>;
  /** Frame aspect ratio (width / height). */
  aspect?: number;
  /** Uniform scale about the wrist — shrink to simulate a distant hand. */
  scale?: number;
  /** Translate the whole hand in isotropic units, e.g. to push it off-frame. */
  offset?: { x: number; y: number };
  /** Per-finger override of the middle phalanx length, to simulate foreshortening. */
  shorten?: Partial<Record<FingerName, number>>;
}

/**
 * @returns 21 landmarks in MediaPipe's image-normalized convention.
 */
export function makeHand(options: HandOptions = {}): Landmark[] {
  const { angles = {}, aspect = 16 / 9, scale = 1, offset = { x: 0, y: 0 }, shorten = {} } = options;

  const points: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));

  const place = (i: number, x: number, y: number, z = 0) => {
    // Scale about the wrist, translate, then encode y into image units.
    const sx = WRIST_ISO.x + (x - WRIST_ISO.x) * scale + offset.x;
    const sy = WRIST_ISO.y + (y - WRIST_ISO.y) * scale + offset.y;
    points[i] = { x: sx, y: sy * aspect, z: z * scale };
  };

  place(0, WRIST_ISO.x, WRIST_ISO.y);

  // Thumb, angled out from the wrist toward -x. Not curl-parameterised; the
  // tests that care about the thumb set it explicitly.
  place(1, 0.42, 0.4);
  place(2, 0.36, 0.35);
  place(3, 0.32, 0.3);
  place(4, 0.29, 0.26);

  for (const finger of ['index', 'middle', 'ring', 'pinky'] as FingerName[]) {
    const base = MCP_INDEX[finger];
    const x = FINGER_X[finger];
    // Pinky MCP sits slightly lower on a real hand.
    const mcpY = finger === 'pinky' ? MCP_Y + 0.03 : MCP_Y;
    const angleDeg = angles[finger] ?? 120;
    const middleLength = shorten[finger] ?? MIDDLE;

    const mcp = { x, y: mcpY };
    // Proximal phalanx points "up" the frame (-y) from the MCP.
    const pip = { x, y: mcpY - PROXIMAL };

    // Interior angle at the PIP between (MCP - PIP) and (DIP - PIP).
    // u = unit(MCP - PIP) = (0, +1); p = (1, 0) is perpendicular to it, so
    // v = cos(A)*u + sin(A)*p gives exactly the requested interior angle.
    const a = (angleDeg * Math.PI) / 180;
    const vx = Math.sin(a);
    const vy = Math.cos(a);
    const dip = { x: pip.x + middleLength * vx, y: pip.y + middleLength * vy };
    const tip = { x: dip.x + DISTAL * vx, y: dip.y + DISTAL * vy };

    place(base, mcp.x, mcp.y);
    place(base + 1, pip.x, pip.y);
    place(base + 2, dip.x, dip.y);
    place(base + 3, tip.x, tip.y);
  }

  return points;
}

/**
 * The same hand expressed as metric world landmarks.
 *
 * MediaPipe's world landmarks are isotropic already, so this is the isotropic
 * build with no aspect encoding — which is precisely why angles taken from them
 * need no correction.
 */
export function makeWorldHand(options: HandOptions = {}): Landmark[] {
  return makeHand({ ...options, aspect: 1 });
}

/** Drop landmarks to simulate a partial detection. */
export function truncate(landmarks: Landmark[], count: number): Landmark[] {
  return landmarks.slice(0, count);
}

/** Replace a landmark with non-finite values, as a dropped track can produce. */
export function corrupt(landmarks: Landmark[], index: number): Landmark[] {
  const copy = landmarks.map((l) => ({ ...l }));
  copy[index] = { x: NaN, y: NaN, z: NaN };
  return copy;
}
