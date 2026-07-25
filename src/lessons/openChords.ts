/** First lesson: the open chords, in the order they're least painful to learn. */

export interface ChordShape {
  id: string;
  name: string;
  /** Pitch class of the root, 0 = C. Feeds chroma matching. */
  root: number;
  /** Key into the QUALITIES table in chroma.ts. */
  quality: string;
  /** Fret per string, low E to high E. 0 = open, -1 = don't play. */
  frets: number[];
  /** Fretting finger per string: 1 index .. 4 pinky, null if open/muted. */
  fingers: (number | null)[];
  /** The one thing that most often goes wrong with this shape. */
  tip: string;
}

export const OPEN_CHORDS: ChordShape[] = [
  {
    id: 'em',
    name: 'E minor',
    root: 4,
    quality: 'minor',
    frets: [0, 2, 2, 0, 0, 0],
    fingers: [null, 2, 3, null, null, null],
    tip: 'Two fingers, every string rings. Start here — if Em sounds buzzy, the problem is your finger arch, not the chord.',
  },
  {
    id: 'am',
    name: 'A minor',
    root: 9,
    quality: 'minor',
    frets: [-1, 0, 2, 2, 1, 0],
    fingers: [null, null, 2, 3, 1, null],
    tip: 'Keep the low E out of it. The index finger on the 1st fret is the one that usually goes flat and chokes the high E.',
  },
  {
    id: 'c',
    name: 'C major',
    root: 0,
    quality: 'major',
    frets: [-1, 3, 2, 0, 1, 0],
    fingers: [null, 3, 2, null, 1, null],
    tip: 'The stretch from ring to index is the whole difficulty. Let your thumb slide down behind the neck instead of squeezing.',
  },
  {
    id: 'g',
    name: 'G major',
    root: 7,
    quality: 'major',
    frets: [3, 2, 0, 0, 0, 3],
    fingers: [2, 1, null, null, null, 3],
    tip: 'Wide shape. Use middle-index-ring so you can switch to C without resetting your whole hand.',
  },
  {
    id: 'd',
    name: 'D major',
    root: 2,
    quality: 'major',
    frets: [-1, -1, 0, 2, 3, 2],
    fingers: [null, null, null, 1, 3, 2],
    tip: 'The triangle. Only the top four strings — hitting the low E turns it into something else entirely.',
  },
];

export interface Lesson {
  id: string;
  title: string;
  blurb: string;
  chords: ChordShape[];
  /** Seconds a chord must read as correct before it counts as passed. */
  holdSeconds: number;
}

export const OPEN_CHORDS_LESSON: Lesson = {
  id: 'open-chords',
  title: 'Open Chords',
  blurb:
    'The five shapes that unlock most popular music. Play each one until it rings clean, then hold it steady.',
  chords: OPEN_CHORDS,
  holdSeconds: 1.5,
};
