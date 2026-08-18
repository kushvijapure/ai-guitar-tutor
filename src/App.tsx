import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAudio } from './hooks/useAudio';
import { useHandTracking } from './hooks/useHandTracking';
import { activeFingersFor } from './lib/posture';
import type { ChordSpec } from './lib/chroma';
import { checkSupport } from './lib/mediaErrors';
import { nearestString } from './lib/notes';
import { OPEN_CHORDS_LESSON } from './lessons/openChords';
import { CameraView } from './components/CameraView';
import { ChordStatusPanel } from './components/ChordStatusPanel';
import { Diagnostics } from './components/Diagnostics';
import { FeedbackPanel, type CameraPhase } from './components/FeedbackPanel';
import { SessionIntro } from './components/SessionIntro';
import './App.css';

/**
 * The video preview is mirrored for the player's benefit (a mirror is what you
 * are used to checking your hands in), but MediaPipe is fed the raw frames.
 * That distinction drives handedness resolution — see resolveHandedness().
 */
const PREVIEW_MIRRORED = true;
const MEDIAPIPE_INPUT_MIRRORED = false;

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [frettingHand, setFrettingHand] = useState('Left');
  const [chordIndex, setChordIndex] = useState(0);
  const [passed, setPassed] = useState<string[]>([]);
  const [holdProgress, setHoldProgress] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const unsupported = useMemo(() => checkSupport(), []);
  const lesson = OPEN_CHORDS_LESSON;
  const chord = lesson.chords[chordIndex];

  const expected = useMemo<ChordSpec>(
    () => ({ root: chord.root, quality: chord.quality }),
    [chord.root, chord.quality],
  );
  const activeFingers = useMemo(() => activeFingersFor(chord.fingers), [chord.fingers]);

  const audio = useAudio(active && !unsupported, expected);
  const video = useHandTracking(videoRef, active && cameraEnabled && !unsupported, {
    activeFingers,
    frettingHand,
    inputMirrored: MEDIAPIPE_INPUT_MIRRORED,
  });

  const decision = audio.decision;
  const confirmed = decision?.status === 'confirmed';

  // Audio-only mode: the camera failing must not stop the session. Chord
  // coaching is the part that actually judges correctness, and it is unaffected.
  const fretting = video.hands.find((h) => h.handedness === frettingHand) ?? null;

  // Distinguishes "not started yet" and "still coming up" from the audio-only
  // fallback, so the hand panel cannot announce a fallback that has not happened.
  const cameraPhase: CameraPhase = !active
    ? 'idle'
    : !cameraEnabled || video.status === 'error'
      ? 'unavailable'
      : video.status === 'running'
        ? 'running'
        : 'starting';

  // ---- Hold timer ---------------------------------------------------------
  // Runs only while the decision is 'confirmed'. Because confirmation already
  // requires several agreeing analysis windows, a brief or ambiguous match can
  // never start this, let alone complete it.
  const holdStart = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !confirmed) {
      holdStart.current = null;
      setHoldProgress(0);
      return;
    }

    holdStart.current ??= performance.now();

    const id = setInterval(() => {
      if (holdStart.current === null) return;
      const elapsed = (performance.now() - holdStart.current) / 1000;
      const progress = Math.min(1, elapsed / lesson.holdSeconds);
      setHoldProgress(progress);

      if (progress >= 1) {
        holdStart.current = null;
        setPassed((prev) => (prev.includes(chord.id) ? prev : [...prev, chord.id]));
        setChordIndex((i) => (i + 1) % lesson.chords.length);
      }
    }, 80);

    return () => clearInterval(id);
  }, [active, confirmed, chord.id, lesson.holdSeconds, lesson.chords.length]);

  // ---- Screen-reader announcements ---------------------------------------
  // Announce only on transition, not on every update, or a live region at
  // 12 Hz becomes unusable noise.
  const [announcement, setAnnouncement] = useState('');
  const lastAnnounced = useRef('');
  useEffect(() => {
    if (!active) return;
    const message = describeForScreenReader(
      decision?.status,
      chord.name,
      decision?.missing,
      decision?.calibrationUnusable,
    );
    if (message && message !== lastAnnounced.current) {
      lastAnnounced.current = message;
      setAnnouncement(message);
    }
  }, [decision?.status, decision?.missing, decision?.calibrationUnusable, chord.name, active]);

  const stop = useCallback(() => {
    setActive(false);
    setHoldProgress(0);
    holdStart.current = null;
    lastAnnounced.current = '';
    setAnnouncement('');
  }, []);

  const tuner = audio.pitch && audio.pitch.clarity > 0.6 ? nearestString(audio.pitch.frequency) : null;

  return (
    <div className="app">
      <a className="skip-link" href="#coaching">
        Skip to coaching
      </a>

      <header>
        <div>
          <h1>Guitar Tutor</h1>
          <p className="muted">
            {lesson.title} — {lesson.blurb}
          </p>
        </div>

        <div className="header-actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={cameraEnabled}
              onChange={(e) => setCameraEnabled(e.target.checked)}
              disabled={active}
            />
            Use camera
          </label>

          <label className="hand-toggle">
            Fretting hand
            {/* Locked during a session: changing the selection mid-session
                switches which hand is tracked, which contaminates the landmark
                smoother with two different hands. See useHandTracking. */}
            <select
              value={frettingHand}
              onChange={(e) => setFrettingHand(e.target.value)}
              disabled={active}
            >
              <option value="Left">Left</option>
              <option value="Right">Right</option>
            </select>
          </label>

          <button
            type="button"
            className={active ? 'stop' : 'start'}
            onClick={() => (active ? stop() : setActive(true))}
            disabled={Boolean(unsupported)}
          >
            {active ? 'Stop' : 'Start session'}
          </button>
        </div>
      </header>

      {unsupported && (
        <div className="error-banner" role="alert">
          <strong>Not supported.</strong> {unsupported}
        </div>
      )}

      {/* Separate status per device: one failing says nothing about the other. */}
      {active && (
        <div className="device-status">
          <DeviceChip
            label="Microphone"
            state={audio.status === 'running' ? 'ok' : audio.status === 'error' ? 'error' : 'pending'}
            detail={
              audio.failure
                ? `${audio.failure.title}: ${audio.failure.detail}`
                : audio.status === 'requesting'
                  ? 'Waiting for permission…'
                  : audio.status === 'starting'
                    ? 'Starting…'
                    : 'Listening'
            }
          />
          {cameraEnabled && (
            <DeviceChip
              label="Camera"
              state={video.status === 'running' ? 'ok' : video.status === 'error' ? 'error' : 'pending'}
              detail={
                video.failure
                  ? `${video.failure.title}: ${video.failure.detail}`
                  : video.status === 'loading'
                    ? 'Loading hand model…'
                    : video.status === 'requesting'
                      ? 'Waiting for permission…'
                      : 'Tracking'
              }
            />
          )}
        </div>
      )}

      {active && video.status === 'error' && (
        <div className="notice" role="status">
          Continuing in <strong>audio-only mode</strong>. Chord coaching is unaffected; hand-shape
          coaching is unavailable until the camera works.
        </div>
      )}

      <main id="coaching">
        <section className="stage">
          {active && cameraEnabled && video.status !== 'error' ? (
            <CameraView
              videoRef={videoRef}
              hands={video.hands}
              frettingHand={frettingHand}
              mirrored={PREVIEW_MIRRORED}
            />
          ) : active ? (
            <div className="placeholder audio-only-stage">
              <h2>Audio-only mode</h2>
              <p className="muted">
                Listening to what you play. Hand-shape coaching needs the camera.
              </p>
            </div>
          ) : (
            <SessionIntro cameraEnabled={cameraEnabled} />
          )}

          {active && (
            <div className="stage-status">
              <span className="level-label" id="level-label">
                Input level
              </span>
              <div
                className="level-meter"
                role="meter"
                aria-labelledby="level-label"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(Math.min(1, (decision?.level ?? 0) * 12) * 100)}
              >
                <div style={{ width: `${Math.min(100, (decision?.level ?? 0) * 1200)}%` }} />
              </div>
              {/* Rooms change — a fan starts, someone shuts a door. Remeasuring
                  the floor is cheaper than making the player restart. */}
              <button type="button" className="link-button" onClick={audio.calibrate}>
                Recalibrate noise
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => setShowDiagnostics((v) => !v)}
                aria-expanded={showDiagnostics}
              >
                {showDiagnostics ? 'Hide' : 'Show'} diagnostics
              </button>
            </div>
          )}

          {showDiagnostics && active && (
            <Diagnostics
              audio={audio.stats}
              video={video.stats}
              sampleRate={audio.sampleRate}
              onClose={() => setShowDiagnostics(false)}
            />
          )}
        </section>

        <aside className="sidebar">
          <ChordStatusPanel
            chord={chord}
            index={chordIndex}
            total={lesson.chords.length}
            decision={decision}
            holdProgress={holdProgress}
            holdSeconds={lesson.holdSeconds}
            active={active}
          />

          <FeedbackPanel
            posture={video.posture}
            handDetected={Boolean(fretting)}
            cameraPhase={cameraPhase}
          />

          <section className="panel" aria-labelledby="tuner-heading">
            <h3 id="tuner-heading">Tuner</h3>
            {tuner ? (
              <div className="tuner">
                <strong>{tuner.string.label}</strong>
                <div
                  className="tuner-bar"
                  role="meter"
                  aria-label={`${tuner.string.label}, ${tuner.cents} cents`}
                  aria-valuemin={-50}
                  aria-valuemax={50}
                  aria-valuenow={tuner.cents}
                >
                  <div className="tuner-center" />
                  <div
                    className="tuner-needle"
                    style={{ left: `${50 + Math.max(-50, Math.min(50, tuner.cents))}%` }}
                  />
                </div>
                <span className={Math.abs(tuner.cents) < 5 ? 'in-tune' : undefined}>
                  {tuner.cents > 0 ? '+' : ''}
                  {tuner.cents} cents
                </span>
              </div>
            ) : (
              <p className="muted">Play one open string on its own.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="progress-heading">
            <h3 id="progress-heading">Progress</h3>
            <ol className="progress-list">
              {lesson.chords.map((c, i) => {
                const done = passed.includes(c.id);
                return (
                  <li key={c.id} className={done ? 'done' : i === chordIndex ? 'current' : undefined}>
                    <button
                      type="button"
                      onClick={() => setChordIndex(i)}
                      aria-current={i === chordIndex ? 'step' : undefined}
                    >
                      <span>{c.name}</span>
                      <span className="progress-mark" aria-label={done ? 'passed' : undefined}>
                        {done ? '✓' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="muted count">
              {passed.length} of {lesson.chords.length} held cleanly
            </p>
          </section>
        </aside>
      </main>

      {/* Single polite live region; updated only when the state actually changes. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function DeviceChip({
  label,
  state,
  detail,
}: {
  label: string;
  state: 'ok' | 'pending' | 'error';
  detail: string;
}) {
  return (
    <div className={`chip chip-${state}`} role={state === 'error' ? 'alert' : undefined}>
      <span className="chip-label">{label}</span>
      <span className="chip-detail">{detail}</span>
    </div>
  );
}

function describeForScreenReader(
  status: string | undefined,
  chordName: string,
  missing: string[] | null | undefined,
  calibrationUnusable: boolean | undefined,
): string {
  // Checked ahead of the status switch because the failure it describes
  // presents AS 'silent': the room was measured too loud, so the player's
  // actual guitar is being classified as silence. Announcing "waiting for you
  // to play" to someone who is already playing, into an app that cannot hear
  // them, is the precise confusion this state exists to end — and a sighted
  // user gets the explanation from ChordStatusPanel either way.
  if (calibrationUnusable) {
    return 'The room was too noisy to calibrate. Get quiet, then use the Recalibrate noise button.';
  }

  switch (status) {
    case 'calibrating': return 'Measuring room noise. Please stay quiet.';
    case 'silent': return 'Waiting for you to play.';
    case 'listening': return 'Listening.';
    case 'ambiguous': return 'Cannot tell what you played.';
    case 'incomplete':
      return missing?.length
        ? `Not all notes ringing. Missing ${missing.join(', ')}.`
        : 'Not all notes of the chord are ringing.';
    case 'wrong': return `That is not ${chordName}.`;
    case 'confirmed': return `${chordName} confirmed. Hold it steady.`;
    default: return '';
  }
}
