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

function compiledWorklets(file: string): Worklet[] {
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
    const name = /^\(function (\w+?)_\w+Ts\d+\(/.exec(code)?.[1];
    if (!name) continue;
    const closure = /const\s*\{?\[?([^\]=]*)\]?\}?\s*=\s*this\.__closure/.exec(code)?.[1];
    found.push({ name, file, code, closure: closure ? closure.split(',').map((s) => s.trim()).filter(Boolean) : [] });
  }
  return found;
}

const worklets = FILES.flatMap(compiledWorklets);
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
    for (const n of ['layoutPins', 'hitTest', 'pinShape', 'regularPolygon', 'apply', 'scaleOf', 'drawPins', 'drawPin', 'shapeAt', 'centredText']) {
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
});
