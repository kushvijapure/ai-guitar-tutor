import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisStats, FromWorker, PitchReading, ToWorker } from '../audio/messages';
import type { ChordDecision } from '../lib/chordDecision';
import type { ChordSpec } from '../lib/chroma';
import { describeMediaError, type MediaFailure } from '../lib/mediaErrors';
import { FRAME_SIZE, HOP_SIZE, UI_UPDATE_HZ } from '../lib/thresholds';

/**
 * Microphone capture and chord analysis.
 *
 * Thread layout, and why:
 *
 *   audio thread   capture-worklet.js   reblocks 128-sample quanta into hops
 *   main thread    (relay only)         transfers each hop onward, no DSP
 *   worker thread  analysis.worker.ts   FFT, YIN, chord decision
 *   main thread    this hook            throttles results into React state
 *
 * The prototype ran YIN and an FFT on the main thread inside requestAnimationFrame
 * and called setState on every frame, so it did ~5 million operations per frame
 * at 60 Hz and re-rendered the whole app each time. Nothing here runs on the
 * main thread except passing buffers along.
 *
 * Note that the decision state machine lives in the Worker, at the full analysis
 * rate. Throttling React updates therefore changes only how often the player
 * sees a number change — it cannot weaken the gates that decide correctness.
 */

export type AudioStatus = 'idle' | 'requesting' | 'starting' | 'running' | 'error';

export interface AudioState {
  decision: ChordDecision | null;
  pitch: PitchReading | null;
  stats: AnalysisStats | null;
}

const EMPTY: AudioState = { decision: null, pitch: null, stats: null };

export function useAudio(enabled: boolean, expected: ChordSpec) {
  const [state, setState] = useState<AudioState>(EMPTY);
  const [status, setStatus] = useState<AudioStatus>('idle');
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  /** Whatever the browser actually gave us — 44.1 or 48 kHz, not an assumption. */
  const [sampleRate, setSampleRate] = useState<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  /** Newest result from the worker, drained into React on a fixed cadence. */
  const pending = useRef<AudioState | null>(null);

  // Read during start-up without making the target chord a dependency of the
  // effect that builds the audio graph — changing chord must not tear the
  // microphone down and ask for permission again.
  const expectedRef = useRef(expected);
  expectedRef.current = expected;

  // Keep the worker's target chord in sync without restarting the pipeline.
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'expected', chord: expected } satisfies ToWorker);
  }, [expected]);

  const calibrate = useCallback(() => {
    workerRef.current?.postMessage({ type: 'calibrate' } satisfies ToWorker);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setState(EMPTY);
      setFailure(null);
      return;
    }

    let cancelled = false;

    // Every resource acquired gets a teardown pushed here immediately, so an
    // failure part-way through start-up still releases what already succeeded.
    // Repeated start/stop cycles were leaking microphone streams otherwise.
    const teardown: Array<() => void> = [];

    async function start() {
      let stream: MediaStream | undefined;
      let context: AudioContext | undefined;

      try {
        setStatus('requesting');
        setFailure(null);

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // All three off: they are tuned for speech and will chew a guitar
            // apart — noise suppression in particular gates sustained notes.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        const acquired = stream;
        teardown.push(() => acquired.getTracks().forEach((t) => t.stop()));
        if (cancelled) return;

        setStatus('starting');

        context = new AudioContext();
        const ctx = context;
        setSampleRate(ctx.sampleRate);
        teardown.push(() => void ctx.close().catch(() => {}));
        if (ctx.state === 'suspended') await ctx.resume();
        if (cancelled) return;

        await ctx.audioWorklet.addModule(new URL('../audio/capture-worklet.js', import.meta.url));
        if (cancelled) return;

        const worker = new Worker(new URL('../audio/analysis.worker.ts', import.meta.url), {
          type: 'module',
        });
        teardown.push(() => worker.terminate());
        workerRef.current = worker;
        teardown.push(() => {
          if (workerRef.current === worker) workerRef.current = null;
        });

        worker.postMessage({
          type: 'init',
          sampleRate: ctx.sampleRate,
          frameSize: FRAME_SIZE,
          hopSize: HOP_SIZE,
        } satisfies ToWorker);
        worker.postMessage({ type: 'expected', chord: expectedRef.current } satisfies ToWorker);
        worker.postMessage({ type: 'calibrate' } satisfies ToWorker);

        worker.onmessage = (event: MessageEvent<FromWorker>) => {
          const message = event.data;
          if (message.type === 'error') {
            setStatus('error');
            setFailure({
              title: 'Audio analysis failed',
              detail: `${message.message} Reloading the page usually clears this.`,
              recoverable: true,
            });
            return;
          }
          // Overwrite rather than queue: if React is behind, the newest reading
          // is the only one worth showing.
          pending.current = {
            decision: message.decision,
            pitch: message.pitch,
            stats: message.stats,
          };
        };

        const source = ctx.createMediaStreamSource(stream);
        teardown.push(() => source.disconnect());

        const capture = new AudioWorkletNode(ctx, 'capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          processorOptions: { hopSize: HOP_SIZE },
        });
        teardown.push(() => {
          capture.port.postMessage('stop');
          capture.port.onmessage = null;
          capture.disconnect();
        });

        capture.port.onmessage = (event: MessageEvent<{ samples: Float32Array; rms: number; time: number }>) => {
          const { samples, rms, time } = event.data;
          // Transfer rather than copy — the worklet already handed ownership over.
          worker.postMessage({ type: 'audio', samples, rms, time } satisfies ToWorker, [
            samples.buffer,
          ]);
        };

        // A muted sink keeps the graph pulling. Without a path to the
        // destination some browsers never schedule the worklet's process().
        const mute = ctx.createGain();
        mute.gain.value = 0;
        teardown.push(() => mute.disconnect());

        source.connect(capture);
        capture.connect(mute);
        mute.connect(ctx.destination);

        // Drain the newest result into React on a fixed cadence rather than on
        // every message. Analysis stays at ~21 Hz; the UI settles for ~12.
        const flush = setInterval(() => {
          if (pending.current) {
            setState(pending.current);
            pending.current = null;
          }
        }, 1000 / UI_UPDATE_HZ);
        teardown.push(() => clearInterval(flush));

        if (cancelled) return;
        setStatus('running');
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setFailure(describeMediaError(error, 'microphone'));
      }
    }

    void start();

    return () => {
      cancelled = true;
      // Reverse order so nodes are disconnected before the context closes.
      for (const release of teardown.reverse()) {
        try {
          release();
        } catch {
          // A teardown step failing must not prevent the rest from running.
        }
      }
      pending.current = null;
      setState(EMPTY);
      setStatus('idle');
      setSampleRate(null);
    };
  }, [enabled]);

  return { ...state, status, failure, calibrate, sampleRate };
}
