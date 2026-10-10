/**
 * T16 — plan viewer spike (TP-6). Not a product screen.
 *
 * `react-native-pdf` (PDFKit) renders the 06M composite and owns pan/zoom. The patched
 * module reports the page→view affine on every scroll/zoom (`onViewportChanged`); a Skia
 * canvas on top draws 40 dummy pins and ink strokes in **sheet** coordinates under that
 * matrix. Taps come back from PDFKit with its own page mapping, so the HUD shows our
 * computed sheet point next to PDFKit's — the two must agree at every zoom level.
 *
 * What the HUD measures: time to `loadComplete` and to the first viewport event, zoom,
 * viewport event count, tap agreement, and a 100× zoom-cycle stress button. Frame rate and
 * RAM are read from the React Native Perf Monitor (dev menu), see docs/perf/tp6.md.
 */

import { Canvas, Group, Path, Skia, Text as SkText, matchFont, type SkPath } from '@shopify/react-native-skia';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type GestureResponderEvent,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Pdf from 'react-native-pdf';

import { dummyPins, nearestPin, pinShape, pinStyle, type DummyPin } from './pins';
import {
  apply,
  pageToSheet,
  scaleOf,
  sheetToView,
  toSkiaMatrix,
  viewToSheet,
  type PdfViewport,
  type Point,
} from './viewport';

// Private golden fixture, served by Metro in development and bundled by EAS otherwise.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SHEET = Image.resolveAssetSource(require('../../../fixtures/Level_06M_-_Lighting_Composite_vector.pdf'));

const PIN_PX = 26; // on-screen pin size
const HIT_PX = 24; // tap radius in screen points
const ZOOM_CYCLES = 100;
const ZOOM_HI = 4;
const ZOOM_PERIOD_MS = 350;

const CROSSHAIR = (() => {
  const p = Skia.Path.Make();
  p.moveTo(-15, 0).lineTo(15, 0).moveTo(0, -15).lineTo(0, 15);
  p.addCircle(0, 0, 10);
  return p;
})();

type Stroke = { points: { x: number; y: number; p: number }[]; width: number; color: string };

type TapInfo = {
  view: Point;
  computed: Point;
  pdfkit: Point;
  deltaPt: number;
  zoom: number;
  hit: string | null;
};

const now = () => globalThis.performance.now();

function shapePath(category: DummyPin['category']): SkPath {
  const shape = pinShape(category, PIN_PX);
  const path = Skia.Path.Make();
  if (shape.kind === 'circle') {
    path.addCircle(0, 0, shape.radius);
  } else if (shape.kind === 'rect') {
    const r = Skia.XYWHRect(-shape.width / 2, -shape.height / 2, shape.width, shape.height);
    if (shape.radius > 0) path.addRRect(Skia.RRectXY(r, shape.radius, shape.radius));
    else path.addRect(r);
  } else {
    shape.points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
    path.close();
  }
  return path;
}

function strokePath(s: Stroke): SkPath {
  const path = Skia.Path.Make();
  s.points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
  if (s.points.length === 1) path.lineTo(s.points[0].x + 0.01, s.points[0].y);
  return path;
}

