# Hand tracking

[← back to README](../README.md)

The camera answers "is your hand doing it well?" — and only that. It is never
used to decide which notes were played.

MediaPipe's hand landmarker gives 21 3D points per hand. From those the app
derives per-finger PIP joint angles and turns them into coaching cues.

## Only the fingers the chord uses are judged

The previous version scored all four fingers every frame. Playing Em — which
frets with the middle and ring fingers only — reliably warned that the index
finger was flattening out, about a finger that was correctly parked off the
strings.

Active fingers are now derived from the current chord shape, and everything else
is ignored.

## Measurement corrections

**Joint angles are taken MCP → PIP → DIP**, not MCP → PIP → fingertip. The old
measurement conflated PIP and DIP flexion, so a properly arched finger with a
curled tip read as over-curled.

**Aspect ratio is corrected.** MediaPipe normalizes x by frame width and y by
frame height, so on a 16:9 camera the two axes have different scales and a raw
angle is skewed by more than 8° — enough to cross a cue threshold on its own.
Where MediaPipe supplies metric world landmarks, those are used instead, since
they are isotropic already.

**Landmarks are smoothed** across frames, and no judgement is offered until the
smoother has warmed up (`POSTURE_WARMUP_FRAMES`, 5).

**Every finger measurement is individually gated** on bone length and
foreshortening (`MIN_BONE_FRACTION`, 0.12). A finger pointing at the camera
projects to nearly nothing and its angle is noise, so it is reported as
unmeasurable rather than judged.

**Praise requires every active finger to have been measured.** Telling someone
their hand looks good when half of it was not visible is the same class of error
as a false correction, and is treated as one.

## Fretting-hand identity

Switching which hand is tracked mid-session would contaminate the landmark
smoother with two different hands, so the fretting-hand selector is locked while
a session is running. There is an explicit guard against a mid-stream identity
switch, covered by `tests/handIdentitySwitch.test.ts`.

## What was removed for being unsupportable

The old version told you to *"bring the wrist back so the knuckles sit parallel
to the fretboard"*. **Nothing in this app can see the fretboard.** That cue
compared the knuckle line to the horizontal of the camera image, so tilting the
webcam changed the verdict.

Neck detection is out of scope, so rather than fake it, wrist and thumb cues are
now **tentative observations**: phrased conditionally, rendered in a separate
collapsed section, marked as things to check rather than corrections, and never
counted as problems.

## Handedness is unverified

MediaPipe documents its handedness labels as assuming a *mirrored* input image.
This app feeds it the raw video — the CSS mirror on the preview is display-only —
so the labels arrive inverted and are flipped back in `resolveHandedness()`.

That reasoning follows the documented convention but has **not been checked
against a real camera**, because no real camera has been used at any point in
this project. The UI exposes a fretting-hand selector so a wrong guess is
recoverable by the player, but this remains a release blocker rather than a
solved problem. Left- versus right-handed players are the priority case for the
first real-hardware test.

## Limits

- Posture cues assume a roughly side-on view. A head-on angle causes
  foreshortening, which is detected and reported as unmeasurable rather than
  guessed at.
- Nothing detects the fretboard, so no cue is relative to the neck.
- No fret or string identification, at all.
- The camera failing does not stop a session — the app continues in audio-only
  mode and says so.
