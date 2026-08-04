import { useEffect, useRef, useState, type RefObject } from 'react';
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  analyzePosture,
  LandmarkSmoother,
  resolveHandedness,
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

    const smoother = new LandmarkSmoother();
    const worldSmoother = new LandmarkSmoother();

    let rafId: number | null = null;
    let lastVideoTime = -1;
    let lastInferenceAt = 0;
    const minInterval = 1000 / HAND_TRACKING_FPS;

    const counters = { frames: 0, inferences: 0, skipped: 0, totalMs: 0, worstMs: 0 };
    const recentInferences: number[] = [];

    /** Newest result, drained into React on a fixed cadence. */
    let pending: { hands: TrackedHand[]; posture: PostureReport | null } | null = null;

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
        teardown.push(() => landmarker.close());
        if (cancelled) return;

        setStatus('requesting');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        teardown.push(() => stream.getTracks().forEach((t) => t.stop()));
        if (cancelled) return;

        const video = videoRef.current;
        if (!video) throw new Error('Video element not mounted');
        video.srcObject = stream;
        teardown.push(() => {
          video.pause();
          video.srcObject = null;
        });
        await video.play();
        if (cancelled) return;

        const flush = setInterval(() => {
          if (pending) {
            setHands(pending.hands);
            setPosture(pending.posture);
            pending = null;
          }
          setStats({
            frames: counters.frames,
            inferences: counters.inferences,
            skipped: counters.skipped,
            meanInferenceMs: counters.inferences ? counters.totalMs / counters.inferences : 0,
            worstInferenceMs: counters.worstMs,
            fps: recentInferences.length,
          });
        }, 1000 / UI_UPDATE_HZ);
        teardown.push(() => clearInterval(flush));

        setStatus('running');
        loop(landmarker);
      } catch (error) {
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

      const frettingIndex = tracked.findIndex((h) => h.handedness === frettingHand);
      const fretting = frettingIndex >= 0 ? tracked[frettingIndex] : null;

      let report: PostureReport | null = null;
      if (fretting) {
        const smoothed = smoother.push(fretting.landmarks);
        const world = result.worldLandmarks?.[frettingIndex] as Landmark[] | undefined;
        const smoothedWorld = world ? worldSmoother.push(world) : null;

        if (smoothed) {
          report = analyzePosture({
            landmarks: smoothed,
            worldLandmarks: smoothedWorld ?? undefined,
            aspect: video.videoWidth / video.videoHeight || 16 / 9,
            confidence: fretting.confidence,
            activeFingers,
            framesObserved: smoother.framesObserved(),
          });
        }
      } else {
        smoother.reset();
        worldSmoother.reset();
      }

      pending = { hands: tracked, posture: report };
    }

    void start();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      for (const release of teardown.reverse()) {
        try {
          release();
        } catch {
          // Keep tearing down even if one step fails.
        }
      }
      smoother.reset();
      worldSmoother.reset();
      pending = null;
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
