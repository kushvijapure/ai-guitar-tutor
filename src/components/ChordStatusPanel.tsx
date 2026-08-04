import type { ChordDecision, ChordStatus } from '../lib/chordDecision';
import type { ChordShape } from '../lessons/openChords';
import { ChordDiagram } from './ChordDiagram';

interface Props {
  chord: ChordShape;
  index: number;
  total: number;
  decision: ChordDecision | null;
  holdProgress: number;
  holdSeconds: number;
  active: boolean;
}

/** Human-readable meaning of each state. Wording matters: these are the app's claims. */
const STATE_LABEL: Record<ChordStatus, string> = {
  calibrating: 'Measuring room noise',
  silent: 'Waiting for you to play',
  listening: 'Listening…',
  ambiguous: "Can't tell yet",
  incomplete: 'Not all of it is ringing',
  wrong: 'That is a different chord',
  confirmed: 'Got it — hold steady',
};

export function ChordStatusPanel({
  chord,
  index,
  total,
  decision,
  holdProgress,
  holdSeconds,
  active,
}: Props) {
  const status = decision?.status;
  const score = decision?.score ?? 0;

  return (
    <section className="panel chord-panel" aria-labelledby="chord-heading">
      <div className="chord-header">
        <div>
          <h2 id="chord-heading">{chord.name}</h2>
          <p className="muted">
            Chord {index + 1} of {total}
          </p>
        </div>
        <ChordDiagram chord={chord} />
      </div>

      <p className="tip">{chord.tip}</p>

      {!active ? (
        <p className="state state-idle">Not listening.</p>
      ) : (
        <>
          <p className={`state state-${status ?? 'listening'}`}>
            {status ? STATE_LABEL[status] : 'Starting…'}
          </p>

          {status === 'calibrating' && (
            <div
              className="meter"
              role="progressbar"
              aria-label="Noise calibration progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((decision?.calibrationProgress ?? 0) * 100)}
            >
              <div
                className="meter-fill calibrating"
                style={{ width: `${Math.round((decision?.calibrationProgress ?? 0) * 100)}%` }}
              />
            </div>
          )}

          {/*
            The hold bar only exists once the chord is confirmed. Showing a
            filling "progress" bar for a match that has not passed the gates
            implies the player is nearly right when they may not be.
          */}
          {status === 'confirmed' ? (
            <div
              className="meter"
              role="progressbar"
              aria-label={`Holding ${chord.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(holdProgress * 100)}
              aria-valuetext={`${(holdProgress * holdSeconds).toFixed(1)} of ${holdSeconds} seconds`}
            >
              <div className="meter-fill holding" style={{ width: `${holdProgress * 100}%` }} />
            </div>
          ) : (
            status !== 'calibrating' && (
              <div
                className="meter"
                role="progressbar"
                aria-label={`Match confidence for ${chord.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(score * 100)}
              >
                <div className="meter-fill" style={{ width: `${Math.round(score * 100)}%` }} />
              </div>
            )
          )}

          <ChordExplanation decision={decision} chordName={chord.name} />
        </>
      )}
    </section>
  );
}

/**
 * The "why" line.
 *
 * Each branch corresponds to exactly one decision state, so the app cannot say
 * something it has not established. In particular there is no branch that names
 * a missing note outside the 'incomplete' state — ChordDecider does not even
 * populate that field otherwise.
 */
function ChordExplanation({
  decision,
  chordName,
}: {
  decision: ChordDecision | null;
  chordName: string;
}) {
  if (!decision) return null;

  switch (decision.status) {
    case 'calibrating':
      return <p className="explain muted">Stay quiet for a second so I can learn your room.</p>;

    case 'silent':
      return <p className="explain muted">Strum when you are ready.</p>;

    case 'incomplete': {
      const count = decision.check?.pitchClassCount ?? 0;
      if (decision.missing && decision.missing.length > 0) {
        return (
          <p className="explain">
            I can hear {decision.missing.length === 1 ? 'a note' : 'notes'} missing:{' '}
            <strong>{decision.missing.join(', ')}</strong>. Check those strings are ringing
            rather than muted by a neighbouring finger.
          </p>
        );
      }
      if (count < 3) {
        return (
          <p className="explain">
            Only {count === 1 ? 'one note is' : `${count} notes are`} coming through. A full{' '}
            {chordName} needs three different notes sounding — strum across all the strings in
            the shape.
          </p>
        );
      }
      return (
        <p className="explain">
          The note that makes this chord {chordName} is not sounding clearly enough to be sure
          it is fretted.
        </p>
      );
    }

    case 'wrong': {
      const heard = decision.heard[0];
      return (
        <p className="explain">
          That sounds like <strong>{heard?.name ?? 'another chord'}</strong>, not {chordName}.
        </p>
      );
    }

    case 'ambiguous':
      return (
        <p className="explain muted">
          The sound is not clear enough to call. Let the chord ring, and check nothing is
          buzzing.
        </p>
      );

    case 'listening':
      return <p className="explain muted">Keep it ringing…</p>;

    case 'confirmed':
      return <p className="explain good">Clean {chordName}. Hold it.</p>;

    default:
      return null;
  }
}
