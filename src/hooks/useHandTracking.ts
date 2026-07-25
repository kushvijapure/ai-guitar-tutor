import { useEffect, useRef, useState, type RefObject } from 'react';
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Landmark } from '../lib/posture';

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export interface TrackedHand {
  /** 'Left' | 'Right' as MediaPipe reports it (mirrored — see App for the flip). */
  handedness: string;
  landmarks: Landmark[];
}

export type TrackingStatus = 'idle' | 'loading' | 'running' | 'error';

export function useHandTracking(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const [hands, setHands] = useState<TrackedHand[]>([]);
  const [status, setStatus] = useState<TrackingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastVideoTime = useRef(-1);
  const frameTimes = useRef<number[]>([]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function start() {
      try {
        setStatus('loading');

        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
        if (cancelled) return;

        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) throw new Error('Video element not mounted');
        video.srcObject = stream;
        await video.play();

        if (cancelled) return;
        setStatus('running');
        loop();
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    function loop() {
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;

      if (video && landmarker && video.readyState >= 2) {
        // detectForVideo throws if handed the same timestamp twice.
        if (video.currentTime !== lastVideoTime.current) {
          lastVideoTime.current = video.currentTime;

          const now = performance.now();
          const result: HandLandmarkerResult = landmarker.detectForVideo(video, now);

          setHands(
            result.landmarks.map((landmarks, i) => ({
              handedness: result.handedness[i]?.[0]?.categoryName ?? 'Unknown',
              landmarks: landmarks as Landmark[],
            })),
          );

          frameTimes.current.push(now);
          while (frameTimes.current.length > 0 && now - frameTimes.current[0] > 1000) {
            frameTimes.current.shift();
          }
          setFps(frameTimes.current.length);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      setStatus('idle');
      setHands([]);
    };
  }, [enabled, videoRef]);

  return { hands, status, error, fps };
}
