import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { TrackedHand } from '../hooks/useHandTracking';

/** Bone pairs for drawing the hand skeleton. */
const CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [0, 17],                                   // palm base
];

const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

/** Landmark count MediaPipe returns for a hand; anything less is unusable here. */
const LANDMARK_COUNT = 21;

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  hands: TrackedHand[];
  /** Which hand to highlight as the fretting hand. */
  frettingHand: string;
  /** Whether the preview is mirrored on screen; the overlay must match. */
  mirrored: boolean;
}

/**
 * How a normalized landmark maps onto the on-screen preview box.
 *
 * The <video> is styled `object-fit: cover` inside a fixed 16:9 box, so unless
 * the camera happens to deliver exactly 16:9 the picture is scaled up and
 * centre-cropped. Landmarks are normalized to the *raw frame*, so mapping them
 * linearly across the box — what this component used to do — puts the skeleton
 * off the hand by however much was cropped. getUserMedia is asked for 1280x720
 * with `ideal`, which is a preference and not a constraint, so a 4:3 webcam
 * really does land here.
 *
 * Mirroring is applied about the frame's own centre, which coincides with the
 * box centre because cover-cropping is symmetric.
 */
function coverFit(boxW: number, boxH: number, frameW: number, frameH: number) {
  // Degenerate metrics (video not yet loaded) fall back to a plain stretch.
  if (!(frameW > 0) || !(frameH > 0)) {
    return { scaleX: boxW, scaleY: boxH, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(boxW / frameW, boxH / frameH);
  const drawnW = frameW * scale;
  const drawnH = frameH * scale;
  return {
    scaleX: drawnW,
    scaleY: drawnH,
    offsetX: (boxW - drawnW) / 2,
    offsetY: (boxH - drawnH) / 2,
  };
}

export function CameraView({ videoRef, hands, frettingHand, mirrored }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match the backing store to the CSS size and device pixel ratio, or the
    // overlay is blurry on a high-DPI screen and misaligned after a resize.
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const video = videoRef.current;
    const fit = coverFit(width, height, video?.videoWidth ?? 0, video?.videoHeight ?? 0);

    for (const hand of hands) {
      // A partial landmark set would index undefined below. MediaPipe does not
      // emit one, but the overlay is not worth a render crash if it ever does.
      if (hand.landmarks.length < LANDMARK_COUNT) continue;

      const isFretting = hand.handedness === frettingHand;
      ctx.strokeStyle = isFretting ? '#5eead4' : 'rgba(148, 163, 184, 0.45)';
      ctx.fillStyle = isFretting ? '#f0fdfa' : 'rgba(148, 163, 184, 0.6)';
      ctx.lineWidth = isFretting ? 3 : 2;

      // Landmarks are in the raw (unmirrored) frame's coordinates. Flip them
      // here when the preview is mirrored so the skeleton sits on the hand.
      const px = (i: number) => {
        const nx = mirrored ? 1 - hand.landmarks[i].x : hand.landmarks[i].x;
        return fit.offsetX + nx * fit.scaleX;
      };
      const py = (i: number) => fit.offsetY + hand.landmarks[i].y * fit.scaleY;

      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
      }
      ctx.stroke();

      for (let i = 0; i < LANDMARK_COUNT; i++) {
        ctx.beginPath();
        ctx.arc(px(i), py(i), FINGERTIPS.has(i) && isFretting ? 6 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [videoRef, hands, frettingHand, mirrored]);

  useEffect(() => {
    draw();
  }, [draw]);

  // The overlay is sized from the canvas's CSS box, so a layout change
  // invalidates it. Without this the skeleton stays at the old scale until the
  // next tracking update happens to arrive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div className="camera-view">
      <video
        ref={videoRef}
        playsInline
        muted
        className={mirrored ? 'mirrored' : undefined}
        aria-label="Camera preview of your fretting hand"
      />
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
