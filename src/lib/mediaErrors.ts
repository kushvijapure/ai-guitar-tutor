/**
 * Turns getUserMedia failures into something a guitarist can act on.
 *
 * The raw messages are written for developers and vary by browser —
 * "Requested device not found", "Could not start video source", or on Safari
 * just "The request is not allowed by the user agent or the platform in the
 * current context." None of those tell a player what to do next.
 */

export type MediaKind = 'camera' | 'microphone';

export interface MediaFailure {
  /** Short label for the status chip. */
  title: string;
  /** What to actually do about it. */
  detail: string;
  /** True when retrying might work after the user changes something. */
  recoverable: boolean;
}

export function describeMediaError(error: unknown, kind: MediaKind): MediaFailure {
  const device = kind === 'camera' ? 'camera' : 'microphone';
  const name = error instanceof DOMException ? error.name : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        title: `${cap(device)} blocked`,
        detail:
          `Your browser is blocking ${device} access for this page. Click the padlock or camera icon ` +
          `in the address bar, allow ${device} access, then start the session again.`,
        recoverable: true,
      };

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        title: `No ${device} found`,
        detail:
          kind === 'microphone'
            ? 'No microphone is connected. Plug one in, or select a different input in your system sound settings.'
            : 'No camera is connected. You can still practise with audio only — the chord coaching does not need video.',
        recoverable: true,
      };

    case 'NotReadableError':
    case 'TrackStartError':
      return {
        title: `${cap(device)} is busy`,
        detail:
          `Another app is already using the ${device}. Close video calls, recording software, or other ` +
          `browser tabs using it, then try again.`,
        recoverable: true,
      };

    case 'OverconstrainedError':
      return {
        title: `${cap(device)} does not support this mode`,
        detail: `Your ${device} could not provide the requested format. Try a different device if you have one.`,
        recoverable: true,
      };

    case 'SecurityError':
      return {
        title: 'Blocked by the browser',
        detail:
          'Media access needs a secure connection. Open this page over https:// or on localhost.',
        recoverable: false,
      };

    case 'AbortError':
      return {
        title: `${cap(device)} stopped unexpectedly`,
        detail: `The ${device} was interrupted. Unplugging and reconnecting it usually clears this.`,
        recoverable: true,
      };

    default:
      return {
        title: `Could not start the ${device}`,
        detail:
          `${cap(device)} setup failed` +
          (error instanceof Error && error.message ? `: ${error.message}` : '.') +
          ' Reloading the page usually clears this.',
        recoverable: true,
      };
  }
}

/** True when the browser cannot support this app at all. */
export function checkSupport(): string | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not support microphone or camera capture. Try a current version of Chrome, Edge, Firefox or Safari.';
  }
  if (typeof AudioContext === 'undefined' && typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === 'undefined') {
    return 'This browser does not support the Web Audio API, which the chord coaching needs.';
  }
  if (typeof Worker === 'undefined') {
    return 'This browser does not support Web Workers, which the analysis runs in.';
  }
  return null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
