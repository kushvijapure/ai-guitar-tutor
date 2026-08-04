# Guitar Tutor

A browser-based practice coach that listens to what you play through the microphone
and watches your fretting hand through the webcam, then tells you what to fix —
or, more often than you might expect, tells you that it cannot tell.

Everything runs client-side. The camera and microphone streams never leave your machine.

> **Status: beta.** The decision logic is conservative and unit-tested against
> synthetic signals. It has **not** been validated against real guitar recordings,
> and no accuracy figure is claimed anywhere in this repository. See
> [Real-world evaluation](#real-world-evaluation) and [Release blockers](#release-blockers).

## The design principle

**An incorrect correction is worse than no correction.** A player who is told their
finger is flat when it isn't will "fix" a thing that was right. So every judgement
in here is gated, and when a gate fails the app says so rather than guessing.
That is why the UI has states like *"Can't tell yet"* and *"Unable to assess
reliably"* — those are features, not placeholders.

## What it actually does

The interesting design decision is **splitting the two questions a guitar teacher
answers**:

### "Did you play the right notes?" — from audio

The microphone is far more reliable for this than trying to read fret positions off
a camera. A 12-bin **chroma** (pitch-class profile) is matched against chord
templates by cosine similarity.

Template matching alone is **not sufficient**, and this is the core problem the
rewrite addresses. A single plucked string's harmonic series spells out a major
triad: harmonic 3 lands on the fifth, harmonic 5 on the major third. Measured
against the previous implementation:

| Input | Score vs. C major template | Previous verdict |
| --- | --- | --- |
| C5 power chord (root + fifth only) | 0.841 | **accepted** (threshold was 0.82) |
| C major with the third muted | 0.858 | **accepted** |

Both are now rejected, by gates that ask the questions similarity cannot:

- **Distinct pitch classes.** A triad needs three sounding pitch classes; a power
  chord has two and a single note has one. A flat spectrum lighting up all twelve
  is noise, and is rejected too.
- **Characteristic tone.** The tone that defines the chord's quality must exceed
  what the root's own harmonics could produce. A major third gets a harmonic
  discount (it *is* harmonic 5 of the root); a minor third and a fourth do not,
  because neither appears in the low harmonic series. That asymmetry is physical,
  not a tuning fudge.
- **Top match, with margin.** The expected chord must be the single best reading,
  not merely present in the top few, and must beat the best *non-equivalent* rival
  by a margin. Same-root extensions (C vs C7, Am vs Am7) are excluded from that
  test — playing the right shape shouldn't fail because it read as a 7th.
- **Temporal stability.** Four consecutive analysis windows (~185 ms) must all
  agree before a chord is confirmed. One good frame during a strum transient is not
  evidence.
- **Signal presence.** Measured against the room's actual noise floor, sampled
  during a short calibration at session start.

When a chord is wrong, the app distinguishes *"that's a G, not a C"* from *"the
third isn't ringing"* from *"I can't tell"*. Missing-tone advice is only produced
in the state where it means something.

### "Is your hand doing it well?" — from video

MediaPipe's hand landmarker gives 21 3D points per hand. From those we derive
per-finger PIP joint angles.

**Only the fingers the current chord actually uses are judged.** The previous
version scored all four every frame, so playing Em — which frets with middle and
ring only — reliably warned that your index finger was flattening out, about a
finger that was correctly parked off the strings.

Measurement corrections in this version:

- Joint angles are taken **MCP → PIP → DIP**, not MCP → PIP → fingertip. The old
  measurement conflated PIP and DIP flexion, so a properly arched finger with a
  curled tip read as over-curled.
- **Aspect ratio is corrected.** MediaPipe normalizes x by frame width and y by
  frame height, so on a 16:9 camera the two axes have different scales and a raw
  angle is skewed by more than 8° — enough to cross a cue threshold. Where
  MediaPipe supplies metric world landmarks, those are used instead, since they
  are isotropic already.
- **Landmarks are smoothed** across frames, and no judgement is offered until the
  smoother has warmed up.
- Every finger measurement is **individually gated** on bone length and
  foreshortening. A finger pointing at the camera projects to nearly nothing and
  its angle is noise, so it is reported as unmeasurable rather than judged.
- **Praise requires every active finger to have been measured.** Telling someone
  their hand looks good when half of it wasn't visible is the same error as a false
  correction.

### What was removed for being unsupportable

The old version told you to *"bring the wrist back so the knuckles sit parallel to
the fretboard"*. **Nothing in this app can see the fretboard.** That cue compared
the knuckle line to the horizontal of the camera image, so tilting the webcam
changed the verdict.

Neck detection is out of scope, so rather than fake it, wrist and thumb cues are
now **tentative observations**: phrased conditionally, rendered in a separate
collapsed section, marked as things to check rather than corrections, and never
counted as problems.

### Why not detect frets from the camera?

Because it doesn't work well enough to teach with. Fret spacing above the 7th fret
is a few millimetres at webcam resolution, and your fretting hand occludes the
exact region you'd need to see. A wrong *"you're on the 3rd fret"* is worse than no
claim at all. Audio sidesteps this: it knows what you played regardless of where
the camera is.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

Grant microphone permission when prompted; camera is optional. Turn off any OS-level
audio "noise suppression" — those filters are tuned for speech and fight a guitar.
Stay quiet for the first second or so while the room noise floor is measured.

### Commands

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (vitest). 141 tests across DSP, pitch, chords, decisions, posture. |
| `npm run typecheck` | `tsc -b` across app, node and test projects. Strict mode. |
| `npm run lint` | oxlint. |
| `npm run verify` | End-to-end DSP smoke check with human-readable output. |
| `npm run measure` | Prints every decision gate for 23 scenarios. Use when changing a threshold. |
| `npm run bench` | Analysis cost and real-time factor. |
| `npm run build` | Type-check + production build. |
| `npm run ci` | Everything above, in the order CI runs it. |
| `npm run fetch-assets` | Stages MediaPipe wasm + model into `public/`. Runs automatically before dev/build. |

## Architecture

```
src/
  lib/
    thresholds.ts     every tunable, with the reasoning for its value
    dsp.ts            FFT, Hann window, anti-aliased decimation, level metering
    pitch.ts          YIN pitch detection (tuner, single notes)
    chroma.ts         chroma extraction, chord templates, the decision gates
    chordDecision.ts  the state machine: silence, smoothing, stability, calibration
    analyzer.ts       one window in, one observation out (pure, preallocated)
    posture.ts        hand-landmark geometry -> coaching cues, with reliability gating
    notes.ts          note naming, cents, standard-tuning reference
    mediaErrors.ts    getUserMedia failures -> actionable messages
    mediapipeAssets.ts  pinned runtime/model versions
  audio/
    capture-worklet.js  AudioWorklet: reblocks audio-thread quanta into hops
    analysis.worker.ts  Worker: FFT, pitch, chord decision
    messages.ts         the contract between them
  hooks/
    useAudio.ts         mic -> worklet -> worker -> throttled React state
    useHandTracking.ts  MediaPipe, rate-capped and smoothed
  components/           CameraView, ChordDiagram, ChordStatusPanel, FeedbackPanel,
                        SessionIntro, Diagnostics
  lessons/
    openChords.ts     chord shapes + lesson definition
tests/
  signals.ts          synthetic guitar signal generators
  hands.ts            synthetic hand landmark sets
  *.test.ts           the suites
scripts/
  verify-dsp.ts       end-to-end smoke check
  measure-gates.ts    threshold headroom diagnostic
  bench.ts            performance benchmark
  fetch-assets.mjs    stages MediaPipe assets into public/
```

### Threading

| Thread | Runs |
| --- | --- |
| Audio thread | `capture-worklet.js` — reblocking and RMS only. Nothing that could overrun the render deadline. |
| Main thread | Transfers buffers onward. **No DSP.** |
| Worker | FFT, YIN, chord decision state machine. |
| Main thread | Drains the newest result into React at 12 Hz. |

The prototype ran YIN and an FFT inside `requestAnimationFrame` on the main thread
and called `setState` on every frame. Measured cost of the pitch step alone:

| Decimation | ms/frame | At the old 60 Hz cadence |
| --- | --- | --- |
| 1× (as it was) | 5.413 | ~325 ms of CPU per second — about a third of a core |
| 2× | 1.320 | |
| 4× (current) | 0.438 | |

Guitar fundamentals stop around 1.2 kHz, so quarter-rate discards nothing we use.
Current full-pipeline cost is **0.64 ms per analysis window at ~21 windows/second,
in a Worker** — around 65× real time on an M-series Mac. Silent windows exit early
at 0.008 ms, which is why idle CPU between strums is near zero.

The decision state machine lives in the Worker and advances at the full analysis
rate, so throttling the UI changes only how often numbers move on screen — it
cannot weaken the correctness gates.

Press **Show diagnostics** during a session for live analysis cost and
processed/skipped frame counts on your own machine.

## Testing

`npm test` covers, among other things:

- Silence followed by a new chord — the previous chord's evidence must not
  contaminate the next one (the prototype's smoothed chroma persisted forever).
- Single notes with realistic harmonics; power chords; partially muted chords;
  added wrong notes; major/minor and sus confusion — in both directions.
- Broadband noise, mains hum, and low input levels.
- Multiple sample rates (32 kHz, 44.1 kHz, 48 kHz).
- Strum attack and decay sequences.
- Posture: active vs unused fingers, missing and NaN landmarks, extreme angles,
  foreshortening, frame-edge clipping, distance, and warmup — including a test
  that asserts the app never praises a hand it could not fully measure.

**False-positive tests outnumber the recognition tests**, deliberately.

### Real-world evaluation

**None of the above is evidence of real-world accuracy**, and the repository
contains no accuracy percentage because none has been measured. Synthetic signals
have no inharmonicity, no fret buzz, no body resonance, no room, and a noise
profile no real microphone produces.

To actually evaluate this you would need to:

1. Record 20–30 takes per chord across at least three guitars (one nylon, one
   steel acoustic, one electric), two rooms, and two microphones (laptop built-in
   and a USB condenser at minimum).
2. Label each take independently — ideally by a teacher, not by this app — as
   clean / muted-string / wrong-chord / buzzing.
3. Report **false-accept and false-reject rates separately.** A single "accuracy"
   number would hide the only failure that matters here, which is accepting a
   wrong chord.
4. Repeat for posture with video, labelling finger arch independently. Expect this
   to be harder to label reliably than the audio.

Until that exists, treat every threshold in `src/lib/thresholds.ts` as an
engineering judgement. The file says so, per value.

### Manual test matrix

Not yet executed — this is the checklist, not a results table.

| Dimension | Cases to cover |
| --- | --- |
| Browser | Chrome, Firefox, Safari, Edge (desktop); Safari iOS, Chrome Android |
| Microphone | Laptop built-in, USB condenser, audio interface, Bluetooth headset (expect this one to be poor — most are 16 kHz mono) |
| Guitar | Nylon classical, steel acoustic, electric clean, electric with light overdrive |
| Room | Treated/quiet, untreated with reflections, room with audible HVAC, room with 50/60 Hz hum |
| Player | Right-handed, left-handed, left-handed guitar strung reversed |
| Camera angle | Side-on, head-on, over-the-shoulder, low angle, hand partly out of frame |
| Lighting | Bright, dim, strong backlight |
| Hardware | Recent laptop, 5-year-old laptop, phone |
| Session | Start/stop repeatedly (10+ cycles) and confirm the mic indicator clears each time |

Left- vs right-handed is a **priority** case: the MediaPipe handedness correction
below is reasoned but unverified.

## Known limits

- **Handedness is unverified.** MediaPipe documents its handedness labels as
  assuming a *mirrored* input image. This app feeds it the raw video (the CSS
  mirror is display-only), so the labels arrive inverted and are flipped back in
  `resolveHandedness()`. That reasoning follows the documented convention but has
  **not been checked against a real camera**. The UI exposes a fretting-hand
  selector so a wrong guess is recoverable.
- Chord matching is octave-blind and template-based; it will not distinguish
  inversions or voicings, and slash chords read as their base triad.
- Posture cues assume a roughly side-on view. A head-on angle causes
  foreshortening, which is detected and reported as unmeasurable rather than
  guessed at.
- Nothing detects the fretboard, so no cue is relative to the neck.
- No fret or string identification. At all.
- One lesson. The lesson format (`src/lessons`) is structured to add more, but per
  the design principle, more lessons come after the existing one is validated on
  real audio — not before.

## MediaPipe assets

Two assets with different supply stories, both deliberately version-pinned:

- **WASM runtime** — ships inside `@mediapipe/tasks-vision` (pinned to an exact
  version, not a caret range: a patch bump to an 11 MB binary should not land
  silently). `npm run fetch-assets` copies it into `public/mediapipe/wasm/`, so it
  is served from your own origin.
- **`hand_landmarker.task` model** — *not* in the npm package.
  `npm run fetch-assets` downloads it into `public/models/` from a
  revision-pinned URL.

Neither is committed. The model is a ~7.8 MB Google-published binary, and
vendoring someone else's model into this repository is a licensing decision for
the repository owner, not for a build script.

**If the model has not been fetched, the app falls back at runtime to a pinned
`storage.googleapis.com` URL.** That is a real third-party network dependency on
first load, and it is stated here rather than glossed over. Run
`npm run fetch-assets` (dev and build do it automatically) to avoid it.

## Release blockers

Ordered by severity. **This should not be published until at least 1–3 are resolved.**

1. **No LICENSE file.** The repository has no license, which means it is
   "all rights reserved" by default — nobody can legally use, fork, or contribute
   to it. This is deliberately left for the owner to decide; a license has **not**
   been chosen on their behalf. Add one before publishing.
2. **Real-world validation has not been done.** Everything is verified against
   synthetic signals only. See [Real-world evaluation](#real-world-evaluation).
   Until then the app should not be described as accurate.
3. **Handedness correction is unverified** against a real camera, and untested with
   a left-handed player. See Known limits.
4. **No browser smoke test has been run** on the rewritten UI. The build,
   type-check, lint and unit tests pass, but the app has not been loaded in a
   browser with a real microphone since the audio pipeline moved to a
   Worklet + Worker. Do this first.
5. **Third-party model download** on first load unless `fetch-assets` has run. Fine
   for local use; decide deliberately before deploying.
6. Threshold values are reasoned but not empirically optimal. `npm run measure`
   shows the headroom: on synthetic signals the tightest legitimate chord clears
   the score gate by 0.048 and the margin gate by 0.026. Real signals will be
   tighter than that.

## Stack

React + TypeScript (strict) + Vite, MediaPipe Tasks Vision (hand landmarker),
Web Audio API with a custom FFT. No backend, no telemetry, no data leaves the
browser.
