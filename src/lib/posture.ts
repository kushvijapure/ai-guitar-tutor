/**
 * Turns MediaPipe hand landmarks into fretting-hand coaching cues.
 *
 * Scope, stated up front because this is the part that is easy to oversell:
 *
 *  - We do NOT infer which fret or string a finger is on. Fret spacing above
 *    the 7th is a few millimetres at webcam resolution and the fretting hand
 *    occludes the region you would need to see. Note correctness comes from
 *    audio.
 *
 *  - We do NOT know where the guitar neck is. Nothing here detects the
 *    fretboard, so no cue may assert an angle *relative to the neck* — that
 *    includes the previous version's "keep your knuckles parallel to the
 *    fretboard", which was unsupportable: it compared the knuckle line to the
 *    horizontal of the camera image, so tilting the webcam changed the verdict.
 *    Palm-rotation and thumb cues are now emitted as explicitly tentative
 *    observations, phrased conditionally, and never as corrections.
 *
 *  - We only judge fingers the current chord actually uses. The previous
 *    version scored all four every frame, so playing Em (middle and ring only)
 *    reliably produced "your index finger is flattening out" about a finger
 *    that was correctly resting off the strings.
 *
 * What landmarks *do* support is per-finger joint angle, and only when the
 * geometry is measurable. Every judgement below is gated on that; when it is
 * not met the report says so rather than guessing, and in particular never
 * emits praise. A false "looks good" trains the player to keep a mistake.
 */

import {
  EDGE_MARGIN,
  FLAT_FINGER_ANGLE,
  LANDMARK_SMOOTHING,
  MAX_BONE_LENGTH_RATIO,
  MIN_BONE_FRACTION,
  MIN_HAND_CONFIDENCE,
  MIN_HAND_SCALE,
  OVERCURL_FINGER_ANGLE,
  POSTURE_WARMUP_FRAMES,
} from './thresholds';

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** MediaPipe hand landmark indices. */
export const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

/**
 * Below this PIP interior angle the reading is not a finger.
 *
 * A human PIP flexes to about 100-110 degrees, leaving an interior angle near
 * 70-80; it physically cannot fold tighter. Anything under 30 is landmark
 * garbage — a collapsed or swapped joint — and must be refused rather than
 * coached as "over-curled". Set well below the anatomical limit so it only ever
 * catches the impossible, never a genuinely tight hand.
 *
 * NOTE: this lives here rather than in thresholds.ts with its siblings only
 * because that file is owned by another workstream in the current split. It
 * belongs there.
 */
const MIN_ANATOMICAL_PIP_ANGLE = 30;

export type FingerName = 'index' | 'middle' | 'ring' | 'pinky';

/**
 * [MCP, PIP, DIP] per finger.
 *
 * The previous version used [MCP, PIP, TIP], which measures the angle subtended
 * at the PIP by the fingertip rather than the angle of the PIP joint itself.
 * That conflates PIP and DIP flexion: a finger with a straight PIP but a curled
 * tip read as heavily curled, and the "arch your finger" cue fired on fingers
 * that were already arched correctly.
 */
const FINGER_JOINTS: Record<FingerName, [number, number, number]> = {
  index: [5, 6, 7],
  middle: [9, 10, 11],
  ring: [13, 14, 15],
  pinky: [17, 18, 19],
};

export const FINGER_ORDER: FingerName[] = ['index', 'middle', 'ring', 'pinky'];

/** Chord shapes number their fingers 1=index .. 4=pinky. */
export const FINGER_BY_NUMBER: Record<number, FingerName> = {
  1: 'index',
  2: 'middle',
  3: 'ring',
  4: 'pinky',
};

export type Severity = 'good' | 'warn' | 'bad' | 'info';

export interface Cue {
  id: string;
  severity: Severity;
  message: string;
  finger?: FingerName;
  /**
   * True for cues we cannot fully stand behind — those that would need to know
   * where the neck is. The UI must present these as observations, not
   * instructions.
   */
  tentative?: boolean;
}

export interface FingerMeasurement {
  /** PIP joint angle in degrees; 180 is a straight finger. */
  angle: number;
  /** False when foreshortening or landmark noise makes the angle meaningless. */
  reliable: boolean;
  reason?: string;
}

export type PostureQuality = 'ok' | 'unreliable';

