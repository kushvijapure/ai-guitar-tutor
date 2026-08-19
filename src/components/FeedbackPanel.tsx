import type { Cue, PostureReport } from '../lib/posture';

/**
 * Why the camera is not currently producing landmarks. These are not
 * interchangeable: 'starting' is transient and needs no action, whereas
 * 'unavailable' is the audio-only fallback and does. Collapsing them into one
 * boolean made the panel announce "running in audio-only mode" before the
 * session had started and while the camera was still loading — contradicting
 * the camera chip, which said "Loading hand model…" at the same moment.
 */
export type CameraPhase = 'idle' | 'starting' | 'running' | 'unavailable';

interface Props {
  posture: PostureReport | null;
  handDetected: boolean;
  cameraPhase: CameraPhase;
}

/**
 * Fretting-hand feedback.
 *
 * Distinct empty states, because they need different actions from the player:
 * session not started, camera still coming up, no camera at all, camera on but
 * no hand in frame, and hand in frame but not measurable. The prototype
 * collapsed the last two into "hand not in frame", which was wrong advice for a
 * hand that was in frame but foreshortened.
 */
export function FeedbackPanel({ posture, handDetected, cameraPhase }: Props) {
  if (cameraPhase !== 'running') {
    return (
      <section className="panel" aria-labelledby="hand-heading">
        <h3 id="hand-heading">Fretting hand</h3>
        <p className="muted">
          {cameraPhase === 'idle'
            ? 'Start a session to get hand-shape coaching.'
            : cameraPhase === 'starting'
              ? 'Starting the camera…'
              : 'Camera off — running in audio-only mode. Chord coaching still works; hand-shape coaching needs video.'}
        </p>
      </section>
    );
  }

  if (!handDetected) {
    return (
      <section className="panel" aria-labelledby="hand-heading">
        <h3 id="hand-heading">Fretting hand</h3>
        <p className="muted">
          No fretting hand in frame. Angle the camera so your hand and the neck are both
          visible — roughly side-on works best.
        </p>
      </section>
    );
  }

  if (!posture || posture.quality === 'unreliable') {
    return (
      <section className="panel" aria-labelledby="hand-heading">
        <h3 id="hand-heading">Fretting hand</h3>
        <p className="cue cue-unknown">
          <strong>Unable to assess reliably.</strong>{' '}
          {posture?.reason ?? 'Waiting for a steady view of your hand.'}
        </p>
      </section>
    );
  }

  const corrections = posture.cues.filter((c) => !c.tentative);
  const observations = posture.cues.filter((c) => c.tentative);

  return (
    <section className="panel" aria-labelledby="hand-heading">
      <h3 id="hand-heading">Fretting hand</h3>

      <p className="assessed muted">
        Judging: {posture.assessedFingers.join(', ')}
      </p>

      <ul className="cue-list">
        {corrections.map((cue) => (
          <li key={cue.id} className={`cue cue-${cue.severity}`}>
            {cue.message}
          </li>
        ))}
      </ul>

      {observations.length > 0 && (
        <details className="observations">
          <summary>
            Tentative observations ({observations.length})
          </summary>
          <p className="muted caveat">
            These depend on where the neck is, which this app cannot see. Treat them as
            things to check, not corrections.
          </p>
          <ul className="cue-list">
            {observations.map((cue: Cue) => (
              <li key={cue.id} className="cue cue-info">
                {cue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
