import type { AnalysisStats } from '../audio/messages';
import type { TrackingStats } from '../hooks/useHandTracking';
import { HAND_TRACKING_FPS, HOP_SIZE, UI_UPDATE_HZ } from '../lib/thresholds';

interface Props {
  audio: AnalysisStats | null;
  video: TrackingStats | null;
  sampleRate: number | null;
  onClose: () => void;
}

/**
 * Runtime diagnostics, for checking that the rate limiting is doing what it
 * claims on a machine that is not the developer's.
 *
 * "Skipped" frames are a success, not a failure: they are animation frames on
 * which inference was deliberately not run. "Over budget" analyses are the real
 * warning sign — those are windows that took longer than the hop they represent,
 * meaning the analysis thread is not keeping up with real time.
 */
export function Diagnostics({ audio, video, sampleRate, onClose }: Props) {
  const hopMs = sampleRate ? (HOP_SIZE / sampleRate) * 1000 : 0;

  return (
    <aside className="diagnostics" aria-label="Performance diagnostics">
      <div className="diag-header">
        <h3>Diagnostics</h3>
        <button type="button" onClick={onClose} aria-label="Close diagnostics">
          ×
        </button>
      </div>

      <table>
        <tbody>
          <tr className="diag-section">
            <th colSpan={2}>Audio (worker thread)</th>
          </tr>
          <tr>
            <th scope="row">Analysis window</th>
            <td>{hopMs ? `${hopMs.toFixed(0)} ms hop` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Mean analysis</th>
            <td>{audio ? `${audio.meanMs.toFixed(2)} ms` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Worst analysis</th>
            <td>{audio ? `${audio.worstMs.toFixed(2)} ms` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Windows analysed</th>
            <td>{audio ? `${audio.analysed} of ${audio.received} hops` : '—'}</td>
          </tr>
          <tr className={audio && audio.overBudget > 0 ? 'warn-row' : undefined}>
            <th scope="row">Over budget</th>
            <td>{audio ? audio.overBudget : '—'}</td>
          </tr>

          <tr className="diag-section">
            <th colSpan={2}>Video (main thread)</th>
          </tr>
          <tr>
            <th scope="row">Inference rate</th>
            <td>{video ? `${video.fps} fps (cap ${HAND_TRACKING_FPS})` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Mean inference</th>
            <td>{video ? `${video.meanInferenceMs.toFixed(1)} ms` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Worst inference</th>
            <td>{video ? `${video.worstInferenceMs.toFixed(1)} ms` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Frames skipped</th>
            <td>
              {video ? `${video.skipped} of ${video.frames}` : '—'}
              <span className="muted"> (by design)</span>
            </td>
          </tr>

          <tr className="diag-section">
            <th colSpan={2}>React</th>
          </tr>
          <tr>
            <th scope="row">Update cap</th>
            <td>{UI_UPDATE_HZ} Hz</td>
          </tr>
        </tbody>
      </table>
    </aside>
  );
}
