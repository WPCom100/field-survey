/**
 * Plan view (T17, Phase 3 §4.2): the level's display sheet in PDFKit with the Skia pin layer on
 * top (left ~72 %), the side lists beside it (right ~28 %, D105): Devices, Conns, Punch, Parts (T19).
 *
 * - Pins come from `device.pin` in sheet coordinates (D92), shaped by category and coloured by
 *   status (D64), clustered at low zoom; drawn on the UI thread from the viewport (D95).
 * - Tap a pin → select it and scroll its row into view; tap a cluster → zoom into it; tap a row →
 *   select it and bring its pin into view. Pinch/pan are PDFKit's; "Fit" shows the whole sheet.
 * - Filters (Category, Status, Owner, Open punch — D99) apply to all four tabs; search (FTS) and
 *   "Show deleted" are session state. Filters and layers persist per level on this iPad.
 * - A row in any tab highlights its device's pin; tapping a pin scrolls the open tab to its first row.
 * - Selecting a device (pin or row) opens its card in the side panel (T20, Phase 3 §4.3); × goes
 *   back to the lists. An edit on the card reloads the plan, so the pin follows the status at once.
 *   "Move pin" puts the plan in a mode where the next tap places the pin.
 */

import { Editor, type BlobQueue, type Store } from '@field-survey/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Pdf, { type PdfRef } from 'react-native-pdf';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';

import { movePin } from '../card/actions';
import { DeviceCard } from '../card/DeviceCard';
import type { JumpTarget } from '../card/model';
import { NOT_WIRED } from '../card/proposals';
import { PhotoFlow, type PhotoRequest } from '../photo/PhotoFlow';

import { loadLevelPlan, type LevelPlan, type PlanDevice, type PlanSheet } from './data';
import { PIN_PX } from './drawPins';
import {
  DEFAULT_LAYERS,
  EMPTY_FILTER,
  NO_STATUS,
  OWNERS,
  UNSURVEYED,
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
import {
  NO_BADGES,
  TABS,
  TAB_LABEL,
  loadLevelLists,
  rowMatches,
  searchIds,
  type Badges,
  type LevelLists,
  type ListRow,
  type Tab,
} from './lists';
import { BadgeStrip, Swatch, chipStyles } from './chips';
import { PinOverlay } from './PinOverlay';
import { pdfNativeTag, useUiViewport } from './uiViewport';
import { DEVICE_CATEGORIES, pinStyleFor, statusRank } from './pins';
import {
  apply,
  focusRect,
  inView,
  scaleOf,
  sheetRect,
  sheetRectToPage,
  sheetToView,
  viewToSheet,
  type Affine,
  type PdfViewport,
  type Point,
  type Rect,
} from './viewport';

const HIT_PX = PIN_PX; // tap radius, screen points
/** Zoom used to bring a single pin into view: past the cluster cut-off, so it stands alone. */
const REVEAL_ZOOM = LAYOUT_DEFAULTS.offZoom * 1.25; // 2.5: neighbours a couple of feet apart stand clear
/**
 * Deepest zoom as a multiple of the patch's fit (view width / page width): the 06M composite fits at
 * ~0.2 view pt per sheet pt, so 32 allows ~6.4 (D107; 8 capped it at ~1.6, below REVEAL_ZOOM).
 * Must stay a constant: a `maxScale` prop change makes the patch reset the zoom to fit.
 */
const MAX_SCALE = 32;
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
  /** The user stamped on card edits; without one the card is read-only. */
  userId?: string;
  /** User id → name for the card's history. */
  names?: ReadonlyMap<string, string>;
  /** A `file://` URI for a cached blob (photo thumbnails), or null. */
  resolveBlobUri?: (sha: string, kind: 'thumb' | 'image') => string | null;
  /** Open another level's plan with this device selected (a connection's far end, T20/T22). */
  onOpenLevel?: (levelId: string, deviceId: string) => void;
  /** Device to select and open on arrival (a jump from another level). */
  initialDeviceId?: string;
  /** Where captured photo bytes go (T21); without it the card cannot take photos. */
  blobs?: Pick<BlobQueue, 'addLocal' | 'ensureLocal'> | null;
};

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const noBlob = () => null;

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

