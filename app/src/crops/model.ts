/**
 * Source crops and the riser crop (T44, T106, T129): what to say when one does not load, and the
 * double-tap maths of an enlarged crop (T135). Pure, tested in Node.
 */

import { TransportError } from '@field-survey/core';

/**
 * One line for the panel when a crop, the import list or the riser PDF did not load: a timeout,
 * no connection, the server's status (with its FastAPI `detail` when it sent one), or the iPad
 * having no server yet (`no_transport`, the blob queue before sync starts). `what` names the thing
 * ("The crop", "The riser PDF").
 */
export function failureText(what: string, e: unknown): string {
  if (e === 'no_transport') return `${what} could not be downloaded: this iPad is not connected to the server yet (Sync screen).`;
  if (e instanceof TransportError) {
    if (e.failure === 'network') {
      return /abort|time ?out|timed out/i.test(e.message)
        ? `${what} did not load: the server did not answer in time. It may be busy or restarting; try again in a minute.`
        : `${what} did not load: the server is not reachable (no connection?).`;
    }
    const detail = detailOf(e.detail);
    const why = detail ? ` (${detail})` : '';
    if (e.status === 401) return `${what} did not load: the server refused this iPad's token (401).`;
    if (e.status === 404) return `${what} is not on the server${why || ' (404)'}.`;
    if (e.status !== undefined && e.status >= 500) return `${what} did not load: server error ${e.status}${why}. Try again in a minute.`;
    return `${what} did not load: the server answered ${e.status ?? '?'}${why}.`;
  }
  return `${what} did not load: ${e instanceof Error ? e.message : String(e)}`;
}

function detailOf(body: unknown): string | null {
  const d = (body as { detail?: unknown } | null | undefined)?.detail;
  if (typeof d === 'string') return d;
  const inner = (d as { detail?: unknown; error?: unknown } | null | undefined) ?? null;
  if (typeof inner?.detail === 'string') return inner.detail;
  if (typeof inner?.error === 'string') return inner.error;
  return null;
}

/** `downloadFileAsync`'s rejection → `TransportError` (its message carries a 4xx/5xx status), as the blob transport does. */
export function downloadError(e: unknown): TransportError {
  if (e instanceof TransportError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = /\b([45]\d\d)\b/.exec(msg);
  if (!m) return new TransportError('network', msg);
  const status = Number(m[1]);
  return new TransportError(status === 401 ? 'auth' : status < 500 ? 'rejected' : 'server', msg, status);
}

/** A stable file name for a crop URL (the server never changes a crop, so it may be kept). */
export function cropCacheName(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `crop-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}.png`;
}

// ------------------------------------------------------------------ zoom and double tap

/**
 * An enlarged crop zooms in UIKit's scroll view (T135): it pinches and pans by itself, and the
 * double tap zooms to a rect in the image's own (unzoomed) points.
 */
export type ViewSize = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** A tap: when (ms) and where (image points). */
export type Tap = { t: number; x: number; y: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Double tap on a fitted crop zooms to this. */
export const TAP_ZOOM = 3;
/** Two taps this close in time (ms) and on screen (points) are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 40;

/** Double tap: back to fit when zoomed, else `TAP_ZOOM` centred on the tapped point, kept inside the image. */
export function tapZoomRect(scale: number, at: { x: number; y: number }, view: ViewSize): Rect {
  if (scale > MIN_ZOOM + 0.01) return { x: 0, y: 0, width: view.width, height: view.height };
  const width = view.width / TAP_ZOOM;
  const height = view.height / TAP_ZOOM;
  const x = Math.min(view.width - width, Math.max(0, at.x - width / 2));
  const y = Math.min(view.height - height, Math.max(0, at.y - height / 2));
  return { x, y, width, height };
}

/** Whether `tap` completes a double tap after `prev`; the distance is measured on screen (image points × `scale`). */
export function isDoubleTap(prev: Tap | null, tap: Tap, scale: number): boolean {
  if (!prev || tap.t - prev.t > DOUBLE_TAP_MS) return false;
  return Math.hypot(tap.x - prev.x, tap.y - prev.y) * scale <= DOUBLE_TAP_SLOP;
}
