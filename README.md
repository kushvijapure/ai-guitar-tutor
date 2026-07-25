# Guitar Tutor

A browser-based practice coach that watches your fretting hand through the webcam
and listens to what you play through the microphone, then tells you what to fix.
Everything runs client-side — the camera and microphone streams never leave your
machine.

## What it actually does

The interesting design decision here is **splitting the two questions a guitar
teacher answers**:

- **"Did you play the right notes?"** — answered from **audio**, not video. The
  microphone signal is far more reliable for this than trying to read fret
  positions off a camera. A [YIN](https://en.wikipedia.org/wiki/Pitch_detection_algorithm)
  pitch detector handles single notes and the tuner; a 12-bin **chroma** (pitch-class
  profile) matched against chord templates with cosine similarity handles strummed
  chords. When a chord is wrong, it diagnoses *which tone is missing* rather than
  just saying "no."

- **"Is your hand doing it well?"** — answered from **video**. MediaPipe's hand
  landmarker gives 21 3D points per hand; from those we derive finger curl,
  wrist/palm rotation, and thumb placement, and surface the cues a teacher gives
  most: *arch that finger, drop your thumb behind the neck, flatten your wrist.*

### Why not detect frets from the camera?

Because it doesn't work well enough to teach with. Fret spacing above the 7th fret
is a few millimetres at webcam resolution, and your fretting hand occludes the exact
region you'd need to see. Inferring string/fret from landmarks alone is a research
problem, and a wrong "you're on the 3rd fret" is worse than no claim at all. Audio
sidesteps this entirely — it knows what you played regardless of where the camera is.
The hand tracking sticks to what landmarks *are* reliable for: hand shape.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

Grant camera and microphone permission when prompted. Turn off any audio "noise
suppression" in your OS if notes drop out — those filters are tuned for speech and
fight the guitar.

### Other scripts

```bash
npm run build    # typecheck + production build
npm run verify   # run the DSP checks against synthetic signals
npm run lint
```

`npm run verify` proves the pitch and chord maths against generated tones — useful
because you can't unit-test "does it feel right with a real guitar" in CI. It is not
a substitute for playing into it; room noise, pickup hum, and cheap mics all degrade
the real-world signal in ways synthetic tones don't capture.

## The first lesson

Open chords — Em, Am, C, G, D — in roughly increasing difficulty. Each chord shows a
diagram, a one-line tip for the mistake that shape invites, a live match meter, and
posture cues. Hold a chord clean for 1.5 s and it advances.

## Layout

```
src/
  lib/
    pitch.ts      YIN monophonic pitch detection (tuner, single notes)
    chroma.ts     chroma extraction + chord template matching + missing-tone diagnosis
    notes.ts      note naming, cents, standard-tuning reference
    posture.ts    hand-landmark geometry -> coaching cues
  hooks/
    useHandTracking.ts   MediaPipe hand landmarker over the webcam
    useAudio.ts          Web Audio analyser -> pitch + chroma per frame
  components/
    CameraView.tsx    video + skeleton overlay
    ChordDiagram.tsx  SVG chord box
    FeedbackPanel.tsx  posture cues
  lessons/
    openChords.ts   chord shapes + lesson definition
  App.tsx           session state, hold-to-pass loop, layout
scripts/
  verify-dsp.ts     synthetic-signal checks for the DSP
```

## Known limits

- Chord matching is octave-blind and template-based; it won't distinguish
  inversions or voicings, and slash chords read as their base triad.
- Posture cues assume a roughly side-on view of the fretting hand. A head-on angle
  confuses palm-rotation estimates.
- One lesson so far. The lesson format (`src/lessons`) is structured to add more:
  strumming patterns, chord transitions, single-note exercises.

## Stack

React + TypeScript + Vite, MediaPipe Tasks Vision (hand landmarker), Web Audio API.
No backend, no build step beyond Vite, no data leaves the browser.
