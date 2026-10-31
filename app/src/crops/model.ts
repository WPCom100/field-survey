/**
 * Source crops and the riser crop (T44, T106, T129): what to say when one does not load, and the
 * pinch / pan maths of an enlarged crop. Pure (the zoom functions are worklets too), tested in Node.
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

// ------------------------------------------------------------------ zoom and pan

/** Scale (1 = fit) and translation in view points, about the view's centre. */
export type Zoom = { scale: number; x: number; y: number };
export type ViewSize = { width: number; height: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Double tap on a fitted crop zooms to this. */
export const TAP_ZOOM = 3;

export function clampScale(s: number): number {
  'worklet';
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));
}

/** Keep the zoomed content over the view: no pan at scale 1, at most the overhang beyond. */
export function clampZoom(z: Zoom, view: ViewSize): Zoom {
  'worklet';
  const scale = clampScale(z.scale);
  const mx = (view.width * (scale - 1)) / 2;
  const my = (view.height * (scale - 1)) / 2;
  return { scale, x: Math.min(mx, Math.max(-mx, z.x)), y: Math.min(my, Math.max(-my, z.y)) };
}

/**
 * A pinch from `start` by the gesture's `factor` about `focal` (view points, top-left origin): the
 * point under the fingers stays put, plus the focal point's own drift (`drift`, two-finger pan).
 */
export function pinchZoom(start: Zoom, factor: number, focal: { x: number; y: number }, drift: { x: number; y: number }, view: ViewSize): Zoom {
  'worklet';
  const scale = clampScale(start.scale * factor);
  const k = scale / start.scale;
  const fx = focal.x - view.width / 2;
  const fy = focal.y - view.height / 2;
  return clampZoom({ scale, x: fx - (fx - start.x) * k + drift.x, y: fy - (fy - start.y) * k + drift.y }, view);
}

/** A one-finger drag from `start` by (dx, dy). */
export function panZoom(start: Zoom, dx: number, dy: number, view: ViewSize): Zoom {
  'worklet';
  return clampZoom({ scale: start.scale, x: start.x + dx, y: start.y + dy }, view);
}

/** Double tap: back to fit when zoomed, else `TAP_ZOOM` about the tapped point. */
export function doubleTapZoom(current: Zoom, at: { x: number; y: number }, view: ViewSize): Zoom {
  'worklet';
  if (current.scale > MIN_ZOOM + 0.01) return { scale: MIN_ZOOM, x: 0, y: 0 };
  return pinchZoom({ scale: MIN_ZOOM, x: 0, y: 0 }, TAP_ZOOM, at, { x: 0, y: 0 }, view);
}