export interface PostureReport {
  quality: PostureQuality;
  /** Populated when quality is 'unreliable' — shown to the user verbatim. */
  reason: string | null;
  cues: Cue[];
  /** Only the fingers the current chord uses. */
  assessedFingers: FingerName[];
  measurements: Partial<Record<FingerName, FingerMeasurement>>;
}

export interface PostureInput {
  /** Image-normalized landmarks (x, y in 0..1; z roughly in x's units). */
  landmarks: Landmark[];
  /**
   * MediaPipe's metric world landmarks, if available. Preferred for joint
   * angles: they are already isotropic 3D, so they need no aspect correction
   * and do not distort when the camera is not 1:1.
   */
  worldLandmarks?: Landmark[];
  /** Frame width / height. Used to make image landmarks isotropic. */
  aspect: number;
  /**
   * MediaPipe's handedness classification score, used as a weak proxy for how
   * well the hand is resolved. NOTE: this is a handedness confidence, not a
   * landmark-quality score — the task API does not expose the latter — so it is
   * one gate among several rather than the primary one.
   */
  confidence?: number;
  /** Fingers the current chord requires. Only these are judged. */
  activeFingers: FingerName[];
  /** Frames of smoothed history behind these landmarks. */
  framesObserved?: number;
}

/** Interior angle at point b, in degrees. */
function angleAt(a: Landmark, b: Landmark, c: Landmark): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };

  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z);
  const m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (m1 === 0 || m2 === 0) return NaN;

  return (Math.acos(Math.min(1, Math.max(-1, dot / (m1 * m2)))) * 180) / Math.PI;
}

function distance(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Rescale image-normalized landmarks so one unit means the same distance on
 * both axes.
 *
 * MediaPipe normalizes x by frame width and y by frame height, so on a 16:9
 * camera a vertical centimetre and a horizontal centimetre differ by 1.78x in
 * landmark units. Computing an angle from those coordinates directly skews it —
 * a genuinely 90-degree joint measures anywhere from about 60 to 120 degrees
 * depending only on how the finger happens to be oriented in frame. Scaling y
 * into x's units removes that. (z is already expressed roughly in x's units.)
 */
export function toIsotropic(landmarks: Landmark[], aspect: number): Landmark[] {
  const yScale = aspect > 0 ? 1 / aspect : 1;
  return landmarks.map((l) => ({ x: l.x, y: l.y * yScale, z: l.z }));
}

/**
 * MediaPipe reports handedness assuming the input image is MIRRORED, i.e. a
 * selfie-view frame that has already been flipped horizontally.
 *
 * We hand `detectForVideo` the raw <video> element. The CSS transform that
 * mirrors the on-screen preview does not touch the pixels MediaPipe reads, so
 * our input is NOT mirrored and MediaPipe's assumption is violated: it labels a
 * physically left hand "Right". Selecting the fretting hand by comparing
 * MediaPipe's label to the user's setting therefore picked the wrong hand.
 *
 * @param label      What MediaPipe reported ('Left' | 'Right').
 * @param inputMirrored Whether the frames given to MediaPipe were pre-mirrored.
 * @returns The user's actual hand.
 *
 * This has been reasoned from the documented convention but NOT verified
 * against a camera — see README, "Release blockers". The UI exposes a manual
 * swap so a wrong guess is recoverable by the player.
 */
export function resolveHandedness(label: string, inputMirrored: boolean): string {
  if (label !== 'Left' && label !== 'Right') return label;
  if (inputMirrored) return label;
  return label === 'Left' ? 'Right' : 'Left';
}

/** Just enough of a tracked hand to choose between them. */
export interface HandCandidate {
  /** Already passed through resolveHandedness. */
  handedness: string;
}

export interface HandSelection {
  /** Index into the input array, or -1 if no hand can be used. */
  index: number;
  /**
   * Non-null only when a hand *was* present but could not be identified — the
   * UI should show this as "unable to assess". Null means simply "the fretting
   * hand is not in frame", which the UI phrases differently.
   */
  reason: string | null;
}

