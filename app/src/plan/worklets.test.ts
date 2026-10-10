/**
 * The plan's UI-thread code as the UI runtime sees it (D95, D101). The worklets Babel plugin turns
 * each `'worklet'` function into a code string that runs on its own with captured values read from
 * `this.__closure` inside the body. Code that is fine on the JS thread can break there: build 5
 * crashed because `opts = LAYOUT_DEFAULTS` (a default parameter) is evaluated before the body has
 * read `LAYOUT_DEFAULTS` from the closure. This test runs the real plugin over the plan's worklet
 * files and executes the code strings with their closures bound, as the UI runtime would.
 */

import { transformSync } from '@babel/core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as layoutModule from './layout';
import * as pinsModule from './pins';
import { sheetToView, type PdfViewport } from './viewport';
import * as viewportModule from './viewport';

const require = createRequire(import.meta.url);
const FILES = ['layout.ts', 'pins.ts', 'viewport.ts', 'drawPins.ts'];

type Worklet = { name: string; file: string; code: string; closure: string[] };

function compiledWorklets(file: string, nameRe = /^\(function (\w+?)_\w+Ts\d+\(/): Worklet[] {
  const filename = join(__dirname, file);
  const out = transformSync(readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    presets: [require.resolve('@babel/preset-typescript')],
    plugins: [require.resolve('react-native-worklets/plugin')],
  });
  const found: Worklet[] = [];
  for (const m of out!.code!.matchAll(/code:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const code = JSON.parse(`"${m[1]}"`) as string;
    const name = nameRe.exec(code)?.[1];
    if (!name) continue;
    const closure = /const\s*\{?\[?([^\]=]*)\]?\}?\s*=\s*this\.__closure/.exec(code)?.[1];
    found.push({ name, file, code, closure: closure ? closure.split(',').map((s) => s.trim()).filter(Boolean) : [] });
  }
  return found;
}

const worklets = FILES.flatMap((f) => compiledWorklets(f));
const byName = new Map(worklets.map((w) => [w.name, w]));
const exportsOf: Record<string, unknown> = { ...viewportModule, ...pinsModule, ...layoutModule };

/** A worklet as the UI runtime would run it: its code string alone, closure values bound. */
function ui<T extends (...args: never[]) => unknown>(name: string): T {
  const w = byName.get(name);
  if (!w) throw new Error(`no compiled worklet ${name}`);
  const fn = (0, eval)(w.code) as T;
  const closure = w.closure.map((n) => (byName.has(n) ? ui(n) : exportsOf[n]));
  w.closure.forEach((n, i) => {
    if (closure[i] === undefined) throw new Error(`${name}: closure value ${n} unknown to the test`);
  });
  return ((...args: never[]) => fn.apply({ __closure: closure }, args)) as unknown as T;
}

const CROP = { x: 0, y: 0, width: 4235.48, height: 3604.72 };
const vp = (s: number): PdfViewport => ({ a: s, b: 0, c: 0, d: -s, tx: 0, ty: s * CROP.height, cropBox: CROP, page: 1 });

describe('plan worklets on the UI runtime', () => {
  it('the plugin compiles every worklet the overlay uses', () => {
    for (const n of ['layoutPins', 'hitTest', 'pinShape', 'regularPolygon', 'apply', 'scaleOf', 'drawPins', 'drawPin', 'shapeAt', 'centredText', 'compose', 'sheetToPage', 'sheetToView', 'parseViewportMessage']) {
      expect(byName.has(n), n).toBe(true);
    }
  });

  it('no worklet reads a captured value in its parameter list (the build-5 crash)', () => {
    for (const w of worklets) {
      const params = /^\(function \w+\(([^)]*)\)/.exec(w.code)?.[1] ?? '';
      for (const n of w.closure) expect(new RegExp(`\\b${n}\\b`).test(params), `${w.name}(${params}) uses ${n}`).toBe(false);
    }
  });

  it('layoutPins, hitTest and pinShape run from their code strings and agree with the JS thread', () => {
    const pins = [
      { x: 1000, y: 1000, rank: 1, fill: '#2e7d32' },
      { x: 1020, y: 1000, rank: 6, fill: '#c62828' },
      { x: 3000, y: 2500, rank: 2, fill: '#6a1b9a' },
    ] as unknown as layoutModule.RenderPin[];
    const m = sheetToView(vp(0.2));
    const layoutUi = ui<typeof layoutModule.layoutPins>('layoutPins');
    const onUi = layoutUi(pins, m, 1000, 800); // four arguments, as PinOverlay calls it
    expect(onUi).toEqual(layoutModule.layoutPins(pins, m, 1000, 800));
    expect(onUi.clusters).toHaveLength(1);
    const c = onUi.clusters[0]!;
    expect(ui<typeof layoutModule.hitTest>('hitTest')(onUi, c.vx, c.vy, 26)).toEqual({ kind: 'cluster', members: [0, 1] });
    for (const cat of [...pinsModule.DEVICE_CATEGORIES, 'Unknown']) {
      expect(ui<typeof pinsModule.pinShape>('pinShape')(cat, 26)).toEqual(pinsModule.pinShape(cat, 26));
    }
  });

  it('the viewport event handler (T64) parses the patch message and drives the matrix on the UI thread', () => {
    // As RNPDFPdfView.mm formats it: %f for the numbers, %lu for the page.
    const v = vp(0.37);
    const f = (x: number) => x.toFixed(6);
    const message = ['viewport', ...[v.a, v.b, v.c, v.d, v.tx, v.ty, CROP.x, CROP.y, CROP.width, CROP.height].map(f), '1'].join('|');
    const parse = ui<typeof viewportModule.parseViewportMessage>('parseViewportMessage');
    expect(parse(message)).toEqual(viewportModule.parseViewportMessage(message));
    expect(parse(message)).toEqual({ ...v, cropBox: { x: 0, y: 0, width: 4235.48, height: 3604.72 } });
    expect(parse('pageSingleTap|1|10.000000|20.000000|30.000000|40.000000')).toBeNull();
    expect(parse('viewport|1|0|0|-1|0|nan|0|0|10|10|1')).toBeNull();

    // The two inline worklets of uiViewport.ts, as the UI runtime runs them.
    const inline = compiledWorklets('uiViewport.ts', /^\(function (uiViewportTs\d+)\(/);
    const code = (n: string) => (0, eval)(inline.find((w) => w.name === n)!.code) as (arg: unknown) => void;
    const uiDriven = { value: false };
    const matrix: { value: unknown } = { value: null };
    const handler = code('uiViewportTs1');
    const fromJs = code('uiViewportTs2');
    expect(inline.find((w) => w.name === 'uiViewportTs1')!.closure).toEqual(['parseViewportMessage', 'uiDriven', 'matrix', 'sheetToView']);
    const handlerThis = { __closure: [parse, uiDriven, matrix, ui('sheetToView')] };
    const fromJsThis = { __closure: [uiDriven, matrix] };

    fromJs.call(fromJsThis, { a: 9 }); // before the UI handler is live, the JS copy seeds the matrix
    expect(matrix.value).toEqual({ a: 9 });
    handler.call(handlerThis, { message: 'pageSingleTap|1|1|1|1|1' });
    expect(matrix.value).toEqual({ a: 9 });
    handler.call(handlerThis, { message });
    expect(uiDriven.value).toBe(true);
    const m = matrix.value as viewportModule.Affine;
    const expected = sheetToView(parse(message)!);
    for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(m[k]).toBeCloseTo(expected[k], 9);
    fromJs.call(fromJsThis, { a: 1 }); // a later (stale) JS copy is ignored
    expect(matrix.value).toBe(m);
  });
});
