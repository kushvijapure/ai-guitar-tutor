import { useEffect, useRef, useState } from 'react';
import { detectPitch } from '../lib/pitch';
import { computeChroma, matchChord, type Chroma, type ChordMatch } from '../lib/chroma';

const FFT_SIZE = 8192; // ~5.4 Hz resolution at 44.1 kHz — enough to separate low frets.
/** Smoothing on the chroma vector. Raw frames flicker badly during a strum decay. */
const CHROMA_SMOOTHING = 0.6;

export interface AudioAnalysis {
  /** Detected fundamental, monophonic. Null when silent or unclear. */
  frequency: number | null;
  clarity: number;
  /** Smoothed 12-bin pitch-class profile. */
  chroma: Chroma | null;
  /** Top chord candidates, best first. */
  chords: ChordMatch[];
  /** Peak level 0..1, for the input meter. */
  level: number;
}

export type AudioStatus = 'idle' | 'loading' | 'running' | 'error';

const EMPTY: AudioAnalysis = {
  frequency: null,
  clarity: 0,
  chroma: null,
  chords: [],
  level: 0,
};

export function useAudio(enabled: boolean) {
  const [analysis, setAnalysis] = useState<AudioAnalysis>(EMPTY);
  const [status, setStatus] = useState<AudioStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const smoothedChroma = useRef<Float32Array | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function start() {
      try {
        setStatus('loading');

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // All three off: they're tuned for speech and will chew up a guitar.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const context = new AudioContext();
        contextRef.current = context;

        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);

        const timeData = new Float32Array(analyser.fftSize);
        const freqData = new Float32Array(analyser.frequencyBinCount);

        if (cancelled) return;
        setStatus('running');

        function loop() {
          analyser.getFloatTimeDomainData(timeData);
          analyser.getFloatFrequencyData(freqData);

          let peak = 0;
          for (let i = 0; i < timeData.length; i++) {
            peak = Math.max(peak, Math.abs(timeData[i]));
          }

          const pitch = detectPitch(timeData, context.sampleRate);
          const rawChroma = computeChroma(freqData, context.sampleRate);

          if (rawChroma) {
            if (!smoothedChroma.current) {
              smoothedChroma.current = new Float32Array(rawChroma);
            } else {
              const prev = smoothedChroma.current;
              for (let i = 0; i < 12; i++) {
                prev[i] = prev[i] * CHROMA_SMOOTHING + rawChroma[i] * (1 - CHROMA_SMOOTHING);
              }
            }
          }

          const chroma = smoothedChroma.current;
          setAnalysis({
            frequency: pitch?.frequency ?? null,
            clarity: pitch?.clarity ?? 0,
            chroma: chroma ? new Float32Array(chroma) : null,
            chords: chroma && peak > 0.01 ? matchChord(chroma) : [],
            level: peak,
          });

          rafRef.current = requestAnimationFrame(loop);
        }

        loop();
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      contextRef.current?.close();
      contextRef.current = null;
      smoothedChroma.current = null;
      setStatus('idle');
      setAnalysis(EMPTY);
    };
  }, [enabled]);

  return { analysis, status, error };
}