export function PlanScreen(props: PlanScreenProps) {
  const { store, levelId, resolveSheetUri, onBack, status, reloadKey, bench, userId, initialDeviceId, onOpenLevel } = props;
  const [plan, setPlan] = useState<LevelPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PlanPrefs>({ filter: EMPTY_FILTER, layers: DEFAULT_LAYERS });
  const [selectedId, setSelectedId] = useState<string | null>(initialDeviceId ?? null);
  /** The side panel shows the selected device's card instead of the lists. */
  const [cardOpen, setCardOpen] = useState(!!initialDeviceId);
  /** Bumped by every card edit: reloads the plan, the lists and the card. */
  const [edits, setEdits] = useState(0);
  /** Move-pin mode: the next tap on the plan places this device's pin (a Correction). */
  const [moving, setMoving] = useState<{ deviceId: string; reason: string } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  /** The photo flow (camera, library or an existing photo) over the whole screen. */
  const [photoReq, setPhotoReq] = useState<PhotoRequest | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [tab, setTab] = useState<Tab>('devices');
  const [lists, setLists] = useState<LevelLists | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const insets = useSafeAreaInsets();

  const matrix = useSharedValue<Affine | null>(null);
  const vpRef = useRef<PdfViewport | null>(null);
  const pdfRef = useRef<PdfRef>(null);
  const { attach: attachUi, setFromJs } = useUiViewport(matrix);
  const listRef = useRef<FlatList<PlanDevice | ListRow>>(null);

  // --- data and stored prefs
  useEffect(() => {
    let active = true;
    (async () => {
      const p = await loadLevelPlan(store, levelId, { includeDeleted: showDeleted });
      if (!active) return;
      console.log(`[plan] loaded ${p?.devices.length ?? 'no'} devices, sheet ${p?.sheet ? 'yes' : 'no'}`);
      if (!p) return setError('This level is not on this iPad.');
      const l = await loadLevelLists(store, p.level.projectId, levelId, p.level.code, p.devices, { includeDeleted: showDeleted });
      if (!active) return;
      setPlan(p);
      setLists(l);
    })().catch((e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [store, levelId, reloadKey, showDeleted, edits]);

  const projectId = plan?.level.projectId ?? null;
  const editor = useMemo(
    () => (projectId && userId ? new Editor(store, { projectId, userId }) : null),
    [store, projectId, userId],
  );
  const onEdited = useCallback(() => setEdits((n) => n + 1), []);

  // Search: FTS over device / punch / part text plus a text match on connections; debounced.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      searchIds(store, levelId, query, lists?.connections ?? []).then(
        (ids) => active && setHits(ids),
        (e: unknown) => console.warn('[plan] search failed', e),
      );
    }, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [store, levelId, query, lists]);

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
  const visible = useMemo(
    () => (plan ? plan.devices.filter((d) => matchesFilter(d, prefs.filter) && (!hits || hits.has(d.id))) : []),
    [plan, prefs.filter, hits],
  );
  const rowsByTab = useMemo(() => {
    const keep = (rows: ListRow[]) => rows.filter((r) => rowMatches(r, prefs.filter) && (!hits || hits.has(r.id)));
    return {
      connections: keep(lists?.connections ?? []),
      punch: keep(lists?.punch ?? []),
      parts: keep(lists?.parts ?? []),
    };
  }, [lists, prefs.filter, hits]);
  const tabData: (PlanDevice | ListRow)[] = tab === 'devices' ? visible : rowsByTab[tab];
  /** First row of each device in the open tab: where a pin tap scrolls to. */
  const firstRowOf = useMemo(() => {
    const m = new Map<string, number>();
    tabData.forEach((r, i) => {
      const dev = 'tab' in r ? r.deviceId : r.id;
      if (dev && !m.has(dev)) m.set(dev, i);
    });
    return m;
  }, [tabData]);
  const placed = useMemo(() => visible.filter((d) => d.pin), [visible]);
  const renderPins = useMemo(() => placed.map(toRenderPin), [placed]);
  const categories = useMemo(() => {
    const extra = new Set((plan?.devices ?? []).map((d) => d.category).filter((c): c is string => !!c));
    return [...DEVICE_CATEGORIES, ...[...extra].filter((c) => !(DEVICE_CATEGORIES as readonly string[]).includes(c)).sort()];
  }, [plan]);

  const deviceById = useMemo(() => new Map((plan?.devices ?? []).map((d) => [d.id, d])), [plan]);
  // A device that is gone (deleted away, level reloaded) cannot stay selected, unless its card is
  // open: the card then shows it deleted, with Restore.
  useEffect(() => {
    if (selectedId && plan && !cardOpen && !deviceById.has(selectedId)) setSelectedId(null);
  }, [deviceById, plan, selectedId, cardOpen]);
  /** Where a jump from another level arrives: the first viewport focuses it instead of fitting. */
  const arrivalPin = useRef<Point | null>(null);
  arrivalPin.current = initialDeviceId ? (deviceById.get(initialDeviceId)?.pin ?? null) : null;

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
      setFromJs(sheetToView(vp));
      attachUi(pdfNativeTag(pdfRef.current));
      // The first viewport is "ready" (loadComplete re-fires much later, T16); open at fit, or on
      // the device a jump from another level arrived for.
      if (first) {
        console.log(`[plan] first viewport, zoom ${scaleOf(sheetToView(vp)).toFixed(3)}`);
        const arrival = arrivalPin.current;
        focusSheetRect(arrival && size.width ? focusRect([arrival], size, REVEAL_ZOOM) : sheetRect(vp), false);
      }
    },
    [setFromJs, attachUi, focusSheetRect, size],
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
      setCardOpen(!!id);
      if (!id) return;
      if (from === 'plan') {
        const index = firstRowOf.get(id);
        if (index !== undefined) listRef.current?.scrollToIndex({ index, viewPosition: 0.4, animated: true });
      } else {
        const pin = deviceById.get(id)?.pin;
        if (pin) reveal([pin], REVEAL_ZOOM);
      }
    },
    [firstRowOf, deviceById, reveal],
  );

  const onPageSingleTap = useCallback(
    (_page: number, x: number, y: number) => {
      const vp = vpRef.current;
      setMenu(null);
      if (vp && moving && editor && plan?.sheet) {
        const at = apply(viewToSheet(vp), { x, y });
        const whole = sheetRect(vp);
        if (at.x < 0 || at.y < 0 || at.x > whole.width || at.y > whole.height) {
          setMoveError('That is off the sheet; tap on the drawing.');
          return;
        }
        const { deviceId, reason } = moving;
        movePin(editor, deviceId, { sheet: plan.sheet.id, x: at.x, y: at.y }, reason).then(
          () => {
            setMoving(null);
            setMoveError(null);
            onEdited();
          },
          (e: unknown) => setMoveError(`Not moved: ${String((e as Error)?.message ?? e)}`),
        );
        return;
      }
      if (!vp || !prefs.layers.pins) return;
      const layout = layoutPins(renderPins, sheetToView(vp), size.width, size.height);
      const hit = hitTest(layout, x, y, HIT_PX);
      if (!hit) {
        setSelectedId(null);
        setCardOpen(false);
      } else if (hit.kind === 'pin') {
        select(renderPins[hit.index]!.id, 'plan');
      } else {
        const points = hit.members.map((i) => renderPins[i]!);
        focusSheetRect(focusRect(points, size, REVEAL_ZOOM), true);
      }
    },
    [renderPins, size, prefs.layers.pins, select, focusSheetRect, moving, editor, plan, onEdited],
  );

  /** A connection's far end: on this level select it; on another, open that level's plan. */
  const onJump = useCallback(
    (t: JumpTarget) => {
      if (t.sameLevel) select(t.deviceId, 'list');
      else onOpenLevel?.(t.levelId, t.deviceId);
    },
    [select, onOpenLevel],
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
      <View style={[styles.bar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} style={styles.back} hitSlop={8}>
          <Text style={styles.backText}>◀ {plan?.level.code ?? '…'}</Text>
        </Pressable>
        <BarButton label="Category" count={prefs.filter.categories.length} open={menu === 'category'} onPress={() => setMenu(menu === 'category' ? null : 'category')} />
        <BarButton label="Status" count={prefs.filter.statuses.length} open={menu === 'status'} onPress={() => setMenu(menu === 'status' ? null : 'status')} />
        <BarButton label="Owner" count={prefs.filter.owners.length} open={menu === 'owner'} onPress={() => setMenu(menu === 'owner' ? null : 'owner')} />
        <Pressable style={[styles.chip, prefs.filter.openPunch && styles.chipOn]} onPress={() => {
            setMenu(null);
            setFilter((f) => ({ ...f, openPunch: !f.openPunch }));
          }}>
          <Text style={[styles.chipText, prefs.filter.openPunch && styles.chipTextOn]}>{prefs.filter.openPunch ? '☑' : '☐'} Open punch</Text>
        </Pressable>
        {filtering ? (
          <Pressable
            style={styles.chip}
            onPress={() => {
              setMenu(null);
              setFilter(() => EMPTY_FILTER);
            }}>
            <Text style={styles.chipText}>Clear</Text>
          </Pressable>
        ) : null}
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
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
                maxScale={MAX_SCALE}
                spacing={0}
                enableAnnotationRendering={false}
                enableTextSelection={false}
                onViewportChanged={onViewportChanged}
                onPageSingleTap={onPageSingleTap}
                onLoadComplete={(pages, _path, sz) => console.log(`[plan] pdf loaded: ${pages} page(s), ${Math.round(sz.width)}×${Math.round(sz.height)}`)}
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
              {moving ? (
                <View style={styles.moveBanner}>
                  <Text style={styles.moveText}>
                    Tap the new position of {deviceById.get(moving.deviceId)?.label ?? 'the device'}.{moveError ? ` ${moveError}` : ''}
                  </Text>
                  <Pressable
                    onPress={() => {
                      setMoving(null);
                      setMoveError(null);
                    }}
                    hitSlop={8}>
                    <Text style={styles.moveCancel}>Cancel</Text>
                  </Pressable>
                </View>
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

        {/* side lists */}
        <View style={styles.side}>
          {cardOpen && selectedId ? (
            <DeviceCard
              key={selectedId}
              store={store}
              editor={editor}
              deviceId={selectedId}
              badges={lists?.deviceBadges.get(selectedId) ?? NO_BADGES}
              reloadKey={`${String(reloadKey)}|${edits}`}
              names={props.names ?? NO_NAMES}
              resolveBlobUri={props.resolveBlobUri ?? noBlob}
              decider={NOT_WIRED}
              canMovePin={!!deviceById.get(selectedId)?.pin}
              canOpenLevels={!!onOpenLevel}
              onEdited={onEdited}
              onClose={() => setCardOpen(false)}
              onJump={onJump}
              onStartMove={(reason) => {
                setMoveError(null);
                setMoving({ deviceId: selectedId, reason });
              }}
              onPhoto={
                props.blobs && plan
                  ? (source) =>
                      setPhotoReq({
                        kind: source,
                        title: deviceById.get(selectedId)?.label ?? 'Device',
                        target: { projectId: plan.level.projectId, levelId, deviceId: selectedId },
                      })
                  : undefined
              }
              onOpenPhoto={props.blobs ? (photoId) => setPhotoReq({ kind: 'open', photoId, title: deviceById.get(selectedId)?.label ?? 'Photo' }) : undefined}
            />
          ) : null}
          {/* The lists stay mounted under an open card, so their scroll position survives. */}
          <View style={[styles.lists, cardOpen && selectedId ? styles.hidden : null]}>
          <View style={styles.tabs}>
            {TABS.map((t) => {
              const n = t === 'devices' ? visible.length : rowsByTab[t].length;
              return (
                <Pressable key={t} style={[styles.tabBtn, tab === t && styles.tabBtnOn]} onPress={() => setTab(t)}>
                  <Text style={[styles.tabText, tab === t && styles.tabTextOn]} numberOfLines={1}>
                    {TAB_LABEL[t]} {n}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.sideHead}>
            <Text style={styles.sideNote} numberOfLines={1}>
              {filtering || hits ? 'Filtered' : 'All'} · {tabData.length}
              {tab === 'devices' && plan ? ` of ${plan.devices.length}` : ''}
              {tab === 'devices' && unplaced > 0 ? ` · ${unplaced} not on the plan` : ''}
            </Text>
            <Pressable onPress={() => setShowDeleted((v) => !v)} hitSlop={8}>
              <Text style={styles.sideNote}>{showDeleted ? '☑' : '☐'} Deleted</Text>
            </Pressable>
          </View>
          <FlatList
            ref={listRef}
            data={tabData}
            extraData={selectedId}
            keyExtractor={(r) => r.id}
            getItemLayout={(_d, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
            onScrollToIndexFailed={() => {}}
            initialNumToRender={20}
            windowSize={9}
            maxToRenderPerBatch={20}
            removeClippedSubviews
            renderItem={({ item }) =>
              'tab' in item ? (
                <ListRowView
                  row={item}
                  selected={!!item.deviceId && item.deviceId === selectedId}
                  onPress={() => item.deviceId && select(item.deviceId === selectedId ? null : item.deviceId, 'list')}
                />
              ) : (
                <DeviceRow
                  device={item}
                  badges={lists?.deviceBadges.get(item.id) ?? NO_BADGES}
                  selected={item.id === selectedId}
                  onPress={() => select(item.id === selectedId ? null : item.id, 'list')}
                />
              )
            }
            ListEmptyComponent={
              plan ? (
                <Text style={styles.empty}>
                  {filtering || hits ? 'Nothing matches the filters or search.' : `No ${TAB_LABEL[tab].toLowerCase()} on this level.`}
                </Text>
              ) : null
            }
          />
          <Legend />
          </View>
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
                      label={s === NO_STATUS ? UNSURVEYED : s}
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
      {props.blobs ? (
        <PhotoFlow
          request={photoReq}
          env={{ store, editor, queue: props.blobs }}
          onClose={(saved) => {
            setPhotoReq(null);
            if (saved) onEdited();
          }}
        />
      ) : null}
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

function ListRowView({ row, selected, onPress }: { row: ListRow; selected: boolean; onPress: () => void }) {
  const st = pinStyleFor(row.tab === 'connections' ? row.endStatus : row.deviceStatus);
  return (
    <Pressable style={[styles.row, selected && styles.rowSelected, row.badges.deleted && styles.rowDeleted]} onPress={onPress}>
      {row.tab === 'connections' ? <Swatch {...st} /> : <Text style={styles.rowNum}>{row.label}</Text>}
      <View style={styles.rowMain}>
        <View style={styles.rowLine}>
          {row.tab === 'connections' ? <Text style={styles.rowId}>{row.label}</Text> : null}
          <BadgeStrip b={row.badges} />
        </View>
        <Text style={styles.rowTitle} numberOfLines={1}>{row.title}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{row.sub}</Text>
      </View>
    </Pressable>
  );
}

function DeviceRow({ device, badges, selected, onPress }: { device: PlanDevice; badges: Badges; selected: boolean; onPress: () => void }) {
  const st = pinStyleFor(device.status);
  return (
    <Pressable style={[styles.row, selected && styles.rowSelected, device.deleted && styles.rowDeleted]} onPress={onPress}>
      <Swatch {...st} />
      <View style={styles.rowMain}>
        <View style={styles.rowLine}>
          <Text style={styles.rowId}>{device.label}</Text>
          <BadgeStrip b={badges} />
          {device.fieldAddition ? <Text style={chipStyles.badgePlain}>+</Text> : null}
          {!device.pin ? <Text style={chipStyles.badgePlain}>{device.pinElsewhere ? 'other sheet' : 'not placed'}</Text> : null}
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>
          {[device.device ?? device.category, device.status ?? UNSURVEYED, device.room].filter(Boolean).join(' · ')}
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
          <Text style={styles.legendText}>{s ?? UNSURVEYED}</Text>
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
  plan: { flex: 72, backgroundColor: '#3a3d42', overflow: 'hidden' },
  pdf: { flex: 1, backgroundColor: '#3a3d42' },
  planTools: { position: 'absolute', right: 12, bottom: 12, gap: 8, alignItems: 'flex-end' },
  tool: { backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  toolText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  lists: { flex: 1 },
  hidden: { display: 'none' },
  moveBanner: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,248,225,0.96)',
  },
  moveText: { flex: 1, fontSize: 15, color: '#333' },
  moveCancel: { fontSize: 15, fontWeight: '700', color: '#1565c0' },
  side: { flex: 28, backgroundColor: '#fff', borderLeftWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  sideHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
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
  rowDeleted: { opacity: 0.55 },
  rowNum: { width: 40, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rowTitle: { fontSize: 13, color: '#222', marginTop: 1 },
  search: { minWidth: 150, flexShrink: 1, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  tabBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnOn: { borderColor: '#1565c0' },
  tabText: { fontSize: 13, color: '#555', fontWeight: '600' },
  tabTextOn: { color: '#1565c0' },
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
