/**
 * Pre-session explanation of what this can and cannot do.
 *
 * Shown before the player starts, deliberately, rather than buried in a README.
 * A tool that judges your playing should say what it is judging on and where it
 * is guessing, before it starts telling you things.
 */
export function SessionIntro({ cameraEnabled }: { cameraEnabled: boolean }) {
  return (
    <div className="placeholder">
      <h2>Before you start</h2>

      <div className="capability-grid">
        <div className="capability">
          <h3>
            <span aria-hidden="true">🎧</span> From the microphone
          </h3>
          <p className="can">
            <strong>Can tell you</strong> whether the notes of the chord are actually sounding,
            and which chord tone is missing when one is muted.
          </p>
          <p className="cannot">
            <strong>Cannot tell you</strong> which fret or string you used, whether your timing
            is good, or how it sounds musically. Two different voicings of the same chord read
            the same.
          </p>
        </div>

        <div className="capability">
          <h3>
            <span aria-hidden="true">📷</span> From the camera
          </h3>
          <p className="can">
            <strong>Can tell you</strong> roughly how curled the fingers used by the current
            chord are, when your hand is clearly visible.
          </p>
          <p className="cannot">
            <strong>Cannot tell you</strong> anything about the fretboard — it cannot see where
            the neck is, so it will not claim your wrist or thumb is wrong relative to it.
            Fret positions are not detected at all.
          </p>
        </div>
      </div>

      <p className="honesty">
        When it is not sure, it says so instead of guessing. A wrong correction is worse than
        no correction, so the thresholds are set to stay quiet rather than risk teaching you a
        mistake. Accuracy has not been measured against real recordings — see the README.
      </p>

      <ul className="setup-steps">
        <li>Sit roughly side-on to the camera so your fretting hand and the neck are in frame.</li>
        <li>Turn off any system-level noise suppression — it is tuned for speech and will fight the guitar.</li>
        <li>Stay quiet for the first second or so while the room noise floor is measured.</li>
        {!cameraEnabled && <li>Camera is off: chord coaching will work, hand-shape coaching will not.</li>}
      </ul>

      <p className="muted privacy">
        Audio and video are processed entirely in this browser. Nothing is uploaded, recorded, or
        sent anywhere.
      </p>
    </div>
  );
}
