# Known limitations and release blockers

[← back to README](../README.md)

Nothing here is a surprise or a bug report. These are the things the project
knows it cannot do, kept visible on purpose.

## Release blockers

Ordered by severity. **This should not be published until at least 1–3 are
resolved.**

1. **No LICENSE file.** The repository has no license, which means it is
   "all rights reserved" by default — nobody can legally use, fork, or contribute
   to it. This is deliberately left for the owner to decide; a license has **not**
   been chosen on their behalf. Add one before publishing.

2. **Real-world validation has not been done.** Everything is verified against
   synthetic signals only, including every browser observation. No real guitar,
   microphone or camera has been used at any point. Until that changes, the app
   must not be described as accurate. See [validation.md](validation.md).

3. **Handedness correction is unverified** against a real camera, and untested
   with a left-handed player. See
   [hand-tracking.md](hand-tracking.md#handedness-is-unverified).

4. **No real-hardware browser smoke test.** The build, type-check, lint and unit
   tests pass, and the pipeline has been exercised in Chrome against a *stubbed*
   `getUserMedia`. It has never been loaded with a real microphone since the
   audio pipeline moved to a Worklet + Worker. Permission grant, denial and
   mid-session revocation are all untested.

5. **Third-party model download** on first load unless `fetch-assets` has run.
   Fine for local use; decide deliberately before deploying.

6. **Thresholds are reasoned but not empirically optimal.** `npm run measure`
   shows the headroom: on synthetic signals the tightest legitimate chord clears
   the score gate by **0.036** and the margin gate by **0.026**. Real signals
   will be tighter than that.

7. **The added-note false-accept is unresolved and not tunable.** A C with a
   quiet added F scores 0.901 against the C template while a legitimately bright
   C scores 0.896, so no threshold separates them. See
   [audio-recognition.md](audio-recognition.md#the-added-note-gap).

## Functional limits

- Chord matching is octave-blind and template-based. It will not distinguish
  inversions or voicings, and slash chords read as their base triad.
- No fret or string identification, at all.
- Nothing detects the fretboard, so no cue is relative to the neck. Wrist and
  thumb cues are tentative observations, never corrections.
- Posture cues assume a roughly side-on view. Head-on causes foreshortening,
  which is detected and reported as unmeasurable rather than guessed at.
- One lesson. The lesson format (`src/lessons`) is structured to add more, but
  per the design principle more lessons come *after* the existing one is
  validated on real audio — not before.
- Bluetooth headsets are expected to perform poorly: most negotiate a 16 kHz mono
  voice profile, which discards the upper harmonics the chroma relies on.

## MediaPipe assets

Two assets with different supply stories, both deliberately version-pinned to
`0.10.35`:

- **WASM runtime** — ships inside `@mediapipe/tasks-vision`, pinned to an exact
  version rather than a caret range, because a patch bump to an 11.2 MB binary
  should not land silently. `npm run fetch-assets` copies it into
  `public/mediapipe/wasm/`, so it is served from your own origin.
- **`hand_landmarker.task` model** — *not* in the npm package.
  `npm run fetch-assets` downloads it into `public/models/` from a
  revision-pinned URL. It is 7.8 MB.

Neither is committed. Vendoring someone else's model into this repository is a
licensing decision for the repository owner, not for a build script.

**If the model has not been fetched, the app falls back at runtime to a pinned
`storage.googleapis.com` URL.** That is a real third-party network dependency on
first load, and it is stated here rather than glossed over. Run
`npm run fetch-assets` — dev and build do it automatically — to avoid it.

## Privacy scope

No backend, no telemetry, no uploads: audio and video are processed entirely in
the browser tab and never leave the machine.

The one caveat is the model fetch above, which contacts Google's storage host on
first load if the asset was not staged locally. That is a request for a static
binary and carries no session data, but it is a third-party request and is listed
here so the claim "nothing leaves your machine" is not overstated.
