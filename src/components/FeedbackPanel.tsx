import type { Cue } from '../lib/posture';

interface Props {
  cues: Cue[];
  handDetected: boolean;
}

export function FeedbackPanel({ cues, handDetected }: Props) {
  if (!handDetected) {
    return (
      <div className="panel">
        <h3>Fretting hand</h3>
        <p className="muted">
          Hand not in frame. Angle the camera so your fretting hand and the neck are both visible.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>Fretting hand</h3>
      <ul className="cue-list">
        {cues.map((cue) => (
          <li key={cue.id} className={`cue cue-${cue.severity}`}>
            {cue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