/**
 * Pick the hand on the neck, or refuse to.
 *
 * The naive version of this is `hands.find(h => h.handedness === frettingHand)`,
 * which has a failure mode that matters a great deal here: MediaPipe can label
 * BOTH detected hands the same way. That is not rare in this application — the
 * strumming hand is frequently half out of frame or occluded by the guitar body,
 * which is exactly when its handedness classification degrades. Taking the first
 * match then coaches a coin-flip hand with full confidence, and finger-arch
 * advice aimed at the strumming hand is nonsense the player cannot act on.
 *
 * So when two hands both claim to be the fretting hand, we decline. One
 * ambiguous frame costs the player nothing; one confident wrong verdict costs
 * them trust in every verdict after it.
 *
 * Note this is orthogonal to which physical hand frets: `frettingHand` is the
 * player's own setting ('Left' for a standard right-handed player, 'Right' for a
 * left-handed player on a left-handed guitar), so both cases go through the
 * same path and neither is special-cased.
 */
export function selectFrettingHand(
  hands: ReadonlyArray<HandCandidate>,
  frettingHand: string,
): HandSelection {
  const matches: number[] = [];
  for (let i = 0; i < hands.length; i++) {
    if (hands[i].handedness === frettingHand) matches.push(i);
  }

  if (matches.length === 1) return { index: matches[0], reason: null };
  if (matches.length === 0) return { index: -1, reason: null };

  return {
    index: -1,
    reason:
      `Two hands in frame both look like your ${frettingHand.toLowerCase()} hand, ` +
      `so I can't tell which one is on the neck. Move the strumming hand out of ` +
      `shot, or angle the camera at the neck.`,
  };
}

/**
 * An "I cannot judge this" report, for callers that detect a problem upstream of
 * the geometry (e.g. they cannot identify which hand is which).
 */
export function unassessable(reason: string, activeFingers: FingerName[]): PostureReport {
  return unreliable(reason, activeFingers);
}

/** Fingers a chord shape actually asks you to fret. */
export function activeFingersFor(fingers: ReadonlyArray<number | null>): FingerName[] {
  const set = new Set<FingerName>();
  for (const f of fingers) {
    if (f == null) continue;
    const name = FINGER_BY_NUMBER[f];
    if (name) set.add(name);
  }
  return FINGER_ORDER.filter((f) => set.has(f));
}

function isFinite3(l: Landmark | undefined): l is Landmark {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.z);
}

/**
 * Measure one finger's PIP angle, and decide whether the measurement can be
 * trusted at all.
 *
 * @param space     Coordinates to measure in (world landmarks, or isotropic image ones).
 * @param handScale Reference length for "how big is this hand", so the bone-length
 *                  checks are scale-free.
 */
function measureFinger(
  space: Landmark[],
  finger: FingerName,
  handScale: number,
): FingerMeasurement {
  const [mcpIdx, pipIdx, dipIdx] = FINGER_JOINTS[finger];
  const mcp = space[mcpIdx];
  const pip = space[pipIdx];
  const dip = space[dipIdx];

  if (!isFinite3(mcp) || !isFinite3(pip) || !isFinite3(dip)) {
    return { angle: NaN, reliable: false, reason: 'landmarks missing' };
  }

  const proximal = distance(mcp, pip);
  const middle = distance(pip, dip);

  if (handScale <= 0) {
    return { angle: NaN, reliable: false, reason: 'hand scale unknown' };
  }
  if (proximal < handScale * MIN_BONE_FRACTION || middle < handScale * MIN_BONE_FRACTION * 0.6) {
    // Bone projects to almost nothing: the finger points at the camera.
    return { angle: NaN, reliable: false, reason: 'finger pointing toward camera' };
  }

  const ratio = Math.max(proximal, middle) / Math.min(proximal, middle);
  if (ratio > MAX_BONE_LENGTH_RATIO) {
    return { angle: NaN, reliable: false, reason: 'finger foreshortened' };
  }

  const angle = angleAt(mcp, pip, dip);
  if (!Number.isFinite(angle)) {
    return { angle: NaN, reliable: false, reason: 'degenerate geometry' };
  }
  if (angle < MIN_ANATOMICAL_PIP_ANGLE) {
    // Not a very curled finger — not a finger at all. A human PIP flexes to
    // roughly 100-110 degrees, i.e. an interior angle around 70-80, and cannot
    // fold back on itself. A reading this far past the anatomical limit means
    // the landmarks are wrong, and "you are over-curling" would be a confident
    // correction derived from noise.
    return { angle: NaN, reliable: false, reason: 'joint angle not anatomically possible' };
  }

  return { angle, reliable: true };
}

