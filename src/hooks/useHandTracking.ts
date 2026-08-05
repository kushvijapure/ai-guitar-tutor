import { useEffect, useRef, useState, type RefObject } from 'react';
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  analyzePosture,
  LandmarkSmoother,
  resolveHandedness,
  selectFrettingHand,
  unassessable,
  WRIST,
  type FingerName,
  type Landmark,
  type PostureReport,
} from '../lib/posture';
import { describeMediaError, type MediaFailure } from '../lib/mediaErrors';
import { HAND_TRACKING_FPS, UI_UPDATE_HZ } from '../lib/thresholds';
import { HAND_MODEL_FALLBACK_URL, LOCAL_HAND_MODEL_URL, WASM_BASE } from '../lib/mediapipeAssets';

/**
 * Hand tracking, capped and smoothed.
 *
 * The prototype ran MediaPipe inference inside requestAnimationFrame and called
 * setState on every result, so on a 120 Hz display it attempted 120 inferences
 * and 120 React renders a second. Hand shape does not change meaningfully at
 * that rate. Inference is capped at HAND_TRACKING_FPS and the UI is updated at
 * UI_UPDATE_HZ, independently.
 *
 * MediaPipe is fed the raw <video> element, which is NOT mirrored — the CSS
 * transform only affects what is drawn. That matters because MediaPipe's
 * handedness labels assume mirrored input; see resolveHandedness().
 */

export type TrackingStatus = 'idle' | 'loading' | 'requesting' | 'running' | 'error';

export interface TrackedHand {
  /** The user's actual hand, after correcting MediaPipe's mirroring assumption. */
  handedness: string;
  /** Raw label, kept for diagnostics. */
  rawHandedness: string;
  confidence: number;
  landmarks: Landmark[];
}

export interface TrackingStats {
  /** Animation frames seen. */
  frames: number;
  /** Frames on which inference actually ran. */
  inferences: number;
  /** Frames deliberately skipped by the rate cap. */
  skipped: number;
  meanInferenceMs: number;
  worstInferenceMs: number;
  fps: number;
}

const EMPTY_STATS: TrackingStats = {
  frames: 0,
  inferences: 0,
  skipped: 0,
  meanInferenceMs: 0,
  worstInferenceMs: 0,
  fps: 0,
};

function statsEqual(a: TrackingStats, b: TrackingStats): boolean {
  return (
    a.frames === b.frames &&
    a.inferences === b.inferences &&
    a.skipped === b.skipped &&
    a.meanInferenceMs === b.meanInferenceMs &&
    a.worstInferenceMs === b.worstInferenceMs &&
    a.fps === b.fps
  );
}

/** Middle-finger MCP. Not exported by posture.ts, and only needed for scale here. */
const MIDDLE_MCP = 9;

/**
 * A wrist that moves further than this many hand-lengths between consecutive
 * inferences did not move — it is a different hand.
 *
 * At HAND_TRACKING_FPS the gap between inferences is ~50 ms. A real fretting
 * hand shifting position travels a fraction of its own length in that time;
 * one whole length is already generous. Set loosely on purpose: a false trigger
 * costs POSTURE_WARMUP_FRAMES of "unable to assess" (~250 ms), while a missed
 * one costs a confident verdict about a hand that is not there.
 */
const HAND_IDENTITY_JUMP_RATIO = 1;

/** Which hand the smoothers currently hold history for. */
interface HandIdentity {
  frettingHand: string;
  index: number;
}

export interface TrackedFrame {
  landmarks: Landmark[];
  worldLandmarks?: Landmark[];
  /** Frames of history behind BOTH coordinate spaces being returned. */
  framesObserved: number;
}

export interface TrackInput {
  /** The player's fretting-hand setting on this frame. */
  frettingHand: string;
  /** Index of the selected hand within this frame's detection list. */
  index: number;
  landmarks: Landmark[];
  worldLandmarks?: Landmark[];
  /** Frame width / height, needed to compare distances fairly. */
  aspect: number;
}

