import { TransportError } from '@field-survey/core';
import { describe, expect, it } from 'vitest';

import { apply, displayRectToPage, pageRectToSheet, pageRectToView, sheetRectToPage, sheetToView, type PdfViewport } from '../plan/viewport';
import { clampZoom, cropCacheName, doubleTapZoom, downloadError, failureText, MAX_ZOOM, panZoom, pinchZoom, TAP_ZOOM } from './model';

const view = { width: 400, height: 300 };

describe('failure text (T129)', () => {
  it('names a timeout, no connection and no server', () => {
    expect(failureText('The crop', new TransportError('network', 'Aborted'))).toMatch(/did not answer in time/);
    expect(failureText('The crop', new TransportError('network', 'timed out'))).toMatch(/did not answer in time/);
    expect(failureText('The crop', new TransportError('network', 'Network request failed'))).toMatch(/not reachable/);
    expect(failureText('The riser PDF', 'no_transport')).toMatch(/^The riser PDF could not be downloaded: this iPad is not connected/);
  });

  it("gives the server's status and its detail", () => {
    const missing = new TransportError('rejected', 'GET /imports/x/crop → 404', 404, { detail: "the import's file is missing from storage" });
    expect(failureText('The crop', missing)).toBe("The crop is not on the server (the import's file is missing from storage).");
    expect(failureText('The riser PDF', new TransportError('rejected', 'x', 404))).toBe('The riser PDF is not on the server (404).');
    const bad = new TransportError('rejected', 'x', 422, { detail: { error: 'bad_crop', detail: 'page 9 out of range' } });
    expect(failureText('The crop', bad)).toBe('The crop did not load: the server answered 422 (page 9 out of range).');
    expect(failureText('The crop', new TransportError('server', 'x', 502))).toBe('The crop did not load: server error 502. Try again in a minute.');
    expect(failureText('The crop', new TransportError('auth', 'x', 401))).toMatch(/token \(401\)/);
    expect(failureText('The crop', new Error('disk full'))).toBe('The crop did not load: disk full');
  });

  it("reads the status out of a native download's rejection", () => {
    const e = downloadError(new Error('Unable to download file: 503 Service Unavailable'));
    expect([e.failure, e.status]).toEqual(['server', 503]);
    expect(downloadError(new Error('404')).failure).toBe('rejected');
    expect(downloadError(new Error('The Internet connection appears to be offline.')).failure).toBe('network');
  });

  it('keeps one cache file per crop URL', () => {
    const a = cropCacheName('https://s/imports/1/crop?page=1&bbox=1,2,3,4&pad=24&px=800');
    expect(a).toMatch(/^crop-[0-9a-f]{16}\.png$/);
    expect(cropCacheName('https://s/imports/1/crop?page=1&bbox=1,2,3,4&pad=24&px=800')).toBe(a);
    expect(cropCacheName('https://s/imports/1/crop?page=1&bbox=1,2,3,4&pad=24&px=2000')).not.toBe(a);
  });
});

describe('pinch and pan (T129)', () => {
  it('keeps the point under the fingers still while zooming', () => {
    const focal = { x: 300, y: 100 };
    const z = pinchZoom({ scale: 1, x: 0, y: 0 }, 2, focal, { x: 0, y: 0 }, view);
    expect(z.scale).toBe(2);
    // content point p (centre-relative) is shown at p * scale + t
    const p = { x: focal.x - view.width / 2, y: focal.y - view.height / 2 };
    expect(p.x * z.scale + z.x).toBeCloseTo(p.x);
    expect(p.y * z.scale + z.y).toBeCloseTo(p.y);
  });

  it('clamps the scale and never pans the content off the view', () => {
    expect(pinchZoom({ scale: 4, x: 0, y: 0 }, 10, { x: 200, y: 150 }, { x: 0, y: 0 }, view).scale).toBe(MAX_ZOOM);
    expect(pinchZoom({ scale: 2, x: 50, y: 0 }, 0.1, { x: 200, y: 150 }, { x: 0, y: 0 }, view)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panZoom({ scale: 1, x: 0, y: 0 }, 80, 40, view)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panZoom({ scale: 2, x: 0, y: 0 }, 500, -500, view)).toEqual({ scale: 2, x: 200, y: -150 });
    expect(clampZoom({ scale: 3, x: 10, y: -20 }, view)).toEqual({ scale: 3, x: 10, y: -20 });
  });

  it('pans with two fingers during a pinch', () => {
    const z = pinchZoom({ scale: 2, x: 0, y: 0 }, 1, { x: 200, y: 150 }, { x: 30, y: -10 }, view);
    expect(z).toEqual({ scale: 2, x: 30, y: -10 });
  });

  it('double tap zooms in on the spot, and back to fit', () => {
    const z = doubleTapZoom({ scale: 1, x: 0, y: 0 }, { x: 250, y: 150 }, view);
    expect(z.scale).toBe(TAP_ZOOM);
    expect(50 * z.scale + z.x).toBeCloseTo(50);
    expect(doubleTapZoom(z, { x: 0, y: 0 }, view)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('riser outline in sheet coordinates (T129)', () => {
  it('lands on the same view rect as the page rect, on a rotated page too', () => {
    // a /Rotate 270 page as PDFKit reports it: x in view follows −page y
    const vp: PdfViewport = { a: 0, b: 2, c: -2, d: 0, tx: 900, ty: -100, cropBox: { x: 0, y: 0, width: 1224, height: 792 }, page: 1 };
    const box = displayRectToPage(vp, 270, { x: 100, y: 200, width: 40, height: 20 });
    const sheet = pageRectToSheet(vp, box);
    expect(sheetRectToPage(vp, sheet)).toEqual(box);
    expect(pageRectToView(sheetToView(vp), sheet)).toEqual(pageRectToView(vp, box));
    const centre = apply(vp, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const r = pageRectToView(sheetToView(vp), sheet);
    expect(r.x + r.width / 2).toBeCloseTo(centre.x);
  });
});
