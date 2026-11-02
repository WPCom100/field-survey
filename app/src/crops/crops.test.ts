import { TransportError } from '@field-survey/core';
import { describe, expect, it } from 'vitest';

import { apply, displayRectToPage, pageRectToSheet, pageRectToView, sheetRectToPage, sheetToView, type PdfViewport } from '../plan/viewport';
import { cropCacheName, DOUBLE_TAP_MS, downloadError, failureText, isDoubleTap, tapZoomRect } from './model';

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

describe('double tap on an enlarged crop (T135)', () => {
  it('zooms in three times on the spot, and back to fit', () => {
    expect(tapZoomRect(1, { x: 300, y: 150 }, view)).toEqual({ x: 300 - view.width / 6, y: 150 - view.height / 6, width: view.width / 3, height: view.height / 3 });
    expect(tapZoomRect(2.5, { x: 300, y: 150 }, view)).toEqual({ x: 0, y: 0, width: view.width, height: view.height });
  });

  it('keeps the zoom rect inside the image near an edge', () => {
    const r = tapZoomRect(1, { x: 5, y: view.height - 5 }, view);
    expect(r.x).toBe(0);
    expect(r.y + r.height).toBeCloseTo(view.height);
  });

  it('pairs two quick taps on the same spot, not a slow or distant second tap', () => {
    const first = { t: 1000, x: 100, y: 100 };
    expect(isDoubleTap(null, first, 1)).toBe(false);
    expect(isDoubleTap(first, { t: 1200, x: 110, y: 95 }, 1)).toBe(true);
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS + 1, x: 100, y: 100 }, 1)).toBe(false);
    expect(isDoubleTap(first, { t: 1200, x: 160, y: 100 }, 1)).toBe(false);
    // zoomed in 4×, 15 image points is 60 on screen
    expect(isDoubleTap(first, { t: 1200, x: 115, y: 100 }, 4)).toBe(false);
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
