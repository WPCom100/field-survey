/**
 * Plan view (T17, Phase 3 §4.2): the level's display sheet in PDFKit with the Skia pin layer on
 * top (left ~62 %), the device list beside it (right ~38 %, D44; T19 grows it into four tabs).
 *
 * - Pins come from `device.pin` in sheet coordinates (D92), shaped by category and coloured by
 *   status (D64), clustered at low zoom; drawn on the UI thread from the viewport (D95).
 * - Tap a pin → select it and scroll its row into view; tap a cluster → zoom into it; tap a row →
 *   select it and bring its pin into view. Pinch/pan are PDFKit's; "Fit" shows the whole sheet.
 * - Filters (Category, Status, Owner, Open punch — D99) and layers persist per level on this iPad.
 */

import type { Store } from '@field-survey/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Pdf, { type PdfRef } from 'react-native-pdf';
import { useSharedValue } from 'react-native-reanimated';

import { loadLevelPlan, type LevelPlan, type PlanDevice, type PlanSheet } from './data';
import { PIN_PX } from './drawPins';
import {
  DEFAULT_LAYERS,
  EMPTY_FILTER,
  NO_STATUS,
  OWNERS,
  STATUS_KEYS,
  isFiltering,
  matchesFilter,
  parsePrefs,
  prefsKey,
  toggle,
  type PlanFilter,
  type PlanLayers,
  type PlanPrefs,
  type StatusKey,
} from './filters';
import { LAYOUT_DEFAULTS, hitTest, layoutPins, type RenderPin } from './layout';
import { PinOverlay } from './PinOverlay';
import { DEVICE_CATEGORIES, pinStyleFor, statusRank } from './pins';
import {
  focusRect,
  inView,
  scaleOf,
  sheetRect,
  sheetRectToPage,
  sheetToView,
  type Affine,
  type PdfViewport,
  type Point,
  type Rect,
} from './viewport';

const HIT_PX = PIN_PX; // tap radius, screen points
/** Zoom used to bring a single pin into view: past the cluster cut-off, so it stands alone. */
const REVEAL_ZOOM = LAYOUT_DEFAULTS.offZoom * 1.25;
const ROW_H = 52;

type Menu = 'category' | 'status' | 'owner' | 'layers' | null;

export type PlanScreenProps = {
  store: Store;
  levelId: string;
  /** A `file://` or asset URI for the sheet, or null when its bytes are not on this iPad. */
  resolveSheetUri: (sheet: PlanSheet) => string | null;
  onBack: () => void;
  /** Right side of the top bar (global status, T18/T25). */
  status?: string;
  /** Changes when the store may have changed underneath (a sync brought ops): reload. */
  reloadKey?: unknown;
  /** Dev-only TP-6 bench controls (demo level). */
  bench?: boolean;
};

function toRenderPin(d: PlanDevice): RenderPin {
  const st = pinStyleFor(d.status);
  return {
    id: d.id,
    x: d.pin!.x,
    y: d.pin!.y,
    category: d.category,
    fill: st.fill,
    hollow: st.hollow,
    glyph: st.glyph,
    label: d.label,
    plus: d.fieldAddition,
    isNew: d.isNew,
    photos: d.photos,
    rank: statusRank(d.status),
  };
}

