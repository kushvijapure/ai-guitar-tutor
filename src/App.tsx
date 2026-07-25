import { useEffect, useMemo, useRef, useState } from 'react';
import { useHandTracking } from './hooks/useHandTracking';
import { useAudio } from './hooks/useAudio';
import { analyzePosture, type PostureReport } from './lib/posture';
import { missingTones } from './lib/chroma';
import { nearestString } from './lib/notes';
import { OPEN_CHORDS_LESSON } from './lessons/openChords';
import { CameraView } from './components/CameraView';
import { ChordDiagram } from './components/ChordDiagram';
import { FeedbackPanel } from './components/FeedbackPanel';
import './App.css';

/** Cosine similarity above which we accept the expected chord as "being played". */
const CHORD_MATCH_THRESHOLD = 0.82;

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [frettingHand, setFrettingHand] = useState('Left');
  const [chordIndex, setChordIndex] = useState(0);
  const [passed, setPassed] = useState<string[]>([]);
  const [holdProgress, setHoldProgress] = useState(0);

  const { hands, status: videoStatus, error: videoError, fps } = useHandTracking(videoRef, active);
  const { analysis, status: audioStatus, error: audioError } = useAudio(active);

  const lesson = OPEN_CHORDS_LESSON;
  const chord = lesson.chords[chordIndex];

  const fretting = hands.find((h) => h.handedness === frettingHand) ?? hands[0];
  const posture: PostureReport | null = useMemo(
    () => (fretting ? analyzePosture(fretting.landmarks) : null),
    [fretting],
  );

  // How well the current audio matches the chord we're asking for.
  const expectedScore = useMemo(() => {
    const match = analysis.chords.find(
      (c) => c.root === chord.root && c.quality === chord.quality,
    );
    return match?.score ?? 0;
  }, [analysis.chords, chord]);

  const missing = useMemo(
    () => (analysis.chroma ? missingTones(analysis.chroma, chord.root, chord.quality) : []),
    [analysis.chroma, chord],
  );

  const isCorrect = expectedScore >= CHORD_MATCH_THRESHOLD;

  // Hold timer: the chord has to stay correct for holdSeconds before it passes.
  // Tracked with wall-clock deltas rather than a frame count so it doesn't drift
  // when the render loop slows down.
  const holdStart = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !isCorrect) {
      holdStart.current = null;
      setHoldProgress(0);
      return;
    }

    if (holdStart.current === null) holdStart.current = performance.now();

    const id = setInterval(() => {
      if (holdStart.current === null) return;
      const elapsed = (performance.now() - holdStart.current) / 1000;
      const progress = Math.min(1, elapsed / lesson.holdSeconds);
      setHoldProgress(progress);

      if (progress >= 1) {
        setPassed((prev) => (prev.includes(chord.id) ? prev : [...prev, chord.id]));
        holdStart.current = null;
        setChordIndex((i) => (i + 1) % lesson.chords.length);
      }
    }, 50);

    return () => clearInterval(id);
  }, [active, isCorrect, chord.id, lesson.holdSeconds, lesson.chords.length]);

  const tuner = analysis.frequency ? nearestString(analysis.frequency) : null;
  const error = videoError ?? audioError;

  return (
    <div className="app">
      <header>
        <div>
          <h1>Guitar Tutor</h1>
          <p className="muted">{lesson.title} — {lesson.blurb}</p>
        </div>
        <div className="header-actions">
          <label className="hand-toggle">
            Fretting hand
            <select value={frettingHand} onChange={(e) => setFrettingHand(e.target.value)}>
              <option value="Left">Left</option>
              <option value="Right">Right</option>
            </select>
          </label>
          <button className={active ? 'stop' : 'start'} onClick={() => setActive((a) => !a)}>
            {active ? 'Stop' : 'Start session'}
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main>
        <section className="stage">
          {active ? (
            <CameraView videoRef={videoRef} hands={hands} frettingHand={frettingHand} />
          ) : (
            <div className="placeholder">
              <p>Camera and microphone stay on this machine — nothing is uploaded.</p>
              <p className="muted">
                Set the camera so your fretting hand and the neck are both in frame, then start.
              </p>
            </div>
          )}

          {active && (
            <div className="stage-status">
              <span>{videoStatus === 'loading' ? 'Loading model…' : `${fps} fps`}</span>
              <span>{audioStatus === 'running' ? 'Mic live' : 'Mic starting…'}</span>
              <div className="level-meter" aria-label="input level">
                <div style={{ width: `${Math.min(100, analysis.level * 180)}%` }} />
              </div>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel chord-panel">
            <div className="chord-header">
              <div>
                <h2>{chord.name}</h2>
                <p className="muted">
                  Chord {chordIndex + 1} of {lesson.chords.length}
                </p>
              </div>
              <ChordDiagram chord={chord} />
            </div>

            <p className="tip">{chord.tip}</p>

            <div className={`match-bar ${isCorrect ? 'match-ok' : ''}`}>
              <div className="match-fill" style={{ width: `${Math.round(expectedScore * 100)}%` }} />
              <span>
                {!active
                  ? 'Not listening'
                  : isCorrect
                    ? `Holding… ${Math.round(holdProgress * 100)}%`
                    : analysis.level < 0.01
                      ? 'Waiting for you to play'
                      : `Match ${Math.round(expectedScore * 100)}%`}
              </span>
            </div>

            {active && !isCorrect && missing.length > 0 && analysis.level > 0.01 && (
              <p className="missing">
                Missing {missing.join(', ')} — check those strings are ringing, not muted.
              </p>
            )}

            {active && analysis.chords.length > 0 && !isCorrect && (
              <p className="muted heard">
                Heard: {analysis.chords.slice(0, 2).map((c) => c.name).join(' or ')}
              </p>
            )}
          </div>

          <FeedbackPanel cues={posture?.cues ?? []} handDetected={Boolean(fretting)} />

          <div className="panel">
            <h3>Tuner</h3>
            {tuner && analysis.clarity > 0.6 ? (
              <div className="tuner">
                <strong>{tuner.string.label}</strong>
                <div className="tuner-bar">
                  <div className="tuner-center" />
                  <div
                    className="tuner-needle"
                    style={{ left: `${50 + Math.max(-50, Math.min(50, tuner.cents))}%` }}
                  />
                </div>
                <span className={Math.abs(tuner.cents) < 5 ? 'in-tune' : ''}>
                  {tuner.cents > 0 ? '+' : ''}
                  {tuner.cents} cents
                </span>
              </div>
            ) : (
              <p className="muted">Play a single open string.</p>
            )}
          </div>

          <div className="panel">
            <h3>Progress</h3>
            <ul className="progress-list">
              {lesson.chords.map((c, i) => (
                <li
                  key={c.id}
                  className={
                    passed.includes(c.id) ? 'done' : i === chordIndex ? 'current' : undefined
                  }
                >
                  <button onClick={() => setChordIndex(i)}>{c.name}</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </main>
    </div>
  );
}