/**
 * Smoothing for whichever hand is currently the fretting hand, with a hard rule:
 * history is never carried across a change of hand.
 *
 * Resetting on dropout (no hand selected) is the easy half, and the previous
 * version did only that. The dangerous half is when a hand stays *selected* but
 * stops being the same hand. The landmark count is identical, so the smoother
 * happily blends the two and framesObserved() keeps climbing, which means the
 * warmup gate never re-arms and analyzePosture issues a confident verdict about
 * a hand that no longer exists. Measured: about two frames (~100 ms) of "your
 * fingers look well arched" about fingers that are lying flat.
 *
 * Two ways it happens, both reachable:
 *   1. The player changes the fretting-hand setting mid-session.
 *   2. MediaPipe trades its two handedness labels between frames — the same
 *      occlusion degradation that motivated refusing when both hands share a
 *      label. That fix covered two hands claiming one label; it did not cover
 *      the labels swapping places.
 *
 * Identity is therefore checked three ways: the setting, the index within the
 * detection list, and spatial continuity of the wrist. The last one is the
 * backstop for a swap that happens to preserve the index.
 */
export class FrettingHandTracker {
  private readonly smoother = new LandmarkSmoother();
  private readonly worldSmoother = new LandmarkSmoother();
  private identity: HandIdentity | null = null;
  private lastWrist: Landmark | null = null;

  /** Drop all history, re-arming the warmup gate. */
  reset(): void {
    this.smoother.reset();
    this.worldSmoother.reset();
    this.identity = null;
    this.lastWrist = null;
  }

  /**
   * @returns Smoothed landmarks for this frame, or null if there is nothing to
   *          smooth. A frame that starts a new identity comes back with
   *          framesObserved === 1, which the warmup gate rejects.
   */
  track(input: TrackInput): TrackedFrame | null {
    const { frettingHand, index, landmarks, worldLandmarks, aspect } = input;
    if (!landmarks || landmarks.length === 0) {
      this.reset();
      return null;
    }

    if (!this.isSameHand(frettingHand, index, landmarks, aspect)) {
      // Not a continuation. Anything carried over would be a blend of two hands.
      this.smoother.reset();
      this.worldSmoother.reset();
    }

    const smoothed = this.smoother.push(landmarks);
    if (!smoothed) {
      this.reset();
      return null;
    }

    // World landmarks are optional per frame. When they vanish the world
    // smoother must be dropped too, or it holds stale history that pairs a
    // satisfied (image-derived) warmup gate with barely-smoothed world
    // coordinates — and world coordinates are what the angles are measured from.
    let smoothedWorld: Landmark[] | null = null;
    if (worldLandmarks && worldLandmarks.length > 0) {
      smoothedWorld = this.worldSmoother.push(worldLandmarks);
    } else {
      this.worldSmoother.reset();
    }

    this.identity = { frettingHand, index };
    this.lastWrist = { ...landmarks[WRIST] };

    // The gate must reflect the space the angles actually come from, so take
    // the shorter history of the two rather than assuming they advance together.
    const framesObserved = smoothedWorld
      ? Math.min(this.smoother.framesObserved(), this.worldSmoother.framesObserved())
      : this.smoother.framesObserved();

    return {
      landmarks: smoothed,
      worldLandmarks: smoothedWorld ?? undefined,
      framesObserved,
    };
  }

  private isSameHand(
    frettingHand: string,
    index: number,
    landmarks: Landmark[],
    aspect: number,
  ): boolean {
    if (!this.identity || !this.lastWrist) return false;
    if (this.identity.frettingHand !== frettingHand) return false;
    if (this.identity.index !== index) return false;

    const wrist = landmarks[WRIST];
    const mcp = landmarks[MIDDLE_MCP];
    if (!wrist || !mcp) return false;

    // Both distances must be isotropic before they can be compared. Landmark y
    // is normalized by frame height and x by frame width, so on a 16:9 camera a
    // vertically-oriented hand measures ~1.8x longer than the same hand lying
    // horizontally. Comparing a mostly-horizontal jump against a mostly-vertical
    // hand in raw units silently loosens this guard by that factor.
    const yScale = aspect > 0 ? 1 / aspect : 1;
    const handScale = Math.hypot(wrist.x - mcp.x, (wrist.y - mcp.y) * yScale);
    if (!(handScale > 0)) return false;

    const jump = Math.hypot(
      wrist.x - this.lastWrist.x,
      (wrist.y - this.lastWrist.y) * yScale,
    );
    return jump <= handScale * HAND_IDENTITY_JUMP_RATIO;
  }
}

interface Options {
  /** Fingers the current chord frets — posture only judges these. */
  activeFingers: FingerName[];
  /** Which of the player's hands is on the neck. */
  frettingHand: string;
  /** Whether the frames handed to MediaPipe were pre-mirrored. */
  inputMirrored?: boolean;
}

