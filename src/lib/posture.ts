/**
 * Turns MediaPipe hand landmarks into fretting-hand coaching cues.
 *
 * Scope note, because this is the part that's easy to oversell: we do NOT try
 * to infer which fret or string a finger is on. Fret spacing above the 7th is
 * a few millimetres at webcam resolution, and the fretting hand occludes the
 * exact region you'd need to see. What landmarks *do* reliably give us is hand
 * shape — curl, tilt, thumb placement, finger spread — which is where most
 * beginner problems actually live. Correctness of the notes comes from audio.
 */

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** MediaPipe hand landmark indices. */
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const PINKY_MCP = 17;

/** [mcp, pip, tip] per finger, index through pinky. */
const FINGERS: Array<{ name: string; joints: [number, number, number] }> = [
  { name: 'index', joints: [5, 6, 8] },
  { name: 'middle', joints: [9, 10, 12] },
  { name: 'ring', joints: [13, 14, 16] },
  { name: 'pinky', joints: [17, 18, 20] },
];

export type Severity = 'good' | 'warn' | 'bad';

export interface Cue {
  id: string;
  severity: Severity;
  message: string;
}

export interface PostureReport {
  cues: Cue[];
  /** Per-finger PIP angle in degrees. 180 = perfectly straight. */
  curls: Record<string, number>;
  /** Palm rotation relative to horizontal, in degrees. */
  handTilt: number;
}

/** Interior angle at point b, in degrees. */
function angleAt(a: Landmark, b: Landmark, c: Landmark): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };

  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z);
  const m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (m1 === 0 || m2 === 0) return 180;

  return (Math.acos(Math.min(1, Math.max(-1, dot / (m1 * m2)))) * 180) / Math.PI;
}

/** A finger this straight is lying flat and will mute the strings beside it. */
const FLAT_THRESHOLD = 158;
/** Collapsed the other way — knuckle buckled, no strength behind the tip. */
const OVERCURL_THRESHOLD = 75;

export function analyzePosture(landmarks: Landmark[]): PostureReport {
  const cues: Cue[] = [];
  const curls: Record<string, number> = {};

  for (const finger of FINGERS) {
    const [mcp, pip, tip] = finger.joints;
    curls[finger.name] = angleAt(landmarks[mcp], landmarks[pip], landmarks[tip]);
  }

  const flat = FINGERS.filter((f) => curls[f.name] > FLAT_THRESHOLD).map((f) => f.name);
  if (flat.length >= 2) {
    cues.push({
      id: 'flat-fingers',
      severity: 'bad',
      message: `${flat.join(' and ')} are lying flat — arch them so only the tip touches. Flat fingers deaden the string next door.`,
    });
  } else if (flat.length === 1) {
    cues.push({
      id: 'flat-finger',
      severity: 'warn',
      message: `Your ${flat[0]} finger is flattening out. Curl it and come down on the very tip.`,
    });
  }

  const overCurled = FINGERS.filter((f) => curls[f.name] < OVERCURL_THRESHOLD).map((f) => f.name);
  if (overCurled.length > 0) {
    cues.push({
      id: 'over-curled',
      severity: 'warn',
      message: `${overCurled.join(', ')} curled too tight — you'll run out of reach. Relax the knuckle slightly.`,
    });
  }

  // Palm rotation, from the knuckle line. A near-vertical knuckle line means the
  // wrist has rolled over and the pinky can no longer reach without stretching.
  const knuckleSpan = {
    x: landmarks[PINKY_MCP].x - landmarks[INDEX_MCP].x,
    y: landmarks[PINKY_MCP].y - landmarks[INDEX_MCP].y,
  };
  const handTilt = Math.abs((Math.atan2(knuckleSpan.y, knuckleSpan.x) * 180) / Math.PI);
  const tiltFromHorizontal = Math.min(handTilt, 180 - handTilt);

  if (tiltFromHorizontal > 55) {
    cues.push({
      id: 'wrist-rolled',
      severity: 'warn',
      message: 'Your palm has rolled toward the neck. Bring the wrist back so the knuckles sit parallel to the fretboard.',
    });
  }

  // Thumb riding up over the top edge of the neck. Common, not always wrong —
  // fine for blues and bends, bad for open chords where the pinky needs reach.
  const thumbAboveKnuckles = landmarks[THUMB_TIP].y < landmarks[INDEX_MCP].y;
  const thumbSpread = Math.hypot(
    landmarks[THUMB_TIP].x - landmarks[WRIST].x,
    landmarks[THUMB_TIP].y - landmarks[WRIST].y,
  );
  if (thumbAboveKnuckles && thumbSpread > 0.18) {
    cues.push({
      id: 'thumb-over',
      severity: 'warn',
      message: 'Thumb looks hooked over the top of the neck. Drop it behind the neck for chord shapes — you get far more reach.',
    });
  }

  if (cues.length === 0) {
    cues.push({
      id: 'looks-good',
      severity: 'good',
      message: 'Hand shape looks solid. Fingers arched, wrist neutral.',
    });
  }

  return { cues, curls, handTilt: tiltFromHorizontal };
}
