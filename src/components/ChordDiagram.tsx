import type { ChordShape } from '../lessons/openChords';

const STRINGS = 6;
const FRETS = 4;

const WIDTH = 160;
const HEIGHT = 190;
const PAD_X = 22;
const PAD_TOP = 30;

interface Props {
  chord: ChordShape;
}

/** Standard chord box: strings vertical, frets horizontal, nut at the top. */
export function ChordDiagram({ chord }: Props) {
  const gridWidth = WIDTH - PAD_X * 2;
  const gridHeight = HEIGHT - PAD_TOP - 24;
  const stringGap = gridWidth / (STRINGS - 1);
  const fretGap = gridHeight / FRETS;

  const stringX = (i: number) => PAD_X + i * stringGap;
  const fretY = (f: number) => PAD_TOP + f * fretGap;

  return (
    <svg className="chord-diagram" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${chord.name} chord diagram`}>
      {/* Nut */}
      <rect x={PAD_X - 2} y={PAD_TOP - 5} width={gridWidth + 4} height={5} rx={1.5} fill="currentColor" />

      {Array.from({ length: FRETS }, (_, f) => (
        <line
          key={`fret-${f}`}
          x1={PAD_X}
          y1={fretY(f + 1)}
          x2={PAD_X + gridWidth}
          y2={fretY(f + 1)}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      ))}

      {Array.from({ length: STRINGS }, (_, s) => (
        <line
          key={`string-${s}`}
          x1={stringX(s)}
          y1={PAD_TOP}
          x2={stringX(s)}
          y2={PAD_TOP + gridHeight}
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      ))}

      {chord.frets.map((fret, s) => {
        const x = stringX(s);

        if (fret === -1) {
          return (
            <g key={`mark-${s}`} stroke="currentColor" strokeOpacity={0.5} strokeWidth={1.6}>
              <line x1={x - 4} y1={PAD_TOP - 17} x2={x + 4} y2={PAD_TOP - 9} />
              <line x1={x - 4} y1={PAD_TOP - 9} x2={x + 4} y2={PAD_TOP - 17} />
            </g>
          );
        }

        if (fret === 0) {
          return (
            <circle
              key={`mark-${s}`}
              cx={x}
              cy={PAD_TOP - 13}
              r={4.5}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.5}
              strokeWidth={1.6}
            />
          );
        }

        const cy = fretY(fret) - fretGap / 2;
        return (
          <g key={`mark-${s}`}>
            <circle cx={x} cy={cy} r={9} fill="var(--accent)" />
            <text
              x={x}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10}
              fontWeight={600}
              fill="var(--accent-contrast)"
            >
              {chord.fingers[s] ?? ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
