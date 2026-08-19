# Audio recognition

[← back to README](../README.md)

The microphone answers "did you play the right notes?". It is far more reliable
for that than trying to read fret positions off a camera.

A 12-bin **chroma** (pitch-class profile) is extracted from each analysis window
and matched against chord templates by cosine similarity.

## Why template matching alone is not enough

A single plucked string's harmonic series spells out a major triad on its own:
harmonic 3 lands on the fifth, harmonic 5 on the major third. So a similarity
score will happily call one note a chord.

Measured on the current tree with `npm run measure`:

| Input | Score vs. its target template | Should be |
| --- | --- | --- |
| C5 power chord (root + fifth only) | 0.825 | rejected |
| C major with the third muted | 0.850 | rejected |
| Single C3 | 0.774 | rejected |

Under a score-only rule with a bar low enough to admit real playing, the first
two pass. Both are now rejected — not by moving the bar, but by asking questions
similarity cannot answer.

## The five gates

**Distinct pitch classes.** A triad needs three sounding pitch classes; a power
chord has two and a single note has one. A flat spectrum lighting up all twelve
is noise, and is rejected too.

**Characteristic tone.** The tone that defines the chord's quality must exceed
what the root's own harmonics could produce. A major third gets a harmonic
discount — it *is* harmonic 5 of the root — while a minor third and a fourth do
not, because neither appears in the low harmonic series. That asymmetry is
physical, not a tuning fudge.

**Top match, with margin.** The expected chord must be the single best reading,
not merely present in the top few, and must beat the best *non-equivalent* rival
by `MIN_RUNNER_UP_MARGIN`. Same-root extensions (C vs C7, Am vs Am7) are excluded
from that test — playing the right shape should not fail because it read as a
7th.

**Temporal stability.** Four consecutive analysis windows must all agree before a
chord is confirmed — about 171 ms at 48 kHz. One good frame during a strum
transient is not evidence.

**Signal presence.** Measured against the room's actual noise floor, sampled
during a short calibration at session start. The UI exposes a **Recalibrate
noise** control, because rooms change mid-session.

When a chord is wrong, the app distinguishes *"that's a G, not a C"* from *"the
third isn't ringing"* from *"I can't tell"*. Missing-tone advice is only produced
in the state where it means something.

## Current thresholds and headroom

From `src/lib/thresholds.ts` and `npm run measure` at commit `bf2f3b2`:

| Threshold | Value |
| --- | --- |
| `MIN_TOP_SCORE` | 0.86 |
| `MIN_RUNNER_UP_MARGIN` | 0.04 |

Across the 27 scenarios `npm run measure` covers:

| Headroom on legitimate chords | Measured | Gate | Margin |
| --- | --- | --- | --- |
| Lowest passing score | 0.896 | 0.86 | **0.036** |
| Lowest passing runner-up margin | 0.066 | 0.04 | **0.026** |

That is the entire safety margin on *synthetic* signals, which are far cleaner
than anything a real microphone will deliver. Real signals will be tighter.
Treat every threshold as an engineering judgement — the file says so, per value.

## The added-note gap

**This is a known, unresolved false-accept, and it is not fixable by tuning.**

| Scenario | Score vs C template | Correct verdict | Actual |
| --- | --- | --- | --- |
| C major with an added F at amplitude 0.15 | **0.901** | reject | **accepted** |
| Legitimately bright C (rolloff 0.5) | **0.896** | accept | accepted |

The wrong chord scores *higher* than the right one. No value of `MIN_TOP_SCORE`
separates these two cases: set it above 0.901 and you reject the legitimate
bright C along with the added-F chord; set it below and the added-F chord passes.

Raising the added F to amplitude 0.30 drops the score to 0.841 and it is
correctly rejected, so the gap is specifically a *quiet* added note — a lightly
ringing open string, most plausibly.

Closing this needs a different kind of evidence than a similarity score, not a
better threshold. Candidates not yet implemented or evaluated:

- an explicit "is any pitch class present that the template does not contain?"
  test, weighted by how much energy the root's harmonic series could account for
- per-note onset tracking, so a note that was not struck with the chord can be
  distinguished from one that was

Until then it is documented here rather than hidden, and it is a reason the app
should not be described as accurate.

## Scenario coverage

`npm run measure` prints every gate for all 27 scenarios, including clean chords
across six shapes, brightness and dullness variations, added noise, 60 Hz hum,
low input level, power chords, single notes, muted thirds, sus confusion,
major/minor confusion in both directions, broadband noise, ringing extra strings,
and the added-note cases above. Run it whenever a threshold changes — it shows
the effect on every scenario at once, not just the one being fixed.

## Limits of the approach

Chord matching is octave-blind and template-based. It will not distinguish
inversions or voicings, and slash chords read as their base triad. It identifies
no frets and no strings at all.