function unreliable(reason: string, assessed: FingerName[]): PostureReport {
  return { quality: 'unreliable', reason, cues: [], assessedFingers: assessed, measurements: {} };
}

export function analyzePosture(input: PostureInput): PostureReport {
  const { landmarks, worldLandmarks, aspect, confidence, activeFingers } = input;
  const framesObserved = input.framesObserved ?? POSTURE_WARMUP_FRAMES;

  if (!landmarks || landmarks.length < 21) {
    return unreliable('Hand not fully detected.', activeFingers);
  }
  if (activeFingers.length === 0) {
    return unreliable('This chord uses no fretting fingers.', activeFingers);
  }
  if (framesObserved < POSTURE_WARMUP_FRAMES) {
    return unreliable('Getting a steady read on your hand…', activeFingers);
  }
  if (confidence !== undefined && confidence < MIN_HAND_CONFIDENCE) {
    return unreliable('Hand tracking is not confident enough to judge.', activeFingers);
  }

  // Clipping check runs in raw image space, where the frame edge is 0 and 1.
  //
  // The knuckle span (index MCP to pinky MCP) is required even when the chord
  // uses neither finger. It is deliberately a wider basis than the judgement
  // strictly needs: it is what establishes that the whole hand is inside the
  // frame. Narrowing it to just the fretted fingers would let a hand that is
  // half out of shot through the gate, and a hand at the frame boundary is
  // precisely where MediaPipe starts extrapolating landmarks it cannot see.
  const required = new Set<number>([WRIST, MIDDLE_MCP, INDEX_MCP, PINKY_MCP]);
  for (const f of activeFingers) for (const j of FINGER_JOINTS[f]) required.add(j);
  for (const idx of required) {
    const l = landmarks[idx];
    if (!isFinite3(l)) return unreliable('Hand not fully detected.', activeFingers);
    if (
      l.x < EDGE_MARGIN || l.x > 1 - EDGE_MARGIN ||
      l.y < EDGE_MARGIN || l.y > 1 - EDGE_MARGIN
    ) {
      return unreliable('Your hand is at the edge of the frame — move it into view.', activeFingers);
    }
  }

  // Angles come from world landmarks when MediaPipe supplies them: they are
  // already metric and isotropic. Otherwise fall back to aspect-corrected image
  // landmarks, which are noisier but at least not skewed by frame shape.
  const usingWorld = !!worldLandmarks && worldLandmarks.length >= 21;
  const space = usingWorld ? worldLandmarks! : toIsotropic(landmarks, aspect);
  const imageSpace = toIsotropic(landmarks, aspect);

  const handScale = distance(space[WRIST], space[MIDDLE_MCP]);
  const imageHandScale = distance(imageSpace[WRIST], imageSpace[MIDDLE_MCP]);
  if (imageHandScale < MIN_HAND_SCALE) {
    return unreliable('Your hand is too far from the camera to assess.', activeFingers);
  }

  const measurements: Partial<Record<FingerName, FingerMeasurement>> = {};
  for (const finger of activeFingers) {
    measurements[finger] = measureFinger(space, finger, handScale);
  }

  const reliable = activeFingers.filter((f) => measurements[f]?.reliable);
  if (reliable.length === 0) {
    const why = measurements[activeFingers[0]]?.reason ?? 'geometry unclear';
    return {
      quality: 'unreliable',
      reason: `Can't measure the fingers this chord uses (${why}). Try a more side-on camera angle.`,
      cues: [],
      assessedFingers: activeFingers,
      measurements,
    };
  }

  const cues: Cue[] = [];

  // ---- Per-finger curl, active fingers only -------------------------------
  const flat = reliable.filter((f) => measurements[f]!.angle > FLAT_FINGER_ANGLE);
  if (flat.length >= 2) {
    cues.push({
      id: 'flat-fingers',
      severity: 'bad',
      message: `${joinNames(flat)} are lying flat — arch them so only the tip touches. Flat fingers deaden the string next door.`,
    });
  } else if (flat.length === 1) {
    cues.push({
      id: `flat-${flat[0]}`,
      severity: 'warn',
      finger: flat[0],
      message: `Your ${flat[0]} finger is flattening out. Curl it and come down on the very tip.`,
    });
  }

  const overCurled = reliable.filter((f) => measurements[f]!.angle < OVERCURL_FINGER_ANGLE);
  if (overCurled.length > 0) {
    cues.push({
      id: 'over-curled',
      severity: 'warn',
      message: `${joinNames(overCurled)} curled very tight — you'll run out of reach. Relax the knuckle slightly.`,
    });
  }

  // ---- Tentative observations ---------------------------------------------
  // Everything below would need to know where the neck is to be a correction.
  // It is offered as an observation and phrased conditionally.
  const knuckleTilt = palmTilt(imageSpace);
  if (knuckleTilt > 55) {
    cues.push({
      id: 'palm-rolled',
      severity: 'info',
      tentative: true,
      message:
        'Your knuckle line looks steeply angled in frame. That can mean the palm has rolled toward the neck — but it also just means the camera is off to one side, so check it against a mirror rather than taking this as a correction.',
    });
  }

  const thumbAbduction = angleAt(imageSpace[THUMB_TIP], imageSpace[THUMB_MCP], imageSpace[INDEX_MCP]);
  if (Number.isFinite(thumbAbduction) && thumbAbduction > 150) {
    cues.push({
      id: 'thumb-extended',
      severity: 'info',
      tentative: true,
      message:
        'Your thumb is stretched well away from the palm. If it is hooked over the top of the neck, dropping it behind will give the pinky more reach — but this view cannot see the neck, so ignore it if the thumb is already behind.',
    });
  }

  // ---- Praise, only when everything checked out ---------------------------
  // Requires every active finger to have been measurable. Praising a hand where
  // half the fingers could not be seen is the same mistake as a false correction.
  const allMeasured = reliable.length === activeFingers.length;
  const noProblems = cues.every((c) => c.severity === 'info');
  if (allMeasured && noProblems) {
    cues.unshift({
      id: 'looks-good',
      severity: 'good',
      message: `${joinNames(activeFingers)} look well arched for this shape.`,
    });
  } else if (!allMeasured) {
    const unmeasured = activeFingers.filter((f) => !measurements[f]?.reliable);
    cues.push({
      id: 'partial',
      severity: 'info',
      message: `Couldn't get a clear read on your ${joinNames(unmeasured)} this time.`,
    });
  }

  return {
    quality: 'ok',
    reason: null,
    cues,
    assessedFingers: activeFingers,
    measurements,
  };
}

