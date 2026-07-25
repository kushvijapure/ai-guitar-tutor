/** Note naming, cent deviation, and standard-tuning reference frequencies. */

export const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

export type NoteName = (typeof NOTE_NAMES)[number];

const A4 = 440;
/** MIDI note number of A4. */
const A4_MIDI = 69;

export function freqToMidi(freq: number): number {
  return 12 * Math.log2(freq / A4) + A4_MIDI;
}

export function midiToFreq(midi: number): number {
  return A4 * Math.pow(2, (midi - A4_MIDI) / 12);
}

export interface NoteReading {
  name: NoteName;
  octave: number;
  /** Pitch class 0-11, where 0 is C. */
  pitchClass: number;
  /** Deviation from perfect pitch, -50..+50. */
  cents: number;
}

export function freqToNote(freq: number): NoteReading {
  const midiFloat = freqToMidi(freq);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const pitchClass = ((midi % 12) + 12) % 12;

  return {
    name: NOTE_NAMES[pitchClass],
    octave: Math.floor(midi / 12) - 1,
    pitchClass,
    cents,
  };
}

/** Standard tuning, low to high. */
export const STANDARD_TUNING = [
  { label: 'E2', midi: 40, freq: midiToFreq(40) },
  { label: 'A2', midi: 45, freq: midiToFreq(45) },
  { label: 'D3', midi: 50, freq: midiToFreq(50) },
  { label: 'G3', midi: 55, freq: midiToFreq(55) },
  { label: 'B3', midi: 59, freq: midiToFreq(59) },
  { label: 'E4', midi: 64, freq: midiToFreq(64) },
] as const;

export type GuitarString = (typeof STANDARD_TUNING)[number];

/** Nearest open string to a detected frequency — drives the tuner readout. */
export function nearestString(freq: number) {
  let best: GuitarString = STANDARD_TUNING[0];
  let bestDistance = Infinity;

  for (const string of STANDARD_TUNING) {
    const distance = Math.abs(freqToMidi(freq) - string.midi);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = string;
    }
  }

  const cents = Math.round((freqToMidi(freq) - best.midi) * 100);
  return { string: best, cents };
}