export function PlanSpike() {
  const mountedAt = useRef(now());
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [firstViewportMs, setFirstViewportMs] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<PdfViewport | null>(null);
  const viewportEvents = useRef(0);
  const [scaleProp, setScaleProp] = useState(1);
  const [mode, setMode] = useState<'pan' | 'draw'>('pan');
  const [showPins, setShowPins] = useState(true);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Stroke | null>(null);
  const [tap, setTap] = useState<TapInfo | null>(null);
  const [taps, setTaps] = useState(0);
  const [cycles, setCycles] = useState(0);
  const [cycling, setCycling] = useState(false);
  const [jsFps, setJsFps] = useState<{ now: number; min: number }>({ now: 0, min: 0 });

  // JS-thread frame rate (requestAnimationFrame), for builds without the Perf Monitor
  // (TestFlight). The UI-thread rate and RAM still need the dev client's Perf Monitor.
  useEffect(() => {
    let frames = 0;
    let last = now();
    let raf = 0;
    const started = last;
    const tick = () => {
      frames += 1;
      const t = now();
      if (t - last >= 1000) {
        const fps = Math.round((frames * 1000) / (t - last));
        // ignore the first 3 s (mount, PDF load)
        setJsFps((s) => ({ now: fps, min: t - started < 3000 ? 0 : s.min === 0 ? fps : Math.min(s.min, fps) }));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Only the sheet size matters for pin placement; the first viewport fixes it.
  const sheetW = viewport?.cropBox.width ?? 0;
  const sheetH = viewport?.cropBox.height ?? 0;
  const pins = useMemo(() => (sheetW && sheetH ? dummyPins(40, sheetW, sheetH) : []), [sheetW, sheetH]);
  const shapes = useMemo(() => new Map(pins.map((p) => [p.id, shapePath(p.category)])), [pins]);
  const glyphFont = useMemo(() => matchFont({ fontFamily: 'Helvetica', fontSize: 11, fontWeight: 'bold' }), []);
  const labelFont = useMemo(() => matchFont({ fontFamily: 'Helvetica', fontSize: 11 }), []);
  const strokePaths = useMemo(() => strokes.map(strokePath), [strokes]);
  const livePath = useMemo(() => (live ? strokePath(live) : null), [live]);

  const onViewportChanged = useCallback((vp: PdfViewport) => {
    viewportEvents.current += 1;
    setFirstViewportMs((t) => t ?? Math.round(now() - mountedAt.current));
    setViewport(vp);
  }, []);

  const sheetMatrix = viewport ? sheetToView(viewport) : null;
  const zoom = sheetMatrix ? scaleOf(sheetMatrix) : 0;

  // --- taps (pan mode): PDFKit hands back view and page points; we map view → sheet ourselves.
  const onPageSingleTap = useCallback(
    (_page: number, x: number, y: number, pageX: number, pageY: number) => {
      if (!viewport) return;
      const m = sheetToView(viewport);
      const computed = apply(viewToSheet(viewport), { x, y });
      const pdfkit = pageToSheet(viewport, { x: pageX, y: pageY });
      const k = scaleOf(m);
      const hit = nearestPin(pins, computed, HIT_PX / k);
      setTaps((n) => n + 1);
      setTap({
        view: { x, y },
        computed,
        pdfkit,
        deltaPt: Math.hypot(computed.x - pdfkit.x, computed.y - pdfkit.y),
        zoom: k,
        hit: hit?.id ?? null,
      });
    },
    [viewport, pins],
  );

  // --- ink (draw mode): touches on the overlay, stored in sheet units.
  const toSheet = useCallback(
    (e: GestureResponderEvent) => {
      if (!viewport) return null;
      const { locationX, locationY, force } = e.nativeEvent;
      const p = apply(viewToSheet(viewport), { x: locationX, y: locationY });
      return { x: p.x, y: p.y, p: typeof force === 'number' && force > 0 ? force : 1 };
    },
    [viewport],
  );
  const onTouchStart = (e: GestureResponderEvent) => {
    const p = toSheet(e);
    if (!p || !viewport) return;
    const k = scaleOf(sheetToView(viewport));
    setLive({ points: [p], width: (3 / k) * (0.5 + p.p), color: '#1565c0' });
  };
  const onTouchMove = (e: GestureResponderEvent) => {
    const p = toSheet(e);
    if (!p) return;
    setLive((s) => (s ? { ...s, points: [...s.points, p] } : s));
  };
  const onTouchEnd = () => {
    setLive((s) => {
      if (s) setStrokes((all) => [...all, s]);
      return null;
    });
  };

  // --- zoom-cycle stress: flips the `scale` prop between 1 and ZOOM_HI, ZOOM_CYCLES times.
  useEffect(() => {
    if (!cycling) return;
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      setScaleProp(step % 2 === 1 ? ZOOM_HI : 1);
      if (step % 2 === 0) setCycles((c) => c + 1);
      if (step >= ZOOM_CYCLES * 2) setCycling(false);
    }, ZOOM_PERIOD_MS);
    return () => clearInterval(timer);
  }, [cycling]);

  const pinCount = pins.length;
  const strokeCount = strokes.length + (live ? 1 : 0);
  const pointCount = strokes.reduce((n, s) => n + s.points.length, 0) + (live?.points.length ?? 0);

  return (
    <View style={styles.root}>
      <Pdf
        style={styles.pdf}
        source={{ uri: SHEET.uri, cache: true }}
        fitPolicy={2}
        scale={scaleProp}
        minScale={1}
        maxScale={8}
        spacing={0}
        enableAnnotationRendering={false}
        enableTextSelection={false}
        onLoadComplete={(_n, _path, size) => {
          // keep the first value: PDFKit re-posts the document-changed notification later
          // (the TestFlight run showed 210 s after a 169 ms first viewport)
          setLoadMs((t) => t ?? Math.round(now() - mountedAt.current));
          setPageSize(size);
        }}
        onViewportChanged={onViewportChanged}
        onPageSingleTap={onPageSingleTap}
        onError={(e) => setError(String(e?.message ?? e))}
      />

      {/* The overlay must never take a touch: pinch/pan/tap belong to PDFKit (pan mode). */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        {sheetMatrix ? (
          <Group matrix={Skia.Matrix(toSkiaMatrix(sheetMatrix))}>
            {strokePaths.map((p, i) => (
              <Path
                key={i}
                path={p}
                style="stroke"
                strokeWidth={strokes[i].width}
                strokeCap="round"
                strokeJoin="round"
                color={strokes[i].color}
              />
            ))}
            {livePath && live ? (
              <Path path={livePath} style="stroke" strokeWidth={live.width} strokeCap="round" strokeJoin="round" color={live.color} />
            ) : null}
            {tap ? (
              // crosshair at the last tap (sheet point), constant 30 px on screen
              <Group transform={[{ translateX: tap.computed.x }, { translateY: tap.computed.y }, { scale: 1 / zoom }]}>
                <Path path={CROSSHAIR} style="stroke" strokeWidth={4} color="white" />
                <Path path={CROSSHAIR} style="stroke" strokeWidth={2} color="#00bcd4" />
              </Group>
            ) : null}
            {showPins
              ? pins.map((pin) => {
                  const st = pinStyle(pin.status);
                  const shape = shapes.get(pin.id)!;
                  const selected = tap?.hit === pin.id;
                  const glyphW = glyphFont.getTextWidth(st.glyph);
                  const labelW = labelFont.getTextWidth(pin.id);
                  return (
                    <Group key={pin.id} transform={[{ translateX: pin.x }, { translateY: pin.y }, { scale: 1 / zoom }]}>
                      {selected ? <Path path={shape} style="stroke" strokeWidth={6} color="#00bcd4" /> : null}
                      <Path path={shape} style={st.hollow ? 'stroke' : 'fill'} strokeWidth={2.5} color={st.fill} />
                      {st.hollow ? null : <Path path={shape} style="stroke" strokeWidth={1.5} color="white" />}
                      <SkText x={-glyphW / 2} y={4} text={st.glyph} font={glyphFont} color={st.hollow ? st.fill : 'white'} />
                      <SkText x={-labelW / 2} y={PIN_PX / 2 + 12} text={pin.id} font={labelFont} style="stroke" strokeWidth={3} color="white" />
                      <SkText x={-labelW / 2} y={PIN_PX / 2 + 12} text={pin.id} font={labelFont} color="#111" />
                    </Group>
                  );
                })
              : null}
          </Group>
        ) : null}
      </Canvas>
      </View>

      {mode === 'draw' ? (
        <View
          style={StyleSheet.absoluteFill}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        />
      ) : null}

      <View style={styles.hud} pointerEvents="none">
        <Text style={styles.hudTitle}>TP-6 · 06M composite</Text>
        <Text style={styles.hudLine}>
          load {loadMs ?? '…'} ms · first viewport {firstViewportMs ?? '…'} ms · page{' '}
          {pageSize ? `${Math.round(pageSize.width)}×${Math.round(pageSize.height)} pt` : '…'}
        </Text>
        <Text style={styles.hudLine}>
          zoom ×{zoom.toFixed(3)} (prop {scaleProp}) · JS fps {jsFps.now} (min {jsFps.min || '…'}) · viewport events{' '}
          {viewportEvents.current} · pins {pinCount} · strokes {strokeCount} ({pointCount} pts)
        </Text>
        <Text style={styles.hudLine}>
          {tap
            ? `tap view (${tap.view.x.toFixed(0)}, ${tap.view.y.toFixed(0)}) → sheet ours (${tap.computed.x.toFixed(1)}, ${tap.computed.y.toFixed(1)}) · PDFKit (${tap.pdfkit.x.toFixed(1)}, ${tap.pdfkit.y.toFixed(1)}) · Δ ${tap.deltaPt.toFixed(2)} pt @ ×${tap.zoom.toFixed(2)} · hit ${tap.hit ?? '—'}`
            : 'tap the plan (pan mode) to compare our mapping with PDFKit’s'}
          {` · taps ${taps}`}
        </Text>
        <Text style={styles.hudLine}>
          zoom cycles {cycles}/{ZOOM_CYCLES} {cycling ? '(running)' : ''}
          {error ? ` · ERROR ${error}` : ''}
        </Text>
      </View>

      <View style={styles.toolbar}>
        <Button label={mode === 'pan' ? 'Pan ✓' : 'Pan'} onPress={() => setMode('pan')} />
        <Button label={mode === 'draw' ? 'Draw ✓' : 'Draw'} onPress={() => setMode('draw')} />
        <Button label={showPins ? 'Pins ✓' : 'Pins'} onPress={() => setShowPins((v) => !v)} />
        <Button label="Clear ink" onPress={() => { setStrokes([]); setLive(null); }} />
        <Button label="Fit" onPress={() => setScaleProp((s) => (s === 1 ? 1.0001 : 1))} />
        <Button label="×2" onPress={() => setScaleProp(2)} />
        <Button label="×4" onPress={() => setScaleProp(4)} />
        <Button
          label={cycling ? 'Stop cycles' : `${ZOOM_CYCLES} zoom cycles`}
          onPress={() => {
            if (!cycling) setCycles(0);
            setCycling((v) => !v);
          }}
        />
      </View>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#333' },
  pdf: { flex: 1, backgroundColor: '#333' },
  hud: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    maxWidth: 760,
    padding: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  hudTitle: { color: 'white', fontWeight: '600', fontSize: 13 },
  hudLine: { color: 'white', fontSize: 12, fontVariant: ['tabular-nums'] },
  toolbar: { position: 'absolute', right: 8, top: 8, gap: 6 },
  button: { backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  buttonPressed: { backgroundColor: 'rgba(21,101,192,0.9)' },
  buttonText: { color: 'white', fontSize: 14 },
});