/**
 * Angle of the knuckle line away from the image horizontal, 0..90 degrees.
 *
 * @returns NaN when the knuckle landmarks are unusable, which suppresses the
 *          observation rather than inventing one — these landmarks are not part
 *          of the required set, so this is the normal path when the pinky
 *          knuckle is occluded.
 */
function palmTilt(space: Landmark[]): number {
  const index = space[INDEX_MCP];
  const pinky = space[PINKY_MCP];
  if (!isFinite3(index) || !isFinite3(pinky)) return NaN;

  const dx = pinky.x - index.x;
  const dy = pinky.y - index.y;
  const deg = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  return Math.min(deg, 180 - deg);
}

function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Exponential smoothing over landmark streams.
 *
 * MediaPipe landmarks jitter by a pixel or two frame to frame. That is a few
 * degrees at the PIP joint, which is enough to flip a cue on and off several
 * times a second right at a threshold boundary — visually it reads as the coach
 * being indecisive, and it makes the advice impossible to act on.
 */
export class LandmarkSmoother {
  private current: Landmark[] | null = null;
  private frames = 0;
  private readonly alpha: number;

  constructor(alpha: number = LANDMARK_SMOOTHING) {
    this.alpha = alpha;
  }

  /** @returns Smoothed landmarks, or null if given nothing. */
  push(landmarks: Landmark[] | null): Landmark[] | null {
    if (!landmarks || landmarks.length === 0) {
      this.reset();
      return null;
    }

    if (!this.current || this.current.length !== landmarks.length) {
      this.current = landmarks.map((l) => ({ ...l }));
      this.frames = 1;
      return this.current;
    }

    const a = this.alpha;
    for (let i = 0; i < landmarks.length; i++) {
      const prev = this.current[i];
      const next = landmarks[i];
      prev.x = prev.x * a + next.x * (1 - a);
      prev.y = prev.y * a + next.y * (1 - a);
      prev.z = prev.z * a + next.z * (1 - a);
    }
    this.frames++;
    return this.current;
  }

  framesObserved(): number {
    return this.frames;
  }

  reset(): void {
    this.current = null;
    this.frames = 0;
  }
}