export function PlanScreen({ store, levelId, resolveSheetUri, onBack, status, reloadKey, bench }: PlanScreenProps) {
  const [plan, setPlan] = useState<LevelPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PlanPrefs>({ filter: EMPTY_FILTER, layers: DEFAULT_LAYERS });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const matrix = useSharedValue<Affine | null>(null);
  const vpRef = useRef<PdfViewport | null>(null);
  const pdfRef = useRef<PdfRef>(null);
  const listRef = useRef<FlatList<PlanDevice>>(null);

  // --- data and stored prefs
  useEffect(() => {
    let active = true;
    loadLevelPlan(store, levelId).then(
      (p) => {
        if (!active) return;
        if (p) setPlan(p);
        else setError('This level is not on this iPad.');
      },
      (e: unknown) => active && setError(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, levelId, reloadKey]);

  useEffect(() => {
    let active = true;
    store.getState(prefsKey(levelId)).then((raw) => active && setPrefs(parsePrefs(raw)), () => {});
    return () => {
      active = false;
    };
  }, [store, levelId]);

  const updatePrefs = useCallback(
    (fn: (p: PlanPrefs) => PlanPrefs) => {
      setPrefs((p) => {
        const next = fn(p);
        store.setState(prefsKey(levelId), next).catch((e: unknown) => console.warn('[plan] prefs not saved', e));
        return next;
      });
    },
    [store, levelId],
  );
  const setFilter = (fn: (f: PlanFilter) => PlanFilter) => updatePrefs((p) => ({ ...p, filter: fn(p.filter) }));
  const setLayer = (key: keyof PlanLayers) => updatePrefs((p) => ({ ...p, layers: { ...p.layers, [key]: !p.layers[key] } }));

  // --- what is shown
  const visible = useMemo(() => (plan ? plan.devices.filter((d) => matchesFilter(d, prefs.filter)) : []), [plan, prefs.filter]);
  const placed = useMemo(() => visible.filter((d) => d.pin), [visible]);
  const renderPins = useMemo(() => placed.map(toRenderPin), [placed]);
  const rowIndex = useMemo(() => new Map(visible.map((d, i) => [d.id, i])), [visible]);
  const categories = useMemo(() => {
    const extra = new Set((plan?.devices ?? []).map((d) => d.category).filter((c): c is string => !!c));
    return [...DEVICE_CATEGORIES, ...[...extra].filter((c) => !(DEVICE_CATEGORIES as readonly string[]).includes(c)).sort()];
  }, [plan]);

  // A filtered-out device cannot stay selected.
  useEffect(() => {
    if (selectedId && !rowIndex.has(selectedId)) setSelectedId(null);
  }, [rowIndex, selectedId]);

  const sheetUri = plan?.sheet ? resolveSheetUri(plan.sheet) : null;

  // --- viewport, fit and focus
  const focusSheetRect = useCallback((r: Rect, animated: boolean) => {
    const vp = vpRef.current;
    if (!vp) return;
    const p = sheetRectToPage(vp, r);
    pdfRef.current?.focusRect(p.x, p.y, p.width, p.height, animated);
  }, []);

  const fit = useCallback(() => {
    if (vpRef.current) focusSheetRect(sheetRect(vpRef.current), true);
  }, [focusSheetRect]);

  const onViewportChanged = useCallback(
    (vp: PdfViewport) => {
      const first = vpRef.current === null;
      vpRef.current = vp;
      matrix.value = sheetToView(vp);
      // The first viewport is "ready" (loadComplete re-fires much later, T16); open at fit.
      if (first) focusSheetRect(sheetRect(vp), false);
    },
    [matrix, focusSheetRect],
  );

  const reveal = useCallback(
    (points: Point[], minZoom: number) => {
      const vp = vpRef.current;
      if (!vp || !size.width || points.length === 0) return;
      const zoom = scaleOf(sheetToView(vp));
      const onScreen = points.every((p) => inView(vp, size, p, 40));
      if (onScreen && zoom >= minZoom) return;
      focusSheetRect(focusRect(points, size, Math.max(zoom, minZoom)), true);
    },
    [size, focusSheetRect],
  );

  const select = useCallback(
    (id: string | null, from: 'plan' | 'list') => {
      setSelectedId(id);
      if (!id) return;
      if (from === 'plan') {
        const index = rowIndex.get(id);
        if (index !== undefined) listRef.current?.scrollToIndex({ index, viewPosition: 0.4, animated: true });
      } else {
        const pin = visible[rowIndex.get(id) ?? -1]?.pin;
        if (pin) reveal([pin], REVEAL_ZOOM);
      }
    },
    [rowIndex, visible, reveal],
  );

  const onPageSingleTap = useCallback(
    (_page: number, x: number, y: number) => {
      const vp = vpRef.current;
      setMenu(null);
      if (!vp || !prefs.layers.pins) return;
      const layout = layoutPins(renderPins, sheetToView(vp), size.width, size.height);
      const hit = hitTest(layout, x, y, HIT_PX);
      if (!hit) {
        setSelectedId(null);
      } else if (hit.kind === 'pin') {
        select(renderPins[hit.index]!.id, 'plan');
      } else {
        const points = hit.members.map((i) => renderPins[i]!);
        focusSheetRect(focusRect(points, size, REVEAL_ZOOM), true);
      }
    },
    [renderPins, size, prefs.layers.pins, select, focusSheetRect],
  );

  // --- TP-6 bench: 100 zoom cycles between fit and ×4 around the sheet centre (dev only)
  const [cycles, setCycles] = useState<number | null>(null);
  useEffect(() => {
    if (cycles === null) return;
    if (cycles >= 200) {
      setCycles(null);
      return;
    }
    const t = setTimeout(() => {
      const vp = vpRef.current;
      if (vp) {
        const whole = sheetRect(vp);
        const fitZoom = Math.min(size.width / whole.width, size.height / whole.height);
        const c = { x: whole.width / 2, y: whole.height / 2 };
        focusSheetRect(cycles % 2 === 0 ? focusRect([c], size, fitZoom * 4, 0) : whole, false);
      }
      setCycles((n) => (n === null ? null : n + 1));
    }, 350);
    return () => clearTimeout(t);
  }, [cycles, size, focusSheetRect]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  const filtering = isFiltering(prefs.filter);
  const unplaced = visible.length - placed.length;

  return (
    <View style={styles.root}>
      {/* top bar */}
      <View style={styles.bar}>
        <Pressable onPress={onBack} style={styles.back} hitSlop={8}>
          <Text style={styles.backText}>◀ {plan?.level.code ?? '…'}</Text>
        </Pressable>
        <BarButton label="Category" count={prefs.filter.categories.length} open={menu === 'category'} onPress={() => setMenu(menu === 'category' ? null : 'category')} />
        <BarButton label="Status" count={prefs.filter.statuses.length} open={menu === 'status'} onPress={() => setMenu(menu === 'status' ? null : 'status')} />
        <BarButton label="Owner" count={prefs.filter.owners.length} open={menu === 'owner'} onPress={() => setMenu(menu === 'owner' ? null : 'owner')} />
        <Pressable style={[styles.chip, prefs.filter.openPunch && styles.chipOn]} onPress={() => setFilter((f) => ({ ...f, openPunch: !f.openPunch }))}>
          <Text style={[styles.chipText, prefs.filter.openPunch && styles.chipTextOn]}>{prefs.filter.openPunch ? '☑' : '☐'} Open punch</Text>
        </Pressable>
        {filtering ? (
          <Pressable style={styles.chip} onPress={() => setFilter(() => EMPTY_FILTER)}>
            <Text style={styles.chipText}>Clear</Text>
          </Pressable>
        ) : null}
        <View style={styles.spacer} />
        <BarButton label="Layers" open={menu === 'layers'} onPress={() => setMenu(menu === 'layers' ? null : 'layers')} />
        {status ? <Text style={styles.status} numberOfLines={1}>{status}</Text> : null}
      </View>

      <View style={styles.body}>
        {/* plan */}
        <View style={styles.plan} onLayout={onLayout}>
          {error ? (
            <Centered text={error} />
          ) : !plan ? (
            <Centered spinner />
          ) : !plan.sheet ? (
            <Centered text={`Level ${plan.level.code} has no display sheet yet (setup, T45).`} />
          ) : !sheetUri ? (
            <Centered text="The plan sheet is not downloaded to this iPad yet. It downloads with the next sync on Wi-Fi." />
          ) : (
            <>
              <Pdf
                ref={pdfRef}
                style={styles.pdf}
                source={{ uri: sheetUri, cache: true }}
                page={plan.sheet.page}
                fitPolicy={2}
                minScale={1}
                maxScale={8}
                spacing={0}
                enableAnnotationRendering={false}
                enableTextSelection={false}
                onViewportChanged={onViewportChanged}
                onPageSingleTap={onPageSingleTap}
                onError={(e) => setError(`The sheet could not be opened: ${String((e as Error)?.message ?? e)}`)}
              />
              {size.width > 0 ? (
                <PinOverlay
                  matrix={matrix}
                  pins={renderPins}
                  selectedId={selectedId}
                  showPins={prefs.layers.pins}
                  labels={prefs.layers.labels}
                  photos={prefs.layers.photos}
                  width={size.width}
                  height={size.height}
                />
              ) : null}
              <View style={styles.planTools}>
                <Pressable style={styles.tool} onPress={fit}>
                  <Text style={styles.toolText}>⌖ Fit</Text>
                </Pressable>
                {bench && __DEV__ ? (
                  <Pressable style={styles.tool} onPress={() => setCycles((c) => (c === null ? 0 : null))}>
                    <Text style={styles.toolText}>{cycles === null ? 'TP-6: 100 zoom cycles' : `cycle ${Math.floor(cycles / 2)}/100 — stop`}</Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          )}
        </View>

        {/* side list */}
        <View style={styles.side}>
          <View style={styles.sideHead}>
            <Text style={styles.sideTitle}>
              Devices {visible.length}
              {plan && visible.length !== plan.devices.length ? ` of ${plan.devices.length}` : ''}
            </Text>
            {unplaced > 0 ? <Text style={styles.sideNote}>{unplaced} not on the plan</Text> : null}
          </View>
          <FlatList
            ref={listRef}
            data={visible}
            keyExtractor={(d) => d.id}
            getItemLayout={(_d, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
            onScrollToIndexFailed={() => {}}
            renderItem={({ item }) => (
              <DeviceRow device={item} selected={item.id === selectedId} onPress={() => select(item.id === selectedId ? null : item.id, 'list')} />
            )}
            ListEmptyComponent={plan ? <Text style={styles.empty}>{filtering ? 'No device matches the filters.' : 'No devices on this level.'}</Text> : null}
          />
          <Legend />
        </View>

        {menu ? (
          <>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} />
            <View style={[styles.menu, menu === 'layers' ? styles.menuRight : null]}>
              {menu === 'category'
                ? categories.map((c) => (
                    <MenuItem key={c} label={c} on={prefs.filter.categories.includes(c)} onPress={() => setFilter((f) => ({ ...f, categories: toggle(f.categories, c, categories) }))} />
                  ))
                : null}
              {menu === 'status'
                ? STATUS_KEYS.map((s) => (
                    <MenuItem
                      key={s}
                      label={s === NO_STATUS ? 'No status yet' : s}
                      swatch={pinStyleFor(s === NO_STATUS ? null : s)}
                      on={prefs.filter.statuses.includes(s)}
                      onPress={() => setFilter((f) => ({ ...f, statuses: toggle<StatusKey>(f.statuses, s, STATUS_KEYS) }))}
                    />
                  ))
                : null}
              {menu === 'owner' ? (
                <>
                  {OWNERS.map((o) => (
                    <MenuItem key={o} label={o} on={prefs.filter.owners.includes(o)} onPress={() => setFilter((f) => ({ ...f, owners: toggle(f.owners, o, OWNERS) }))} />
                  ))}
                  <Text style={styles.menuNote}>Open punch items and missing parts. EC and ETC each include EC/ETC.</Text>
                </>
              ) : null}
              {menu === 'layers' ? (
                <>
                  <MenuItem label="Pins" on={prefs.layers.pins} onPress={() => setLayer('pins')} />
                  <MenuItem label="Labels" on={prefs.layers.labels} onPress={() => setLayer('labels')} />
                  <MenuItem label="Photos (camera mark)" on={prefs.layers.photos} onPress={() => setLayer('photos')} />
                  <MenuItem label="Ink (all users)" on={prefs.layers.ink} onPress={() => setLayer('ink')} />
                  <MenuItem label="Boundaries" on={false} disabled note="No boundary data for this sheet yet" onPress={() => {}} />
                </>
              ) : null}
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ pieces

function Centered({ text, spinner }: { text?: string; spinner?: boolean }) {
  return (
    <View style={styles.centered}>
      {spinner ? <ActivityIndicator color="#fff" /> : null}
      {text ? <Text style={styles.centeredText}>{text}</Text> : null}
    </View>
  );
}

function BarButton({ label, count, open, onPress }: { label: string; count?: number; open: boolean; onPress: () => void }) {
  const on = !!count;
  return (
    <Pressable style={[styles.chip, (on || open) && styles.chipOn]} onPress={onPress}>
      <Text style={[styles.chipText, (on || open) && styles.chipTextOn]}>
        {label}
        {count ? ` (${count})` : ''} ▾
      </Text>
    </Pressable>
  );
}

function MenuItem(props: {
  label: string;
  on: boolean;
  onPress: () => void;
  swatch?: { fill: string; hollow: boolean; glyph: string };
  disabled?: boolean;
  note?: string;
}) {
  return (
    <Pressable style={styles.menuItem} onPress={props.disabled ? undefined : props.onPress}>
      <Text style={[styles.menuCheck, props.disabled && styles.disabled]}>{props.on ? '☑' : '☐'}</Text>
      {props.swatch ? <Swatch {...props.swatch} /> : null}
      <View style={styles.menuLabelBox}>
        <Text style={[styles.menuLabel, props.disabled && styles.disabled]}>{props.label}</Text>
        {props.note ? <Text style={styles.menuNoteInline}>{props.note}</Text> : null}
      </View>
    </Pressable>
  );
}

function Swatch({ fill, hollow, glyph }: { fill: string; hollow: boolean; glyph: string }) {
  return (
    <View style={[styles.swatch, hollow ? { borderColor: fill, backgroundColor: '#fff' } : { backgroundColor: fill, borderColor: fill }]}>
      <Text style={[styles.swatchGlyph, { color: hollow ? fill : '#fff' }]}>{glyph}</Text>
    </View>
  );
}

function DeviceRow({ device, selected, onPress }: { device: PlanDevice; selected: boolean; onPress: () => void }) {
  const st = pinStyleFor(device.status);
  return (
    <Pressable style={[styles.row, selected && styles.rowSelected]} onPress={onPress}>
      <Swatch {...st} />
      <View style={styles.rowMain}>
        <View style={styles.rowLine}>
          <Text style={styles.rowId}>{device.label}</Text>
          {device.isNew ? <Text style={styles.badge}>NEW</Text> : null}
          {device.fieldAddition ? <Text style={styles.badgePlain}>+</Text> : null}
          {!device.pin ? <Text style={styles.badgePlain}>{device.pinElsewhere ? 'other sheet' : 'not placed'}</Text> : null}
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>
          {[device.device ?? device.category, device.status ?? 'No status yet', device.room].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <View style={styles.rowRight}>
        {device.openPunch ? <Text style={styles.rowCount}>⚑ {device.openPunch}</Text> : null}
        {device.photos ? <Text style={styles.rowCount}>📷 {device.photos}</Text> : null}
      </View>
    </Pressable>
  );
}

const LEGEND: (string | null)[] = ['Complete', 'Installed, untested', 'Issue', 'Not installed', 'No access', null];

function Legend() {
  return (
    <View style={styles.legend}>
      {LEGEND.map((s) => (
        <View key={s ?? 'none'} style={styles.legendItem}>
          <Swatch {...pinStyleFor(s)} />
          <Text style={styles.legendText}>{s ?? 'No status'}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f5f7' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#c9ccd1',
    zIndex: 2,
  },
  back: { paddingRight: 8 },
  backText: { fontSize: 18, fontWeight: '600', color: '#1565c0' },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { fontSize: 14, color: '#222' },
  chipTextOn: { color: '#fff' },
  spacer: { flex: 1 },
  status: { maxWidth: 260, fontSize: 13, color: '#555' },
  body: { flex: 1, flexDirection: 'row' },
  plan: { flex: 62, backgroundColor: '#3a3d42', overflow: 'hidden' },
  pdf: { flex: 1, backgroundColor: '#3a3d42' },
  planTools: { position: 'absolute', right: 12, bottom: 12, gap: 8, alignItems: 'flex-end' },
  tool: { backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  toolText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  side: { flex: 38, backgroundColor: '#fff', borderLeftWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  sideHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', padding: 12 },
  sideTitle: { fontSize: 16, fontWeight: '600' },
  sideNote: { fontSize: 13, color: '#666' },
  empty: { padding: 16, color: '#666' },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8' },
  rowSelected: { backgroundColor: '#e0f7fa' },
  rowMain: { flex: 1 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowId: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  rowSub: { fontSize: 12, color: '#555', marginTop: 2 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  rowCount: { fontSize: 12, color: '#444' },
  badge: { fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: '#1565c0', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  badgePlain: { fontSize: 11, color: '#555', borderWidth: 1, borderColor: '#c9ccd1', paddingHorizontal: 4, borderRadius: 3 },
  swatch: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatchGlyph: { fontSize: 10, fontWeight: '700' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendText: { fontSize: 11, color: '#444' },
  menu: {
    position: 'absolute',
    top: 4,
    left: 90,
    minWidth: 260,
    paddingVertical: 6,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c9ccd1',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  menuRight: { left: undefined, right: 12 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  menuCheck: { fontSize: 18, width: 20 },
  menuLabelBox: { flexShrink: 1 },
  menuLabel: { fontSize: 15 },
  menuNote: { fontSize: 12, color: '#666', paddingHorizontal: 14, paddingTop: 4, paddingBottom: 6, maxWidth: 280 },
  menuNoteInline: { fontSize: 11, color: '#888' },
  disabled: { color: '#aaa' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  centeredText: { color: '#fff', fontSize: 16, textAlign: 'center' },
});