export function useHandTracking(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  options: Options,
) {
  const [hands, setHands] = useState<TrackedHand[]>([]);
  const [posture, setPosture] = useState<PostureReport | null>(null);
  const [status, setStatus] = useState<TrackingStatus>('idle');
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  const [stats, setStats] = useState<TrackingStats>(EMPTY_STATS);

  // Read inside the loop without making it a dependency — changing chord must
  // not tear down and rebuild the tracker.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setHands([]);
      setPosture(null);
      setStats(EMPTY_STATS);
      setFailure(null);
      return;
    }

    let cancelled = false;
    const teardown: Array<() => void> = [];

    /**
     * Register a resource's release function, or release it immediately if
     * teardown has already happened.
     *
     * This exists because `start()` is async and React's cleanup is not. Every
     * `await` below is a window in which the effect can be torn down: the
     * cleanup sets `cancelled` and drains `teardown`, and only *then* does the
     * await resolve and hand us a HandLandmarker or a MediaStream. Pushing that
     * onto the already-drained array registers a release that will never run —
     * the previous shape of this code leaked exactly that way, leaving the
     * camera light on and a GPU landmarker alive after a fast start/stop or a
     * Strict Mode double-mount.
     *
     * @returns false if the caller should abandon startup.
     */
    function own(release: () => void): boolean {
      if (cancelled) {
        try {
          release();
        } catch {
          // Best effort — we are already unwinding.
        }
        return false;
      }
      teardown.push(release);
      return true;
    }

    /**
     * Run every registered release, exactly once.
     *
     * Drains the array as it goes so it is safe to call twice — the failure
     * path and the cleanup path both call it, and either may come first.
     */
    function releaseAll(): void {
      for (const release of teardown.splice(0).reverse()) {
        try {
          release();
        } catch {
          // Keep tearing down even if one step fails.
        }
      }
    }

    const tracker = new FrettingHandTracker();

    let rafId: number | null = null;
    let lastVideoTime = -1;
    let lastInferenceAt = 0;
    const minInterval = 1000 / HAND_TRACKING_FPS;

    const counters = { frames: 0, inferences: 0, skipped: 0, totalMs: 0, worstMs: 0 };
    const recentInferences: number[] = [];

    /** Newest result, drained into React on a fixed cadence. */
    let pending: { hands: TrackedHand[]; posture: PostureReport | null } | null = null;

    /** Last stats published to React, so unchanged ones can be skipped. */
    let lastStats: TrackingStats = EMPTY_STATS;

    async function start() {
      try {
        setStatus('loading');

        const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
        if (cancelled) return;

        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: await resolveModelUrl(), delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        if (!own(() => landmarker.close())) return;

        setStatus('requesting');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        if (!own(() => stream.getTracks().forEach((t) => t.stop()))) return;

        const video = videoRef.current;
        if (!video) throw new Error('Video element not mounted');
        video.srcObject = stream;
        if (
          !own(() => {
            video.pause();
            video.srcObject = null;
          })
        ) {
          return;
        }
        await video.play();
        if (cancelled) return;

        const flush = setInterval(() => {
          if (pending) {
            setHands(pending.hands);
            setPosture(pending.posture);
            pending = null;
          }
          // Only publish stats that actually moved. Setting a fresh object every
          // tick re-rendered the whole app 12x/s while nothing was happening,
          // on top of the audio hook's own flush — which defeats half the point
          // of throttling in the first place.
          const next: TrackingStats = {
            frames: counters.frames,
            inferences: counters.inferences,
            skipped: counters.skipped,
            meanInferenceMs: counters.inferences ? counters.totalMs / counters.inferences : 0,
            worstInferenceMs: counters.worstMs,
            fps: recentInferences.length,
          };
          if (!statsEqual(next, lastStats)) {
            lastStats = next;
            setStats(next);
          }
        }, 1000 / UI_UPDATE_HZ);
        if (!own(() => clearInterval(flush))) return;

        setStatus('running');
        loop(landmarker);
      } catch (error) {
        // Release whatever startup got as far as acquiring. Reaching here after
        // HandLandmarker.createFromOptions succeeded — permission denied, no
        // camera, i.e. the advertised audio-only path — otherwise held the
        // landmarker, its running GL graph and the ~7.8 MB model for the whole
        // session. Stop would eventually free them, but the session never
        // needed them at all.
        releaseAll();
        if (cancelled) return;
        setStatus('error');
        setFailure(describeMediaError(error, 'camera'));
      }
    }

    function loop(landmarker: HandLandmarker) {
      // Guard as well as cancelling the frame: a frame already dispatched when
      // teardown ran would otherwise call into a closed landmarker.
      if (cancelled) return;

      rafId = requestAnimationFrame(() => loop(landmarker));
      counters.frames++;

      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const now = performance.now();

      // Rate cap. Running MediaPipe at display refresh rate burns GPU for no
      // coaching benefit — a hand does not change shape in 8 ms.
      if (now - lastInferenceAt < minInterval) {
        counters.skipped++;
        return;
      }
      // detectForVideo throws if handed the same timestamp twice.
      if (video.currentTime === lastVideoTime) return;

      lastInferenceAt = now;
      lastVideoTime = video.currentTime;

      const started = performance.now();
      let result: HandLandmarkerResult;
      try {
        result = landmarker.detectForVideo(video, started);
      } catch {
        // A single failed inference is not worth ending the session over.
        return;
      }
      const elapsed = performance.now() - started;

      counters.inferences++;
      counters.totalMs += elapsed;
      if (elapsed > counters.worstMs) counters.worstMs = elapsed;

      recentInferences.push(now);
      while (recentInferences.length && now - recentInferences[0] > 1000) recentInferences.shift();

      const { activeFingers, frettingHand, inputMirrored = false } = optionsRef.current;

      const tracked: TrackedHand[] = result.landmarks.map((landmarks, i) => {
        const raw = result.handedness[i]?.[0];
        const rawLabel = raw?.categoryName ?? 'Unknown';
        return {
          handedness: resolveHandedness(rawLabel, inputMirrored),
          rawHandedness: rawLabel,
          confidence: raw?.score ?? 0,
          landmarks: landmarks as Landmark[],
        };
      });

      // Refuses to choose when two hands both claim to be the fretting hand,
      // rather than coaching whichever happened to be detected first.
      const selection = selectFrettingHand(tracked, frettingHand);
      const fretting = selection.index >= 0 ? tracked[selection.index] : null;

      const aspect = video.videoWidth / video.videoHeight || 16 / 9;

      let report: PostureReport | null = null;
      if (fretting) {
        // The tracker restarts warmup by itself if this is not the same hand it
        // saw last frame, so a mid-session change of fretting hand — or a
        // MediaPipe label swap — reports 'unreliable' instead of a verdict
        // blended from two different hands.
        const frame = tracker.track({
          frettingHand,
          index: selection.index,
          landmarks: fretting.landmarks,
          worldLandmarks: result.worldLandmarks?.[selection.index] as Landmark[] | undefined,
          aspect,
        });

        if (frame) {
          report = analyzePosture({
            landmarks: frame.landmarks,
            worldLandmarks: frame.worldLandmarks,
            aspect,
            confidence: fretting.confidence,
            activeFingers,
            framesObserved: frame.framesObserved,
          });
        }
      } else {
        // Tracking continuity is broken either way; restarting the warmup means
        // the next verdict is not built on landmarks from a different hand.
        tracker.reset();
        // Only when a hand was present but unidentifiable. A plain "fretting
        // hand not in frame" is left as null, which the panel words differently.
        if (selection.reason) report = unassessable(selection.reason, activeFingers);
      }

      pending = { hands: tracked, posture: report };
    }

    void start();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      releaseAll();
      tracker.reset();
      pending = null;
      lastStats = EMPTY_STATS;
      setHands([]);
      setPosture(null);
      setStatus('idle');
      setStats(EMPTY_STATS);
    };
  }, [enabled, videoRef]);

  return { hands, posture, status, failure, stats };
}

/**
 * Prefer a locally served model; fall back to the pinned Google URL.
 *
 * The wasm runtime ships inside the npm package and is always served locally.
 * The .task model is not in the package, so `npm run fetch-assets` downloads it
 * into public/models/. If that has not been run, this falls back to a
 * version-pinned URL — which means a runtime network dependency. That fallback
 * is documented in the README rather than hidden.
 */
async function resolveModelUrl(): Promise<string> {
  try {
    const response = await fetch(LOCAL_HAND_MODEL_URL, { method: 'HEAD' });
    if (response.ok) return LOCAL_HAND_MODEL_URL;
  } catch {
    // Not served locally; fall through.
  }
  return HAND_MODEL_FALLBACK_URL;
}
