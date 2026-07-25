import { useEffect, useRef, type RefObject } from 'react';
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

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  hands: TrackedHand[];
  /** Which hand to highlight as the fretting hand. */
  frettingHand: string;
}

export function CameraView({ videoRef, hands, frettingHand }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { clientWidth: width, clientHeight: height } = canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    for (const hand of hands) {
      const isFretting = hand.handedness === frettingHand;
      const stroke = isFretting ? '#5eead4' : 'rgba(148, 163, 184, 0.45)';
      const fill = isFretting ? '#f0fdfa' : 'rgba(148, 163, 184, 0.6)';

      // Video is mirrored via CSS, so mirror the landmarks to match.
      const px = (i: number) => (1 - hand.landmarks[i].x) * width;
      const py = (i: number) => hand.landmarks[i].y * height;

      ctx.lineWidth = isFretting ? 3 : 2;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
      }
      ctx.stroke();

      ctx.fillStyle = fill;
      for (let i = 0; i < hand.landmarks.length; i++) {
        // Fingertips slightly larger — they're what the coaching cues talk about.
        const isTip = [4, 8, 12, 16, 20].includes(i);
        ctx.beginPath();
        ctx.arc(px(i), py(i), isTip && isFretting ? 6 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [hands, videoRef, frettingHand]);

  return (
    <div className="camera-view">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} />
    </div>
  );
}
