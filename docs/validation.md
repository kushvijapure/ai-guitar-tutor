# Validation status

[← back to README](../README.md)

**The automated logic and simulated browser lifecycle pass; real-player coaching
accuracy remains unvalidated.**

That sentence is the strongest accuracy claim this project is entitled to make.
Anything stronger would require hardware that has not been used.

## What has actually been run

Measured on the integrated branch, after the backpressure and
noisy-calibration fixes.

| Check | Command | Result |
| --- | --- | --- |
| Type-check (strict, 4 projects) | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass |
| Unit tests | `npm test` | **329 passed, 9 files** |
| DSP end-to-end smoke check | `npm run verify` | Pass |
| Gate measurement, 27 scenarios | `npm run measure` | All as intended, known gap aside |
| Production build | `npm run build` | Pass |

Test distribution:

| Suite | Tests |
| --- | --- |
| `chordDecision.test.ts` | 99 |
| `posture.test.ts` | 81 |
| `chords.test.ts` | 64 |
| `dsp.test.ts` | 24 |
| `pitch.test.ts` | 18 |
| `backpressure.test.ts` | 13 |
| `handIdentitySwitch.test.ts` | 11 |
| `wristGuardBoundary.test.ts` | 10 |
| `noisyCalibration.test.ts` | 9 |

Two of those suites cover behaviour nothing previously tested, and both are
worth reading sceptically:

- **`backpressure.test.ts`** drives the shipping sender against the shipping
  analysis Worker. It exists because the code previously *claimed* that a hop
  dropped under load left a sequence gap, so the Worker would discard and
  refill its window rather than analyse across the join — and that claim was
  false. The overload check returned before the sequence counter advanced, so
  the stream stayed contiguous, windows were analysed across dropped audio, and
  the dropped-hop count read zero while hops were being thrown away. The suite
  fails 6 of its 13 cases against the pre-fix behaviour, which was verified by
  reverting the fix rather than assumed.
- **`noisyCalibration.test.ts`** covers a state the app previously had no way to
  express: calibration that captured an unusably high noise floor, after which
  the session was silently deaf. It was verified non-vacuous by mutation —
  stubbing the detector fails three cases, and deleting its discriminating
  condition fails a fourth.

Neither involved a microphone, a guitar, or a room. Both drive synthesised
signals through the real code paths, which establishes that the logic behaves
as designed, and nothing about how it behaves on a real instrument.

One seam is deliberately not covered: the handful of lines inside
`useAudio.ts` that wire the dispatcher to a real `AudioContext`,
`AudioWorkletNode` and `Worker` are type-checked and reviewed but never
executed, because there is no jsdom harness for those APIs and building one was
judged disproportionate. The transport protocol either side of that seam is
tested; the wiring itself rests on inspection.

## What the unit tests cover

- Silence followed by a new chord — the previous chord's evidence must not
  contaminate the next one. The prototype's smoothed chroma persisted forever.
- Single notes with realistic harmonics; power chords; partially muted chords;
  added wrong notes; major/minor and sus confusion, in both directions.
- Broadband noise, mains hum, and low input levels.
- Multiple sample rates: 32 kHz, 44.1 kHz, 48 kHz.
- Strum attack and decay sequences.
- Posture: active vs unused fingers, missing and NaN landmarks, extreme angles,
  foreshortening, frame-edge clipping, distance, warmup — including a test that
  asserts the app never praises a hand it could not fully measure.

**False-positive tests outnumber the recognition tests, deliberately.** The
failure that matters here is accepting something wrong, not rejecting something
right.

## The browser observations were simulated

This is the part most easily overstated, so it is stated plainly.

Every browser observation recorded in this project so far was made with a
**stubbed `getUserMedia` returning a synthetic source** — an oscillator bank
under automated Chrome. The pipeline was exercised end to end: AudioWorklet →
main-thread relay → analysis Worker → decision state machine → React UI, through
session start, chord confirmation, chord advance, and mismatch reporting.

What that establishes: **the simulated browser lifecycle passed.** The wiring is
correct, the Worker receives and processes hops, the state machine advances, and
the UI reflects it.

What it does not establish: anything about real audio. It is not evidence about
behaviour with real hardware, because no real hardware was involved.

The in-browser performance figures (mean 4.43 ms per analysis, worst 45 ms
against a 42.7 ms hop budget at 48 kHz) come from that same synthetic load. See
[architecture.md](architecture.md#measured-performance).

### Never used, at any point

- A real guitar
- A real microphone
- A real camera
- A real permission dialog, or any denial/revocation path

## What a real evaluation requires

None of the above is evidence of real-world accuracy, and the repository contains
no accuracy percentage because none has been measured. Synthetic signals have no
inharmonicity, no fret buzz, no body resonance, no room, and a noise profile no
real microphone produces.

To actually evaluate this you would need to:

1. Record 20–30 takes per chord across at least three guitars (one nylon, one
   steel acoustic, one electric), two rooms, and two microphones (laptop built-in
   and a USB condenser at minimum).
2. Label each take independently — ideally by a teacher, not by this app — as
   clean / muted-string / wrong-chord / buzzing.
3. Report **false-accept and false-reject rates separately.** A single "accuracy"
   number would hide the only failure that matters here, which is accepting a
   wrong chord.
4. Repeat for posture with video, labelling finger arch independently. Expect
   this to be harder to label reliably than the audio.

## Manual test matrix

**Not yet executed — this is the checklist, not a results table.**

| Dimension | Cases to cover |
| --- | --- |
| Browser | Chrome, Firefox, Safari, Edge (desktop); Safari iOS, Chrome Android |
| Microphone | Laptop built-in, USB condenser, audio interface, Bluetooth headset (expect this one to be poor — most are 16 kHz mono) |
| Guitar | Nylon classical, steel acoustic, electric clean, electric with light overdrive |
| Room | Treated/quiet, untreated with reflections, audible HVAC, 50/60 Hz hum |
| Player | Right-handed, left-handed, left-handed guitar strung reversed |
| Camera angle | Side-on, head-on, over-the-shoulder, low angle, hand partly out of frame |
| Lighting | Bright, dim, strong backlight |
| Hardware | Recent laptop, 5-year-old laptop, phone |
| Permissions | Grant, deny, revoke mid-session, dismiss the dialog, blocked by policy |
| Session | Start/stop repeatedly (10+ cycles) and confirm the mic indicator clears each time |

Left- versus right-handed is a **priority** case: the handedness correction in
[hand-tracking.md](hand-tracking.md#handedness-is-unverified) is reasoned but
unverified.

## How the screenshots were produced

Both images in this repository are of the real UI. Neither fabricates
functionality.

| Asset | How |
| --- | --- |
| `docs/assets/session-intro.png` | Real UI, dev server at commit `bf2f3b2`, idle session screen. **No simulated input** — this screen renders before any device is touched. |
| `docs/assets/chord-decision-panel.png` | Real UI in a running session, driven by **simulated audio input**: a stubbed `getUserMedia` over a synthesised open Em. Camera disabled, because a fake video feed would misrepresent hand tracking. Labelled as simulated wherever it appears. |
| `docs/assets/social-preview.png` | Generated from `docs/assets/social-preview.src.html` using the app's own design tokens from `src/App.css`. Not a screenshot of the app, and it depicts no results. |
