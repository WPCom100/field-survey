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
 * - A connection (card row or Conns tab row) opens the end editor in the same panel (T22, Phase 3
 *   §4.5); "Jump to" a far end on another level opens that level (`onOpenLevel`), where a sheet that
 *   is not downloaded leaves the list and the card usable ("plan not downloaded").
 * - A punch item or missing part (card row, or Punch / Parts tab row) opens the item editor in the
 *   same panel (T162, D254): status, Owner, Notes; ◀ goes back to where it was opened.
 * - The photo flow (T21) is a full-screen modal over all of it.
 * - Long-press on the sheet (T23, Phase 3 §4.6) opens the add-here menu: + Device (field
 *   addition, form in the side panel, a grey "+" pin marks the spot), + Note here, + Photo here,
 *   ✎ Markup. The menu opens while the finger is still down and the dot follows it; after the
 *   lift the dot can be dragged to fine-tune the spot (T70). The single tap PDFKit reports when
 *   that finger lifts is ignored.
 * - Plan ink (T24, D53): every user's layer drawn under the pins (Layers ▸ Ink); "✎ Ink" (or
 *   Markup / Note here) enters draw mode, where one finger or the Pencil draws into the user's
 *   own layer — pen with Pencil pressure, highlighter, text note; eraser, recolour and undo on
 *   anyone's strokes, saved into the owner's layer and merged by stroke id (T72, D129) —
 *   and two fingers pan and zoom the plan (T69, D129: the patched PDF view captures the single
 *   touch, `ink/touches.ts`). The layer is saved a second after the last stroke and on Done.
 * - Place devices (T46, Phase 3 §3.4): "⊕ Place" (or `initialPlacing`, from Setup → 5 Place devices
 *   and Needs review) shows the level's unplaced list in the side panel; a row is selected, then a
 *   tap on the plan (or a drag of its handle onto the plan) chooses the spot, and the confirm form
 *   places it. The types and panel tags the sheet prints propose dashed pins for unplaced items
 *   (T140: stations and sensors too; a guess by role is drawn fainter); tapping one selects it with
 *   that spot. Nothing is placed until Place ✓.
 * - A pin-position conflict (T26, Phase 3 §6) opened from Needs review (`reviewItemId`) draws
 *   side A solid at the device and side B dashed, both kept out of clusters, with Choose A /
 *   Choose B under the plan. Devices with an open review item have an amber ring (§13).
 */

import {
  EMPTY_FEATURES,
  Editor,
  drawingPosition,
  emptyStrokeList,
  labelKind,
  manualGridPreview,
  manualGridSet,
  nearestRoom,
  resolutionReason,
  makeStroke,
  roomText,
  snapLabel,
  uuidv7,
  withStroke,
  type BlobQueue,
  type EditContext,
  type GridSet,
  type GridTap,
  type ReviewItem,
  type Store,
  type StrokeList,
  type StrokePoint,
} from '@field-survey/core';
import { draftFromSelection, type RulingDraft } from '@field-survey/rules';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  type LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Pdf, { type PdfRef } from 'react-native-pdf';
import { useSharedValue } from 'react-native-reanimated';

import { movePin } from '../card/actions';
import { DeviceCard } from '../card/DeviceCard';
import { EndEditor } from '../ends/EndEditor';
import type { ItemKind } from '../items/actions';
import { ItemEditor } from '../items/ItemEditor';
import { AddDevicePanel } from '../additions/AddDevicePanel';
import { PlacePanel } from '../placement/PlacePanel';
import { loadUnplaced, tagProposals, type LevelUnplaced, type Proposal } from '../placement/model';
import { INK_COLORS, PHOTO_MARK_COLOR, photoMarkAt } from '../ink/geometry';
import { InkCapture, type InkTool } from '../ink/InkCapture';
import { createInkBus } from '../ink/touches';
import { recordStrokes } from '../ink/render';
import { loadPinConflict, type PinConflict } from '../review/model';
import { useInkLayers } from '../ink/useInkLayers';
import type { JumpTarget } from '../card/model';
import { NOT_WIRED } from '../card/proposals';
import { ruleDecider } from '../rules/engine';
import { useRulesVersion } from '../rules/useRulesVersion';
import { logTo } from '../log';
import { LIST_ENTITY } from '../rulings/model';
import type { PhotoTarget } from '../photo/model';
import { PhotoFlow, pickFromLibrary, type PhotoRequest } from '../photo/PhotoFlow';
import { Btn, Chip, Icon, RAIL_WIDTH, Rail, Sidebar, Swatch, color, font, hit, radius, shadow, space, tabular, type IconName } from '../ui';

import { loadLevelPlan, pinLabel, type LevelPlan, type PlanDevice, type PlanSheet } from './data';
import { PIN_PX } from './drawPins';
import {
  DEFAULT_LAYERS,
  EMPTY_FILTER,
  NO_STATUS,
  OWNERS,
  UNSURVEYED,
  STATUS_KEYS,
  activeFilterGroups,
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
import { BadgeStrip, chipStyles } from './chips';
import { Legend } from './Legend';
import { levelCaption } from './toolbar';
import { PinOverlay } from './PinOverlay';
import { GridPanel, type GridPanelMode } from './GridPanel';
import type { GridMark } from './drawLayers';
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
/** The tap PDFKit reports when a long-pressing finger lifts comes within this (ms). */
const LONG_PRESS_TAP_GUARD_MS = 900;
/** The placeholder pin of a device being added (never a real id). */
const NEW_PIN_ID = '__adding__';
/** The spot of an item being placed (T46), and the dashed proposals from the sheet's tags. */
const PLACE_PIN_ID = '__placing__';
const PROPOSAL_PREFIX = '__proposal__:';
/** Side B of a pin conflict (never a real id). */
const REVIEW_B_PIN_ID = '__review_b__';
/** Grid calibration edits on `sheet.grid_sets` (T45): project setup, not a survey finding. */
const GRID_EDIT: EditContext = { change_type: 'Master edit', reason: 'Grid calibration' };

/** The popover open over the plan (T177, `docs/ui-plan.md` §6): one at a time, a tap outside closes it. */
type Menu = 'filter' | 'layers' | 'legend' | null;

/** What the rail and its sidebar overlay show (T177); the route loads it (`home/useShell.ts`). */
export type PlanShell = {
  projectName: string | null;
  counts: { review?: number; lint?: number };
  /** The signed-in person: name, the line under it (this iPad), and the row's spoken label. */
  user: { name: string; sub: string; label: string };
};

export type PlanScreenProps = {
  store: Store;
  levelId: string;
  /** A `file://` or asset URI for the sheet, or null when its bytes are not on this iPad. */
  resolveSheetUri: (sheet: PlanSheet) => string | null;
  onBack: () => void;
  /** The back button's word: the screen ◀ returns to (`backLabelFor`); "Levels" by default. */
  backLabel?: string;
  /** The 72-pt rail and its sidebar overlay (T177); none on the demo plan. */
  shell?: PlanShell;
  /** Replaces the line under the level code (the demo plan's "Demo data — not synced"). */
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
  /** A pin-position review item to resolve on this plan (T26). */
  reviewItemId?: string;
  /** Called after Choose A / Choose B on that item. */
  onReviewResolved?: (itemId: string) => void;
  /** Open with the Place devices panel (T46): from Setup → 5 Place devices or Needs review. */
  initialPlacing?: boolean;
  /** Multi-select in the side lists → "Apply as ruling…" (T37): open the ruling editor with this draft. */
  onApplyAsRuling?: (projectId: string, draft: RulingDraft, source: string) => void;
};

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const noBlob = () => null;

function toRenderPin(d: PlanDevice, conflict: PinConflict | null): RenderPin {
  const st = pinStyleFor(d.status);
  // In a pin conflict the device's pin is side A (official): the losing iPad still has B (A7).
  const at = conflict?.deviceId === d.id && conflict.a ? conflict.a : d.pin!;
  return {
    id: d.id,
    x: at.x,
    y: at.y,
    category: d.category,
    role: d.role,
    fill: st.fill,
    hollow: st.hollow,
    glyph: st.glyph,
    label: pinLabel(d),
    plus: d.fieldAddition,
    isNew: d.isNew,
    photos: d.photos,
    rank: statusRank(d.status),
    review: d.inReview,
    solo: conflict?.deviceId === d.id,
  };
}

export function PlanScreen(props: PlanScreenProps) {
  const { store, levelId, resolveSheetUri, onBack, status, reloadKey, bench, userId, initialDeviceId, onOpenLevel, reviewItemId, onReviewResolved } =
    props;
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
  /** The side panel's editor over the card / lists: a connection end (T22) or a punch item / part (T162), opened from the card or a tab. */
  const [detail, setDetail] = useState<{ kind: 'end' | ItemKind; id: string; from: 'card' | 'list' } | null>(null);
  const endView = detail?.kind === 'end' ? { endId: detail.id, from: detail.from } : null;
  /** The punch item / part editor (T162), opened from the card or from the Punch / Parts tab. */
  const itemView = detail && detail.kind !== 'end' ? { kind: detail.kind, id: detail.id, from: detail.from } : null;
  /** "Download plan" for a sheet that is not on this iPad: null, busy, or the failure. */
  const [sheetFetch, setSheetFetch] = useState<'busy' | string | null>(null);
  const [sheetTick, setSheetTick] = useState(0);
  /** The long-press menu: where (view points for the menu, sheet points for what is added). */
  const [press, setPress] = useState<{ view: Point; sheet: Point; deviceId: string | null } | null>(null);
  const lastLongPress = useRef(0);
  /** The long-pressing finger is still down: the dot follows it and a viewport change is not a pan. */
  const pressHolding = useRef(false);
  const pressOpen = useRef(false);
  const pressMoves = useRef(0);
  pressOpen.current = !!press;
  /** "+ Device": the form in the side panel and the grey pin at the spot. */
  const [adding, setAdding] = useState<{ at: Point; category: string | null } | null>(null);
  /** Place devices (T46): the panel is open; the selected row; its spot on the sheet; a drag in plan-view points. */
  const [placing, setPlacing] = useState(!!props.initialPlacing);
  const [unplaced, setUnplaced] = useState<LevelUnplaced | null>(null);
  const [placeKey, setPlaceKey] = useState<string | null>(null);
  const [placeSpot, setPlaceSpot] = useState<Point | null>(null);
  const [dragAt, setDragAt] = useState<Point | null>(null);
  const planBox = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const planRef = useRef<View>(null);
  /** The Grid panel (T45) in the side panel, with its test / three-tap calibration modes. */
  const [gridOpen, setGridOpen] = useState(false);
  const [gridMode, setGridMode] = useState<GridPanelMode>('idle');
  const [gridTaps, setGridTaps] = useState<GridTap[]>([]);
  const [gridPending, setGridPending] = useState<{ x: number; y: number; suggestion: string | null } | null>(null);
  const [gridTest, setGridTest] = useState<{ text: string | null } | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  /** Draw mode (T24) and its tool settings; `noteAt` = a text note waiting for its words. */
  const [drawing, setDrawing] = useState(false);
  /** Draw-mode touches from the Pdf view (T69). */
  const inkBus = useMemo(createInkBus, []);
  const [inkTool, setInkTool] = useState<InkTool>('pen');
  const [inkColor, setInkColor] = useState<string>(INK_COLORS[0]);
  const [inkWidth, setInkWidth] = useState(3);
  const [noteAt, setNoteAt] = useState<{ at: StrokePoint; size: number } | null>(null);
  const [noteText, setNoteText] = useState('');
  /** "Photo here" away from a pin: the camera mark added to the ink layer once the photo is saved. */
  const photoMark = useRef<{ at: Point; size: number } | null>(null);
  /** The library picker waiting for the photo modal to finish closing (iOS presents one at a time). */
  const afterDismiss = useRef<(() => void) | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  /** The rail's top button: the full sidebar over the screen (T177). */
  const [navOpen, setNavOpen] = useState(false);
  /** Where the Filter button sits in the toolbar, for its popover. */
  const [filterX, setFilterX] = useState(0);
  const win = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('devices');
  const [lists, setLists] = useState<LevelLists | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  /** Multi-select in the side lists (T37): the chosen record ids, or null when not selecting. */
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => setPicked(null), [tab, levelId]);
  const [size, setSize] = useState({ width: 0, height: 0 });

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

  // --- a pin conflict to resolve here (T26)
  const [pinConflict, setPinConflict] = useState<PinConflict | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const names = props.names ?? NO_NAMES;
  useEffect(() => {
    if (!reviewItemId || !plan) return setPinConflict(null);
    let active = true;
    loadPinConflict(store, reviewItemId, plan.sheet?.id ?? null, names).then(
      (c) => active && setPinConflict(c),
      (e: unknown) => active && setConflictNote(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, reviewItemId, plan, names]);

  const projectId = plan?.level.projectId ?? null;
  const editor = useMemo(
    () => (projectId && userId ? new Editor(store, { projectId, userId }) : null),
    [store, projectId, userId],
  );
  const onEdited = useCallback(() => setEdits((n) => n + 1), []);

  // --- Place devices (T46): the level's unplaced list while the panel is open
  useEffect(() => {
    if (!placing || !projectId) return setUnplaced(null);
    let active = true;
    loadUnplaced(store, projectId, levelId).then(
      (u) => {
        if (!active) return;
        setUnplaced(u);
        console.log(`[plan] place: ${u?.items.length ?? 0} unplaced, ${u?.flagged.length ?? 0} flagged`);
      },
      (e: unknown) => console.warn('[plan] unplaced list not loaded', e),
    );
    return () => {
      active = false;
    };
  }, [store, projectId, levelId, placing, edits, reloadKey]);
  const startPlacing = useCallback(() => {
    setPlacing(true);
    setGridOpen(false);
    setCardOpen(false);
    setDetail(null);
    setAdding(null);
    setMoving(null);
    setPress(null);
  }, []);
  const stopPlacing = useCallback(() => {
    setPlacing(false);
    setPlaceKey(null);
    setPlaceSpot(null);
    setDragAt(null);
  }, []);
  // Accept / Edit / Reject of rule drafts on the card (T33); read-only without an editor.
  const decider = useMemo(() => (editor ? ruleDecider(store, editor.projectId, editor.userId) : NOT_WIRED), [store, editor]);
  // The rule engine wrote or decided proposal rows: the card reloads its drafts.
  const rulesVersion = useRulesVersion();

  /**
   * Choose A / Choose B on the pin conflict: confirmed with the auto-filled reason (D123), one
   * Reconcile group (T15), then back to the review list.
   */
  const resolvePin = useCallback(
    async (choice: 'A' | 'B') => {
      if (!editor || !pinConflict) return;
      const itemId = pinConflict.itemId;
      const userName = (id: string) => names.get(id);
      const item = await store.get<ReviewItem>('review_item', itemId);
      if (!item) return;
      const reason = await resolutionReason(store, item, { choice }, { userName });
      Alert.alert(`Choose ${choice}`, `Reason (auto-filled):\n${reason}`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Resolve',
          onPress: () =>
            editor.resolve(itemId, { choice }, { userName }).then(
              () => {
                console.log(`[plan] pin conflict ${itemId} resolved: ${choice}`);
                setPinConflict(null);
                setConflictNote(null);
                onEdited();
                onReviewResolved?.(itemId);
              },
              (e: unknown) => setConflictNote(`Not resolved: ${String((e as Error)?.message ?? e)}`),
            ),
        },
      ]);
    },
    [store, editor, pinConflict, names, onEdited, onReviewResolved],
  );

  /** System photo picker (T21 fix): opened with no modal up, then the photo sheet on the pick. */
  const openLibrary = useCallback((target: PhotoTarget, title: string) => {
    setLibraryError(null);
    pickFromLibrary().then(
      (uri) => uri && setPhotoReq({ kind: 'picked', uri, target, title }),
      (e: unknown) => setLibraryError(`The photo library could not be opened: ${String((e as Error)?.message ?? e)}`),
    );
  }, []);
  /** From the camera's Library button: close the camera, then open the picker once it is gone. */
  const switchToLibrary = useCallback(
    (target: PhotoTarget, title: string) => {
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        afterDismiss.current = null;
        openLibrary(target, title);
      };
      afterDismiss.current = go;
      setTimeout(go, 1200); // in case onDismiss never comes
      setPhotoReq(null);
    },
    [openLibrary],
  );

  // --- plan ink (T24): all layers of the display sheet, the user's own editable
  const ink = useInkLayers({
    store,
    editor,
    sheetId: plan?.sheet?.id ?? null,
    userId: userId ?? null,
    queue: props.blobs ?? null,
    reloadKey,
  });
  const canInk = !!editor && !!props.blobs && !!plan?.sheet;

  // Search: FTS over device / punch / part text plus a text match on the rows' shown text
  // (connections; punch and parts by their device's ID and Device text, T163); debounced.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      searchIds(store, levelId, query, lists ? [...lists.connections, ...lists.punch, ...lists.parts] : []).then(
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
  /** Dashed pins where the sheet prints an unplaced item's type or tag (T46, T140); every pinned device's spot counts as taken. */
  const proposals = useMemo((): Proposal[] => {
    if (!placing || !unplaced || !plan?.sheet) return [];
    const pins = plan.devices.filter((d) => d.pin).map((d) => d.pin!);
    return tagProposals(plan.sheet.features, unplaced.items, pins, unplaced.types);
  }, [placing, unplaced, plan]);
  /** The printed tag behind the chosen spot when it is a guess by role (D234 (3)). */
  const spotGuess = useMemo(() => {
    if (!placeKey || !placeSpot) return null;
    return proposals.find((p) => p.guess && p.itemKey === placeKey && p.at.x === placeSpot.x && p.at.y === placeSpot.y)?.tag ?? null;
  }, [proposals, placeKey, placeSpot]);
  const renderPins = useMemo(() => {
    const pins = placed.map((d) => toRenderPin(d, pinConflict));
    const conflictDevice = pinConflict ? (plan?.devices.find((d) => d.id === pinConflict.deviceId) ?? null) : null;
    if (pinConflict?.b && conflictDevice) {
      const st = pinStyleFor(conflictDevice.status);
      pins.push({
        id: REVIEW_B_PIN_ID,
        x: pinConflict.b.x,
        y: pinConflict.b.y,
        category: conflictDevice.category,
        fill: st.fill,
        hollow: false,
        glyph: 'B',
        label: 'B',
        plus: false,
        isNew: false,
        photos: 0,
        rank: 98,
        ghost: true,
        solo: true,
      });
    }
    if (placing && unplaced) {
      const st = pinStyleFor(null);
      const itemOf = new Map(unplaced.items.map((i) => [i.key, i]));
      for (const p of proposals) {
        const item = itemOf.get(p.itemKey);
        if (!item || (placeKey === p.itemKey && placeSpot && placeSpot.x === p.at.x && placeSpot.y === p.at.y)) continue;
        pins.push({ id: `${PROPOSAL_PREFIX}${p.key}`, x: p.at.x, y: p.at.y, category: item.category, role: item.role, fill: st.fill, hollow: false, glyph: '?', label: p.guess ? `${item.title}? guess` : `${item.title}?`, plus: false, isNew: true, photos: 0, rank: p.guess ? 96 : 97, ghost: true, faint: p.guess, solo: true });
      }
      const sel = placeKey ? itemOf.get(placeKey) : undefined;
      if (placeSpot && sel) {
        pins.push({ id: PLACE_PIN_ID, x: placeSpot.x, y: placeSpot.y, category: sel.category, role: sel.role, fill: st.fill, hollow: false, glyph: '+', label: sel.title, plus: true, isNew: true, photos: 0, rank: 99, solo: true });
      }
    }
    if (adding) {
      const st = pinStyleFor(null);
      pins.push({
        id: NEW_PIN_ID,
        x: adding.at.x,
        y: adding.at.y,
        category: adding.category,
        fill: st.fill,
        hollow: false,
        glyph: '+',
        label: adding.category ?? 'New device',
        plus: true,
        isNew: true,
        photos: 0,
        rank: 99,
      });
    }
    return pins;
  }, [placed, adding, plan, pinConflict, placing, unplaced, proposals, placeKey, placeSpot]);
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
  /** A pin conflict arrives showing both of its pins. */
  const arrivalPoints = useRef<Point[]>([]);
  const conflictPoints = [pinConflict?.a, pinConflict?.b].filter((p): p is Point => !!p);
  arrivalPoints.current = conflictPoints.length ? conflictPoints : arrivalPin.current ? [arrivalPin.current] : [];

  // `sheetTick` re-reads the cache after "Download plan".
  const sheetUri = useMemo(() => (plan?.sheet ? resolveSheetUri(plan.sheet) : null), [plan, resolveSheetUri, sheetTick]);
  // When the viewer was handed the sheet, for the load time in the plan log (T141).
  const sheetOpenedAt = useRef(0);
  useEffect(() => {
    if (sheetUri) sheetOpenedAt.current = Date.now();
  }, [sheetUri]);
  const downloadSheet = useCallback(() => {
    const blob = plan?.sheet?.blob;
    if (!blob || !props.blobs) return;
    setSheetFetch('busy');
    props.blobs.ensureLocal(blob, 'sheet').then(
      (path) => {
        setSheetFetch(path ? null : 'Not downloaded: no connection to the server (or the sheet is not uploaded yet).');
        setSheetTick((n) => n + 1);
      },
      (e: unknown) => setSheetFetch(`Not downloaded: ${String(e)}`),
    );
  }, [plan, props.blobs]);

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
      // panning or zooming the plan closes the add-here menu (iPad retest X-5)
      if (pressOpen.current && !pressHolding.current && Date.now() - lastLongPress.current > 300) setPress(null);
      setFromJs(sheetToView(vp));
      attachUi(pdfNativeTag(pdfRef.current));
      // The first viewport is "ready" (loadComplete re-fires much later, T16); open at fit, or on
      // the device a jump from another level arrived for.
      if (first) {
        console.log(`[plan] first viewport, zoom ${scaleOf(sheetToView(vp)).toFixed(3)}`);
        const arrival = arrivalPoints.current;
        focusSheetRect(arrival.length && size.width ? focusRect(arrival, size, REVEAL_ZOOM) : sheetRect(vp), false);
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
      setDetail(null);
      setAdding(null);
      if (id) setGridOpen(false);
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
      if (Date.now() - lastLongPress.current < LONG_PRESS_TAP_GUARD_MS) return; // the long press's own lift
      if (press) return setPress(null);
      // Place devices (T46): a dashed proposal selects its item and spot; with an item selected a tap is its spot.
      if (vp && placing && plan?.sheet) {
        const at = apply(viewToSheet(vp), { x, y });
        const hit = prefs.layers.pins ? hitTest(layoutPins(renderPins, sheetToView(vp), size.width, size.height), x, y, HIT_PX) : null;
        const id = hit?.kind === 'pin' ? renderPins[hit.index]!.id : null;
        const proposal = id?.startsWith(PROPOSAL_PREFIX) ? proposals.find((p) => `${PROPOSAL_PREFIX}${p.key}` === id) : undefined;
        if (proposal) {
          setPlaceKey(proposal.itemKey);
          setPlaceSpot(proposal.at);
          return;
        }
        const whole = sheetRect(vp);
        if (placeKey && at.x >= 0 && at.y >= 0 && at.x <= whole.width && at.y <= whole.height) setPlaceSpot(at);
        return;
      }
      // Grid panel (T45): a test tap reads its Drawing Position; a calibration tap waits for its label.
      if (vp && gridOpen && gridMode !== 'idle' && plan?.sheet) {
        const at = apply(viewToSheet(vp), { x, y });
        if (gridMode === 'test') {
          const text = drawingPosition(plan.sheet.gridSets, at);
          console.log(`[plan] grid test at ${Math.round(at.x)},${Math.round(at.y)} → ${text ?? 'off every grid'}`);
          setGridTest({ text });
        } else if (!gridPending) {
          setGridPending({ x: at.x, y: at.y, suggestion: snapLabel(plan.sheet.gridSets, plan.sheet.features, at) });
        }
        return;
      }
      if (vp && moving && editor && plan?.sheet) {
        const at = apply(viewToSheet(vp), { x, y });
        const whole = sheetRect(vp);
        if (at.x < 0 || at.y < 0 || at.x > whole.width || at.y > whole.height) {
          setMoveError('That is off the sheet; tap on the drawing.');
          return;
        }
        const { deviceId, reason } = moving;
        // Drawing Position follows the pin unless someone typed their own (T45, PLAN §7.4)
        const sets = plan.sheet.gridSets;
        const dev = deviceById.get(deviceId);
        const next = drawingPosition(sets, at);
        const prior = dev?.pin ? drawingPosition(sets, dev.pin) : null;
        const typed = !!dev?.drawingPosition && dev.drawingPosition !== prior;
        const position = !typed && next !== null && next !== (dev?.drawingPosition ?? null) ? next : undefined;
        movePin(editor, deviceId, { sheet: plan.sheet.id, x: at.x, y: at.y }, reason, position).then(
          () => {
            setMoving(null);
            setMoveError(null);
            onEdited();
          },
          (e: unknown) => setMoveError(`Not moved: ${String((e as Error)?.message ?? e)}`),
        );
        return;
      }
      if (vp && prefs.layers.ink && props.blobs && !adding) {
        const at = apply(viewToSheet(vp), { x, y });
        const pinned = prefs.layers.pins && hitTest(layoutPins(renderPins, sheetToView(vp), size.width, size.height), x, y, HIT_PX);
        const lists = [...ink.others.map((o) => o.list), ...(ink.mine ? [ink.mine] : [])];
        const photoId = pinned ? null : photoMarkAt(lists, at.x, at.y, HIT_PX / 2 / scaleOf(sheetToView(vp)));
        if (photoId) {
          setPhotoReq({ kind: 'open', photoId, title: `Level ${plan?.level.code ?? ''}` });
          return;
        }
      }
      if (!vp || !prefs.layers.pins) return;
      const layout = layoutPins(renderPins, sheetToView(vp), size.width, size.height);
      const hit = hitTest(layout, x, y, HIT_PX);
      if (!hit) {
        if (adding) return; // the form stays open; Cancel closes it
        setSelectedId(null);
        setCardOpen(false);
        setDetail(null);
      } else if (hit.kind === 'pin') {
        const id = renderPins[hit.index]!.id;
        if (id === NEW_PIN_ID) return;
        select(id === REVIEW_B_PIN_ID && pinConflict ? pinConflict.deviceId : id, 'plan');
      } else {
        const points = hit.members.map((i) => renderPins[i]!);
        focusSheetRect(focusRect(points, size, REVEAL_ZOOM), true);
      }
    },
    [renderPins, size, prefs.layers.pins, prefs.layers.ink, select, focusSheetRect, moving, editor, plan, onEdited, press, adding, ink.others, ink.mine, props.blobs, pinConflict, gridOpen, gridMode, gridPending, deviceById, placing, proposals, placeKey],
  );

  /** Where a long press is, as the menu needs it; null off the sheet. */
  const pressAt = useCallback(
    (x: number, y: number): { view: Point; sheet: Point; deviceId: string | null } | null => {
      const vp = vpRef.current;
      if (!vp) return null;
      const at = apply(viewToSheet(vp), { x, y });
      const whole = sheetRect(vp);
      if (at.x < 0 || at.y < 0 || at.x > whole.width || at.y > whole.height) return null;
      let deviceId: string | null = null;
      if (prefs.layers.pins) {
        const hit = hitTest(layoutPins(renderPins, sheetToView(vp), size.width, size.height), x, y, HIT_PX);
        const id = hit?.kind === 'pin' ? renderPins[hit.index]!.id : null;
        if (id === REVIEW_B_PIN_ID) deviceId = pinConflict?.deviceId ?? null;
        else if (id && id !== NEW_PIN_ID) deviceId = id;
      }
      return { view: { x, y }, sheet: at, deviceId };
    },
    [prefs.layers.pins, renderPins, size, pinConflict],
  );

  /**
   * Long-press on the sheet (T23): the add-here menu shows at once, the dot follows the finger while
   * it is still down (adjusting the spot), and lifting leaves it there (iPad retest X-4).
   */
  const onPageLongPress = useCallback(
    (_page: number, x: number, y: number) => {
      if (moving || placing || !plan?.sheet) return;
      const p = pressAt(x, y);
      if (!p) return;
      pressHolding.current = true;
      pressMoves.current = 0;
      lastLongPress.current = Date.now();
      console.log('[plan] long press: began (menu open, finger down)');
      setMenu(null);
      setPress(p);
    },
    [moving, placing, plan, pressAt],
  );
  const onPageLongPressMove = useCallback(
    (_page: number, x: number, y: number) => {
      if (!pressHolding.current) return;
      pressMoves.current++;
      const p = pressAt(x, y);
      if (p) setPress(p);
    },
    [pressAt],
  );
  const onPageLongPressEnd = useCallback(
    (_page: number, x: number, y: number) => {
      if (!pressHolding.current) return;
      pressHolding.current = false;
      lastLongPress.current = Date.now();
      // T70: the iPad round saw neither the follow nor the early menu; Metro shows which part arrives
      console.log(`[plan] long press: lifted after ${pressMoves.current} move event(s)`);
      const p = pressAt(x, y);
      if (p) setPress(p);
    },
    [pressAt],
  );
  /** T70: dragging the dot after the lift moves the spot (and the device under it) before an item is picked. */
  const onPressDrag = useCallback(
    (x: number, y: number) => {
      const p = pressAt(x, y);
      if (p) setPress(p);
    },
    [pressAt],
  );

  /** The nearest pinned device to a sheet point, for the Location of a "Photo here". */
  const nearestDevice = useCallback(
    (p: Point): PlanDevice | null => {
      let best: PlanDevice | null = null;
      let bestD = Infinity;
      for (const d of plan?.devices ?? []) {
        if (!d.pin) continue;
        const dist = Math.hypot(d.pin.x - p.x, d.pin.y - p.y);
        if (dist < bestD) {
          bestD = dist;
          best = d;
        }
      }
      return best;
    },
    [plan],
  );

  /** A connection's far end: on this level select it; on another, open that level's plan. */
  const onJump = useCallback(
    (t: JumpTarget) => {
      if (t.sameLevel) select(t.deviceId, 'list');
      else onOpenLevel?.(t.levelId, t.deviceId);
    },
    [select, onOpenLevel],
  );

  /** The selected item's handle dragged onto the plan (T46): the drop is its spot. */
  const onPlaceDrag = useCallback((pageX: number, pageY: number, end: boolean) => {
    const box = planBox.current;
    const vp = vpRef.current;
    const local = box ? { x: pageX - box.x, y: pageY - box.y } : null;
    const inside = !!local && !!box && local.x >= 0 && local.y >= 0 && local.x <= box.width && local.y <= box.height;
    if (!end) return setDragAt(inside ? local : null);
    setDragAt(null);
    if (!inside || !vp || !local) return;
    const at = apply(viewToSheet(vp), local);
    const whole = sheetRect(vp);
    if (at.x >= 0 && at.y >= 0 && at.x <= whole.width && at.y <= whole.height) setPlaceSpot(at);
  }, []);

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
    // where the plan is in the window, for a drag from the side panel (T46)
    planRef.current?.measureInWindow((x, y, w, h) => {
      planBox.current = { x, y, width: w, height: h };
    });
  };

  /** Every layer as one picture in sheet coordinates (others a little faded), drawn by the overlay. */
  const inkPicture = useMemo(() => {
    if (!prefs.layers.ink) return null;
    const lists: { list: StrokeList; alpha: number }[] = ink.others.map((o) => ({ list: o.list, alpha: 0.8 }));
    if (ink.mine) lists.push({ list: ink.mine, alpha: 1 });
    if (!lists.some((l) => l.list.strokes.length)) return null;
    const crop = vpRef.current?.cropBox;
    return recordStrokes(lists, { width: crop?.width ?? plan?.sheet?.widthPt ?? 20000, height: crop?.height ?? plan?.sheet?.heightPt ?? 20000 });
  }, [prefs.layers.ink, ink.others, ink.mine, plan]);

  /** Grid bubbles of every set, plus the calibration taps as a new set and, dashed, the bubbles
   * those taps would claim once they fix an axis (T45, T96), while the Grid panel is open. */
  const gridMarks = useMemo<GridMark[]>(() => {
    const sets = plan?.sheet?.gridSets ?? [];
    const marks: GridMark[] = sets.flatMap((gs, i) => (gs.bubbles ?? []).map((b) => ({ label: b.label, axis: b.axis, x: b.x, y: b.y, set: i })));
    for (const b of manualGridPreview(gridTaps, plan?.sheet?.features ?? EMPTY_FEATURES)) marks.push({ label: b.label, axis: b.axis, x: b.x, y: b.y, set: sets.length, preview: true });
    for (const t of gridTaps) marks.push({ label: t.label, axis: labelKind(t.label) === 'alpha' ? 'col' : 'row', x: t.x, y: t.y, set: sets.length });
    if (gridPending) marks.push({ label: '?', axis: 'col', x: gridPending.x, y: gridPending.y, set: sets.length });
    return marks;
  }, [plan, gridTaps, gridPending]);
  /** Save the sheet's grid sets as one op (project setup, not a survey finding). */
  const saveGridSets = useCallback(
    (sets: GridSet[]) => {
      if (!editor || !plan?.sheet) return;
      setGridError(null);
      editor.setField('sheet', plan.sheet.id, 'grid_sets', sets, GRID_EDIT).then(
        () => {
          console.log(`[plan] grid sets saved: ${sets.map((s) => `${s.name} (${s.mode})`).join('; ') || 'none'}`);
          setGridMode('idle');
          setGridTaps([]);
          setGridPending(null);
          onEdited();
        },
        (e: unknown) => setGridError(`Not saved: ${String((e as Error)?.message ?? e)}`),
      );
    },
    [editor, plan, onEdited],
  );
  const closeGrid = () => {
    setGridOpen(false);
    setGridMode('idle');
    setGridTaps([]);
    setGridPending(null);
    setGridTest(null);
    setGridError(null);
  };

  const zoomNow = () => (vpRef.current ? scaleOf(sheetToView(vpRef.current)) : 1);
  const emptyInk = (): StrokeList | null => {
    const crop = vpRef.current?.cropBox;
    return crop ? emptyStrokeList('sheet', crop.width, crop.height) : null;
  };
  /** Draw mode in the patched PDF view (T69): one finger / the Pencil draws, two fingers pan. */
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const setPdfInkMode = useCallback((on: boolean) => {
    try {
      pdfRef.current?.setInkMode(on);
    } catch (e) {
      console.warn('[plan] ink mode not set (dev build without T69?)', e);
    }
  }, []);
  useEffect(() => {
    setPdfInkMode(drawing);
    console.log(`[plan] ink: draw mode ${drawing ? 'on (two fingers pan)' : 'off'}`);
  }, [drawing, setPdfInkMode]);
  const startDrawing = (tool: InkTool) => {
    if (!canInk) return;
    if (!prefs.layers.ink) setLayer('ink');
    setMenu(null);
    setPress(null);
    setInkTool(tool);
    setDrawing(true);
  };
  const stopDrawing = () => {
    setDrawing(false);
    setNoteAt(null);
    setNoteText('');
    void ink.flush();
  };
  const placeNote = () => {
    const base = ink.mine ?? emptyInk();
    if (!noteAt || !noteText.trim() || !base) return;
    ink.setMine(withStroke(base, makeStroke({ id: uuidv7(), tool: 'text', color: inkColor, width: noteAt.size, points: [noteAt.at], text: noteText, at: new Date().toISOString() })));
    setNoteAt(null);
    setNoteText('');
  };

  const filtering = isFiltering(prefs.filter);
  const notOnPlan = visible.length - placed.length;
  const filterCount = activeFilterGroups(prefs.filter);
  /** The sheet is on screen: Ink, Place device and Fit / Grid act on it. */
  const sheetShown = !!plan?.sheet && !!sheetUri && !error;
  const railW = props.shell ? RAIL_WIDTH : 0;
  const toggleMenu = (m: Exclude<Menu, null>) => setMenu(menu === m ? null : m);

  return (
    <View style={styles.root}>
      {props.shell ? (
        <Rail
          section="Levels"
          projectId={projectId}
          counts={props.shell.counts}
          user={props.shell.user}
          onMenu={() => {
            setMenu(null);
            setNavOpen(true);
          }}
        />
      ) : null}

      <View style={styles.main}>
      {/* toolbar (the board): ◀ back · code and name · Search · Filter · Ink · Place device */}
      <View style={styles.bar}>
        <Pressable onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressedBg]} hitSlop={4} testID="plan.back" accessibilityRole="button">
          <Icon name="chevronLeft" size={22} color={color.primary} strokeWidth={2.2} />
          <Text style={styles.backText} numberOfLines={1}>
            {props.backLabel ?? 'Levels'}
          </Text>
        </Pressable>
        <View style={styles.barRule} />
        <View style={styles.titleBox}>
          <Text style={styles.titleCode} numberOfLines={1} testID="plan.title">
            {plan?.level.code ?? '…'}
          </Text>
          <Text style={styles.titleSub} numberOfLines={1}>
            {status ?? (plan ? levelCaption(plan.level.code, plan.devices.filter((d) => !d.deleted).length) : ' ')}
          </Text>
        </View>
        <View style={styles.search}>
          <Icon name="search" size={18} color={color.text3} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={color.text3}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
            testID="plan.search"
          />
        </View>
        <Pressable
          onLayout={(e) => setFilterX(e.nativeEvent.layout.x)}
          onPress={() => toggleMenu('filter')}
          style={({ pressed }) => [styles.tb, (filterCount > 0 || menu === 'filter') && styles.tbOn, pressed && styles.pressedBg]}
          testID="plan.filter"
          accessibilityRole="button"
          accessibilityLabel={filterCount ? `Filter, ${filterCount} active` : 'Filter'}
        >
          <Icon name="filter" size={20} color={filterCount > 0 || menu === 'filter' ? color.primary : color.text} strokeWidth={1.8} />
          <Text style={[styles.tbText, (filterCount > 0 || menu === 'filter') && styles.tbTextOn]}>Filter</Text>
          {filterCount ? (
            <View style={styles.count}>
              <Text style={styles.countText}>{filterCount}</Text>
            </View>
          ) : null}
        </Pressable>
        <View style={styles.spacer} />
        {sheetShown && canInk && !drawing ? <IconBtn icon="ink" label="Ink" onPress={() => startDrawing('pen')} testID="plan.ink" /> : null}
        {sheetShown && editor && !drawing && !placing ? (
          <Btn kind="primary" title="Place device" icon={<Icon name="plusCircle" size={20} color={color.onPrimary} />} onPress={startPlacing} testID="plan.place" />
        ) : null}
      </View>

        {/* plan */}
        <View style={styles.plan} onLayout={onLayout} ref={planRef}>
          {error ? (
            <Centered text={error} />
          ) : !plan ? (
            <Centered spinner />
          ) : !plan.sheet ? (
            <Centered text={`No plan sheet yet — level ${plan.level.code} has no display sheet. Use the list on the right; the plan appears once a sheet is assigned (setup, T45).`} />
          ) : !sheetUri ? (
            <View style={styles.centered}>
              <Text style={styles.centeredText}>
                Plan not downloaded — {plan.level.code}'s sheet is not on this iPad yet. Use the list on the right; the sheet downloads with the next sync on Wi-Fi.
              </Text>
              {props.blobs && plan.sheet.blob ? (
                <Btn kind="primary" title={sheetFetch === 'busy' ? 'Downloading…' : '⤓ Download plan now'} onPress={downloadSheet} disabled={sheetFetch === 'busy'} />
              ) : null}
              {sheetFetch && sheetFetch !== 'busy' ? <Text style={styles.centeredText}>{sheetFetch}</Text> : null}
            </View>
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
                onPageLongPress={onPageLongPress}
                onPageLongPressMove={onPageLongPressMove}
                onPageLongPressEnd={onPageLongPressEnd}
                onInkMessage={inkBus.emit}
                onLoadComplete={(pages, _path, sz) => {
                  logTo('plan', 'info', 'sheet_loaded', {
                    ms: Date.now() - sheetOpenedAt.current,
                    level: plan.level.code,
                    blob: plan.sheet?.blob?.slice(0, 8) ?? null,
                    pages,
                    size: `${Math.round(sz.width)}×${Math.round(sz.height)}`,
                  });
                  if (drawingRef.current) setPdfInkMode(true);
                }}
                onError={(e) => setError(`The sheet could not be opened: ${String((e as Error)?.message ?? e)}`)}
              />
              {size.width > 0 ? (
                <PinOverlay
                  matrix={matrix}
                  ink={inkPicture}
                  pins={renderPins}
                  selectedId={selectedId}
                  showPins={prefs.layers.pins}
                  labels={prefs.layers.labels}
                  photos={prefs.layers.photos}
                  width={size.width}
                  height={size.height}
                  boundaries={
                    prefs.layers.boundaries && plan.sheet.features.boundaries.length
                      ? { lines: plan.sheet.features.boundaries, labels: plan.sheet.features.boundary_labels }
                      : null
                  }
                  gridMarks={gridOpen ? gridMarks : null}
                  shapes={plan.shapes}
                />
              ) : null}
              {drawing ? (
                <InkCapture
                  touches={inkBus}
                  viewport={() => vpRef.current}
                  tool={inkTool}
                  color={inkColor}
                  widthPx={inkWidth}
                  mine={ink.mine}
                  onChange={ink.setMine}
                  onErase={(at, tol) => void ink.eraseAt(at.x, at.y, tol)}
                  onRecolor={(at, tol) => void ink.recolorAt(at.x, at.y, tol, inkColor)}
                  onTextAt={(at, size) => {
                    setNoteAt({ at, size });
                    setNoteText('');
                  }}
                />
              ) : null}
              {drawing ? (
                <InkBar
                  tool={inkTool}
                  color={inkColor}
                  width={inkWidth}
                  canUndo={ink.canUndo}
                  save={ink.save}
                  error={ink.error}
                  missing={ink.missing}
                  noteAt={!!noteAt}
                  noteText={noteText}
                  onTool={(t) => {
                    setInkTool(t);
                    if (t !== 'text') setNoteAt(null);
                  }}
                  onColor={setInkColor}
                  onWidth={setInkWidth}
                  onUndo={() => {
                    console.log(`[plan] ink: undo (${ink.mine?.strokes.length ?? 0} strokes before)`);
                    ink.undo();
                  }}
                  onNoteText={setNoteText}
                  onPlaceNote={placeNote}
                  onDone={stopDrawing}
                />
              ) : null}
              {press ? (
                <PressMenu
                  at={press.view}
                  size={size}
                  onDrag={onPressDrag}
                  deviceLabel={press.deviceId ? (deviceById.get(press.deviceId)?.label ?? null) : null}
                  canEdit={!!editor}
                  canPhoto={!!props.blobs}
                  canInk={canInk}
                  onNote={() => {
                    const at = press.sheet;
                    startDrawing('text');
                    setNoteAt({ at: { x: at.x, y: at.y, p: 1 }, size: 14 / zoomNow() });
                    setNoteText('');
                  }}
                  onInk={() => startDrawing('pen')}
                  onDevice={() => {
                    setPress(null);
                    setSelectedId(null);
                    setCardOpen(false);
                    setDetail(null);
                    setAdding({ at: press.sheet, category: null });
                  }}
                  onPhoto={() => {
                    setPress(null);
                    if (!plan) return;
                    const near = press.deviceId ? null : nearestDevice(press.sheet);
                    photoMark.current = press.deviceId || !canInk ? null : { at: press.sheet, size: 26 / zoomNow() };
                    setPhotoReq({
                      kind: 'camera',
                      title: press.deviceId ? (deviceById.get(press.deviceId)?.label ?? 'Device') : `Level ${plan.level.code}`,
                      target: {
                        projectId: plan.level.projectId,
                        levelId,
                        deviceId: press.deviceId,
                        location: near ? [`Near ${near.label}`, near.room].filter(Boolean).join(', ') : null,
                      },
                    });
                  }}
                  onClose={() => setPress(null)}
                />
              ) : null}
              {libraryError ? (
                <View style={styles.moveBanner}>
                  <Text style={styles.moveText}>{libraryError}</Text>
                  <Pressable onPress={() => setLibraryError(null)} hitSlop={8}>
                    <Text style={styles.moveCancel}>OK</Text>
                  </Pressable>
                </View>
              ) : null}
              {pinConflict ? (
                <View style={styles.moveBanner}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.moveText}>
                      Pin conflict on {deviceById.get(pinConflict.deviceId)?.label ?? 'this device'}
                      {!pinConflict.a || !pinConflict.b ? ' (one position is on another sheet)' : ''}
                    </Text>
                    <Text style={styles.conflictSides}>
                      {pinConflict.aLabel} · {pinConflict.bLabel}
                    </Text>
                    {conflictNote ? <Text style={styles.conflictError}>{conflictNote}</Text> : null}
                  </View>
                  {(['A', 'B'] as const).map((choice) => (
                    <Btn key={choice} kind="primary" small title={`Choose ${choice}`} disabled={!editor} onPress={() => void resolvePin(choice)} />
                  ))}
                </View>
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
              {dragAt ? <View pointerEvents="none" style={[styles.dragDot, { left: dragAt.x - 14, top: dragAt.y - 14 }]} /> : null}
              {placing && !placeKey ? (
                <View style={styles.moveBanner} pointerEvents="none">
                  <Text style={styles.moveText}>Pick a device in the list on the right, then tap where it is on the plan — or tap a dashed pin.</Text>
                </View>
              ) : null}
            </>
          )}
          {/* floating tools (the board): Fit · Grid · Layers · Legend, bottom-right */}
          {plan ? (
            <View style={styles.planTools}>
              {bench && __DEV__ && sheetShown ? (
                <Pressable style={styles.bench} onPress={() => setCycles((c) => (c === null ? 0 : null))}>
                  <Text style={styles.benchText}>{cycles === null ? 'TP-6: 100 zoom cycles' : `cycle ${Math.floor(cycles / 2)}/100 — stop`}</Text>
                </Pressable>
              ) : null}
              {sheetShown ? <IconBtn icon="fit" label="Fit the sheet" onPress={fit} testID="plan.fit" /> : null}
              {sheetShown && !drawing ? (
                <IconBtn
                  icon="grid"
                  label="Grid reference"
                  on={gridOpen}
                  onPress={() => {
                    if (gridOpen) return closeGrid();
                    setGridOpen(true);
                    setCardOpen(false);
                    setDetail(null);
                    setAdding(null);
                  }}
                  testID="plan.grid"
                />
              ) : null}
              {sheetShown ? <IconBtn icon="layers" label="Layers" on={menu === 'layers'} onPress={() => toggleMenu('layers')} testID="plan.layers" /> : null}
              <IconBtn icon="legend" label="Legend" on={menu === 'legend'} onPress={() => toggleMenu('legend')} testID="plan.legend" />
            </View>
          ) : null}
        </View>
      </View>

        {/* side lists */}
        <View style={styles.side}>
          {placing && plan?.sheet && sheetUri ? (
            <PlacePanel
              store={store}
              editor={editor}
              levelId={levelId}
              levelCode={plan.level.code}
              sheetId={plan.sheet.id}
              data={unplaced}
              proposals={proposals.length}
              guesses={proposals.filter((p) => p.guess).length}
              spotGuess={spotGuess}
              selectedKey={placeKey}
              spot={placeSpot}
              defaults={
                placeSpot
                  ? {
                      drawingPosition: drawingPosition(plan.sheet.gridSets, placeSpot),
                      room: (() => {
                        const r = nearestRoom(plan.sheet.features, placeSpot);
                        return r ? roomText(r) : null;
                      })(),
                    }
                  : null
              }
              onSelect={(key) => {
                setPlaceKey(key);
                setPlaceSpot(null);
              }}
              onClearSpot={() => setPlaceSpot(null)}
              onPlaced={() => {
                setPlaceKey(null);
                setPlaceSpot(null);
                onEdited();
              }}
              onEdited={onEdited}
              onClose={stopPlacing}
              onDrag={onPlaceDrag}
            />
          ) : gridOpen && plan?.sheet ? (
            <GridPanel
              levelCode={plan.level.code}
              sets={plan.sheet.gridSets}
              canEdit={!!editor}
              mode={gridMode}
              testResult={gridTest}
              taps={gridTaps}
              pending={gridPending}
              error={gridError}
              onTest={() => {
                setGridTest(null);
                setGridMode((m) => (m === 'test' ? 'idle' : 'test'));
              }}
              onStartCalibrate={() => {
                setGridMode('calibrate');
                setGridTaps([]);
                setGridPending(null);
                setGridError(null);
              }}
              onCancelCalibrate={() => {
                setGridMode('idle');
                setGridTaps([]);
                setGridPending(null);
              }}
              onLabelPending={(label) => {
                if (!gridPending) return;
                setGridTaps((t) => [...t, { x: gridPending.x, y: gridPending.y, label }]);
                setGridPending(null);
              }}
              onDropPending={() => setGridPending(null)}
              onUndoTap={() => setGridTaps((t) => t.slice(0, -1))}
              onFinishCalibrate={(name, prefix) => {
                try {
                  const gs = manualGridSet(gridTaps, { ...(name ? { name } : {}), prefix });
                  saveGridSets([...plan.sheet!.gridSets, gs]);
                } catch (e) {
                  setGridError(String((e as Error)?.message ?? e));
                }
              }}
              onRename={(i, name, prefix) => saveGridSets(plan.sheet!.gridSets.map((s, j) => (j === i ? { ...s, name, prefix } : s)))}
              onRemove={(i) => saveGridSets(plan.sheet!.gridSets.filter((_, j) => j !== i))}
              onClose={closeGrid}
            />
          ) : adding && editor && plan?.sheet ? (
            <AddDevicePanel
              store={store}
              editor={editor}
              projectId={plan.level.projectId}
              levelId={levelId}
              levelCode={plan.level.code}
              sheetId={plan.sheet.id}
              at={adding.at}
              defaults={{
                drawingPosition: drawingPosition(plan.sheet.gridSets, adding.at),
                room: (() => {
                  const r = nearestRoom(plan.sheet.features, adding.at);
                  return r ? roomText(r) : null;
                })(),
              }}
              onCategory={(category) => setAdding((a) => (a ? { ...a, category } : a))}
              onCancel={() => setAdding(null)}
              onAdded={(deviceId) => {
                setAdding(null);
                onEdited();
                setSelectedId(deviceId);
                setCardOpen(true);
              }}
            />
          ) : endView ? (
            <EndEditor
              key={endView.endId}
              store={store}
              editor={editor}
              endId={endView.endId}
              reloadKey={`${String(reloadKey)}|${edits}`}
              names={props.names ?? NO_NAMES}
              backLabel={endView.from === 'card' && selectedId ? (deviceById.get(selectedId)?.label ?? 'Device') : 'Connections'}
              onBack={() => {
                if (endView.from === 'list') setCardOpen(false);
                setDetail(null);
              }}
              onEdited={onEdited}
              onJump={onJump}
              canOpenLevels={!!onOpenLevel}
              onPhoto={
                props.blobs && plan
                  ? (t) =>
                      setPhotoReq({
                        kind: 'camera',
                        title: t.title,
                        target: { projectId: plan.level.projectId, levelId: t.levelId ?? levelId, deviceId: t.deviceId, cableEndId: t.endId },
                      })
                  : undefined
              }
              resolveBlobUri={props.resolveBlobUri ?? noBlob}
              onOpenPhoto={props.blobs ? (photoId, title) => setPhotoReq({ kind: 'open', photoId, title }) : undefined}
            />
          ) : itemView ? (
            <ItemEditor
              key={`${itemView.kind}:${itemView.id}`}
              store={store}
              editor={editor}
              kind={itemView.kind}
              id={itemView.id}
              levelId={levelId}
              reloadKey={`${String(reloadKey)}|${edits}|${rulesVersion}`}
              names={props.names ?? NO_NAMES}
              backLabel={
                itemView.from === 'card' && selectedId ? (deviceById.get(selectedId)?.label ?? 'Device') : itemView.kind === 'punch' ? 'Punch' : 'Parts'
              }
              onBack={() => {
                if (itemView.from === 'list') setCardOpen(false);
                setDetail(null);
              }}
              onEdited={onEdited}
              onJump={onJump}
              canOpenLevels={!!onOpenLevel}
            />
          ) : cardOpen && selectedId ? (
            <DeviceCard
              key={selectedId}
              store={store}
              editor={editor}
              deviceId={selectedId}
              badges={lists?.deviceBadges.get(selectedId) ?? NO_BADGES}
              reloadKey={`${String(reloadKey)}|${edits}|${rulesVersion}`}
              names={props.names ?? NO_NAMES}
              resolveBlobUri={props.resolveBlobUri ?? noBlob}
              decider={decider}
              canMovePin={!!deviceById.get(selectedId)?.pin || !deviceById.get(selectedId)?.pinElsewhere}
              unplaced={!deviceById.get(selectedId)?.pin && !deviceById.get(selectedId)?.pinElsewhere}
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
                  ? (source) => {
                      const title = deviceById.get(selectedId)?.label ?? 'Device';
                      const target = { projectId: plan.level.projectId, levelId, deviceId: selectedId };
                      if (source === 'library') openLibrary(target, title);
                      else setPhotoReq({ kind: 'camera', title, target });
                    }
                  : undefined
              }
              onOpenPhoto={props.blobs ? (photoId) => setPhotoReq({ kind: 'open', photoId, title: deviceById.get(selectedId)?.label ?? 'Photo' }) : undefined}
              onOpenEnd={(endId) => setDetail({ kind: 'end', id: endId, from: 'card' })}
              onOpenItem={(kind, id) => setDetail({ kind, id, from: 'card' })}
            />
          ) : null}
          {/* The lists stay mounted under an open card, so their scroll position survives. */}
          <View style={[styles.lists, (placing && plan?.sheet && sheetUri) || adding || detail || gridOpen || (cardOpen && selectedId) ? styles.hidden : null]}>
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map((t) => {
              const n = t === 'devices' ? visible.length : rowsByTab[t].length;
              const on = tab === t;
              return (
                <Pressable
                  key={t}
                  style={[styles.tabBtn, on && styles.tabBtnOn]}
                  onPress={() => setTab(t)}
                  testID={`plan.tab.${t}`}
                  accessibilityRole="tab"
                  accessibilityLabel={`${TAB_LABEL[t]} ${n}`}
                >
                  <Text style={[styles.tabText, on && styles.tabTextOn]} numberOfLines={1}>
                    {TAB_LABEL[t]}
                  </Text>
                  <Text style={[styles.tabCount, on && styles.tabTextOn]} numberOfLines={1}>
                    {n}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {picked ? (
            <View style={styles.sideHead}>
              <Text style={styles.sideNote} numberOfLines={1}>
                {picked.size} chosen
              </Text>
              <SideLink label={`All ${tabData.length}`} onPress={() => setPicked(new Set(tabData.filter((r) => !('tab' in r ? r.badges.deleted : r.deleted)).map((r) => r.id)))} testID="plan.select.all" />
              <SideLink
                label="Apply as ruling…"
                disabled={!picked.size || !plan}
                onPress={() => {
                  if (!plan || !props.onApplyAsRuling) return;
                  props.onApplyAsRuling(plan.level.projectId, draftFromSelection(LIST_ENTITY[tab], [...picked], [plan.level.code]), `${TAB_LABEL[tab]} on ${plan.level.code}`);
                  setPicked(null);
                }}
                testID="plan.select.apply"
              />
              <SideLink label="Cancel" onPress={() => setPicked(null)} testID="plan.select.cancel" />
            </View>
          ) : (
            <View style={styles.sideHead}>
              <Text style={styles.sideNote} numberOfLines={1} testID="plan.side.note">
                {filtering || hits ? 'Filtered' : 'All'} · {tabData.length}
                {tab === 'devices' && plan ? ` of ${plan.devices.length}` : ''}
                {tab === 'devices' && notOnPlan > 0 ? ` · ${notOnPlan} not on the plan` : ''}
              </Text>
              {tab === 'devices' && notOnPlan > 0 && editor && sheetUri ? <SideLink label="Place ▸" onPress={startPlacing} testID="plan.devices.place" /> : null}
              {props.onApplyAsRuling && userId ? <SideLink label="Select" onPress={() => setPicked(new Set())} testID="plan.select" /> : null}
              <Chip small label="Deleted" selected={showDeleted} onPress={() => setShowDeleted((v) => !v)} testID="plan.deleted" accessibilityLabel={showDeleted ? 'Deleted, shown' : 'Deleted, hidden'} />
            </View>
          )}
          <FlatList
            ref={listRef}
            data={tabData}
            extraData={picked ?? selectedId}
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
                  selected={picked ? picked.has(item.id) : !!item.deviceId && item.deviceId === selectedId}
                  picking={!!picked}
                  onPress={() => {
                    if (picked) return setPicked(togglePick(picked, item.id));
                    if (item.tab === 'connections') {
                      // a connection opens its end editor; its device's pin is lit behind it
                      if (item.deviceId) select(item.deviceId, 'list');
                      setDetail({ kind: 'end', id: item.id, from: 'list' });
                    } else {
                      // a punch item or part opens its editor (T162), its device's pin lit behind it
                      if (item.deviceId) select(item.deviceId, 'list');
                      setDetail({ kind: item.tab === 'punch' ? 'punch' : 'part', id: item.id, from: 'list' });
                    }
                  }}
                />
              ) : (
                <DeviceRow
                  device={item}
                  badges={lists?.deviceBadges.get(item.id) ?? NO_BADGES}
                  selected={picked ? picked.has(item.id) : item.id === selectedId}
                  picking={!!picked}
                  onPress={() => (picked ? setPicked(togglePick(picked, item.id)) : select(item.id, 'list'))}
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
          </View>
        </View>

      {/* popovers (docs/ui-plan.md §6): a surface card anchored to its button, closed by a tap outside */}
      {menu ? (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} testID="plan.menu.scrim" accessibilityLabel="Close" />
          {menu === 'filter' ? (
            <View style={[styles.popover, { top: BAR_H + 4, left: Math.max(8, Math.min(railW + filterX, win.width - FILTER_W - 8)), width: FILTER_W, maxHeight: win.height - BAR_H - 120 }]} testID="plan.filter.card">
              <ScrollView contentContainerStyle={styles.popoverBody} keyboardShouldPersistTaps="handled">
                <FilterGroup title="Category" testID="plan.filter.category">
                  {categories.map((c) => (
                    <Chip key={c} small label={c} selected={prefs.filter.categories.includes(c)} onPress={() => setFilter((f) => ({ ...f, categories: toggle(f.categories, c, categories) }))} testID={`plan.filter.category.${c}`} />
                  ))}
                </FilterGroup>
                <FilterGroup title="Status" testID="plan.filter.status">
                  {STATUS_KEYS.map((s) => (
                    <Chip
                      key={s}
                      small
                      label={s === NO_STATUS ? UNSURVEYED : s}
                      icon={<Swatch {...pinStyleFor(s === NO_STATUS ? null : s)} size={18} />}
                      selected={prefs.filter.statuses.includes(s)}
                      onPress={() => setFilter((f) => ({ ...f, statuses: toggle<StatusKey>(f.statuses, s, STATUS_KEYS) }))}
                      testID={`plan.filter.status.${s === NO_STATUS ? UNSURVEYED : s}`}
                    />
                  ))}
                </FilterGroup>
                <FilterGroup title="Owner" note="Open punch items and missing parts. EC and ETC each include EC/ETC." testID="plan.filter.owner">
                  {OWNERS.map((o) => (
                    <Chip key={o} small label={o} selected={prefs.filter.owners.includes(o)} onPress={() => setFilter((f) => ({ ...f, owners: toggle(f.owners, o, OWNERS) }))} testID={`plan.filter.owner.${o}`} />
                  ))}
                </FilterGroup>
                <FilterGroup title="Open punch" testID="plan.filter.openPunch">
                  <Chip small label="Open punch" selected={prefs.filter.openPunch} onPress={() => setFilter((f) => ({ ...f, openPunch: !f.openPunch }))} testID="plan.filter.openPunch.on" />
                </FilterGroup>
                <View style={styles.popoverFoot}>
                  <Btn kind="tertiary" small title="Clear" disabled={!filtering} onPress={() => setFilter(() => EMPTY_FILTER)} testID="plan.filter.clear" />
                </View>
              </ScrollView>
            </View>
          ) : (
            <View style={[styles.popover, styles.popoverBody, { bottom: space.lg, left: Math.max(8, railW + size.width - space.lg - hit.target - space.sm - (menu === 'legend' ? LEGEND_W : LAYERS_W)), width: menu === 'legend' ? LEGEND_W : LAYERS_W }]}>
              {menu === 'legend' ? (
                <Legend shapes={plan?.shapes} />
              ) : (
                <>
                  <MenuItem label="Pins" on={prefs.layers.pins} onPress={() => setLayer('pins')} testID="layer.pins" />
                  <MenuItem label="Labels (device type)" on={prefs.layers.labels} onPress={() => setLayer('labels')} testID="layer.labels" />
                  <MenuItem label="Photos (camera mark)" on={prefs.layers.photos} onPress={() => setLayer('photos')} testID="layer.photos" />
                  <MenuItem label="Ink (all users)" on={prefs.layers.ink} onPress={() => setLayer('ink')} testID="layer.ink" />
                  <MenuItem
                    label="Boundaries (source sheets)"
                    on={prefs.layers.boundaries && !!plan?.sheet?.features.boundaries.length}
                    disabled={!plan?.sheet?.features.boundaries.length}
                    note={plan?.sheet?.features.boundaries.length ? undefined : 'No boundary data for this sheet'}
                    onPress={() => setLayer('boundaries')}
                    testID="layer.boundaries"
                  />
                </>
              )}
            </View>
          )}
        </>
      ) : null}

      {/* the rail's top button: the full sidebar over the plan (docs/ui-plan.md §6) */}
      {navOpen && props.shell ? (
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={styles.scrim} onPress={() => setNavOpen(false)} testID="rail.scrim" accessibilityLabel="Close the sidebar" />
          <View style={styles.overlaySidebar}>
            <Sidebar section="Levels" projectId={projectId} projectName={props.shell.projectName} counts={props.shell.counts} user={props.shell.user} onNavigate={() => setNavOpen(false)} />
          </View>
        </View>
      ) : null}
      {props.blobs ? (
        <PhotoFlow
          request={photoReq}
          env={{ store, editor, queue: props.blobs }}
          onLibrary={switchToLibrary}
          onDismissed={() => afterDismiss.current?.()}
          onClose={(saved, photoId) => {
            setPhotoReq(null);
            const mark = photoMark.current;
            photoMark.current = null;
            if (saved && photoId && mark) {
              // "Photo here": a camera mark at the spot in the user's ink layer (D114 (6))
              const base = ink.mine ?? emptyInk();
              if (base) {
                ink.setMine(withStroke(base, makeStroke({ id: uuidv7(), tool: 'marker', color: PHOTO_MARK_COLOR, width: mark.size, points: [{ ...mark.at, p: 1 }], ref: { kind: 'photo', id: photoId }, at: new Date().toISOString() })));
              }
            }
            if (saved) onEdited();
          }}
        />
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ pieces

/** The toolbar's height (the board): the Filter popover opens under it. */
const BAR_H = 56;
const FILTER_W = 420;
const LAYERS_W = 300;
const LEGEND_W = 360;
const MENU_W = 250;
const MENU_H = 230;

/** The long-press menu (Phase 3 §4.6), next to the finger, kept inside the plan area. */
/** Touch target of the add-here dot (T70). */
const PRESS_HANDLE = 44;

function PressMenu(props: {
  at: Point;
  size: { width: number; height: number };
  /** The dot was dragged to this view point (T70). */
  onDrag: (x: number, y: number) => void;
  deviceLabel: string | null;
  canEdit: boolean;
  canPhoto: boolean;
  canInk: boolean;
  onDevice: () => void;
  onNote: () => void;
  onPhoto: () => void;
  onInk: () => void;
  onClose: () => void;
}) {
  const left = Math.max(8, Math.min(props.at.x + 12, props.size.width - MENU_W - 8));
  const top = Math.max(8, Math.min(props.at.y - 20, props.size.height - MENU_H - 8));
  // the dot is draggable once the finger that long-pressed has lifted (T70): a 44 pt handle
  const at = useRef(props.at);
  at.current = props.at;
  const onDrag = useRef(props.onDrag);
  onDrag.current = props.onDrag;
  const origin = useRef<Point>(props.at);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          origin.current = at.current;
        },
        onPanResponderMove: (_e, g) => onDrag.current(origin.current.x + g.dx, origin.current.y + g.dy),
      }),
    [],
  );
  return (
    <>
      <View
        {...drag.panHandlers}
        style={[styles.pressHandle, { left: props.at.x - PRESS_HANDLE / 2, top: props.at.y - PRESS_HANDLE / 2 }]}
        accessibilityLabel="Drag to move the spot">
        <View style={styles.pressDot} pointerEvents="none" />
      </View>
      <View style={[styles.pressMenu, { left, top, width: MENU_W }]}>
        <PressItem testID="press.device" label="+ Device (field addition)" disabled={!props.canEdit} onPress={props.onDevice} />
        <PressItem testID="press.note" label="+ Note here" disabled={!props.canInk} onPress={props.onNote} />
        <PressItem testID="press.photo" label={props.deviceLabel ? `+ Photo of ${props.deviceLabel}` : '+ Photo here'} disabled={!props.canEdit || !props.canPhoto} onPress={props.onPhoto} />
        <PressItem testID="press.ink" label="✎ Markup (ink)" disabled={!props.canInk} onPress={props.onInk} />
        <PressItem testID="press.cancel" label="Cancel" onPress={props.onClose} last />
      </View>
    </>
  );
}

const INK_TOOLS: [InkTool, string][] = [
  ['pen', '✎ Pen'],
  ['highlighter', '▬ Highlight'],
  ['text', 'T Note'],
  ['erase', '⌫ Erase'],
  ['recolor', '🎨 Recolour'],
];
const INK_WIDTHS: [number, string][] = [
  [1.5, 'thin'],
  [3, 'medium'],
  [6, 'thick'],
];

/** Draw-mode toolbar along the top of the plan (T24). */
function InkBar(props: {
  tool: InkTool;
  color: string;
  width: number;
  canUndo: boolean;
  save: string;
  error: string | null;
  missing: number;
  noteAt: boolean;
  noteText: string;
  onTool: (t: InkTool) => void;
  onColor: (c: string) => void;
  onWidth: (w: number) => void;
  onUndo: () => void;
  onNoteText: (t: string) => void;
  onPlaceNote: () => void;
  onDone: () => void;
}) {
  const saveText = props.save === 'saving' ? 'Saving…' : props.save === 'pending' ? 'Unsaved…' : props.save === 'saved' ? 'Saved' : props.save === 'error' ? 'Not saved' : '';
  return (
    <View style={styles.inkBar}>
      <View style={styles.inkRow}>
        {INK_TOOLS.map(([t, label]) => (
          <Pressable key={t} onPress={() => props.onTool(t)} style={[styles.inkBtn, props.tool === t && styles.inkBtnOn]}>
            <Text style={[styles.inkBtnText, props.tool === t && styles.inkBtnTextOn]}>{label}</Text>
          </Pressable>
        ))}
        <View style={styles.inkSep} />
        {INK_COLORS.map((c) => (
          <Pressable key={c} onPress={() => props.onColor(c)} style={[styles.inkSwatch, { backgroundColor: c }, props.color === c && styles.inkSwatchOn]} accessibilityLabel={`Colour ${c}`} />
        ))}
        <View style={styles.inkSep} />
        {INK_WIDTHS.map(([w, label]) => (
          <Pressable key={label} onPress={() => props.onWidth(w)} style={[styles.inkBtn, props.width === w && styles.inkBtnOn]}>
            <Text style={[styles.inkBtnText, props.width === w && styles.inkBtnTextOn]}>{label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={props.onUndo} disabled={!props.canUndo} style={[styles.inkBtn, !props.canUndo && styles.inkBtnOff]}>
          <Text style={styles.inkBtnText}>↶ Undo</Text>
        </Pressable>
        <View style={styles.spacer} />
        {saveText ? <Text style={[styles.inkNote, props.save === 'error' && styles.inkErr]} testID="ink.save">{saveText}</Text> : null}
        <Pressable onPress={props.onDone} style={[styles.inkBtn, styles.inkDone]} testID="ink.done">
          <Text style={[styles.inkBtnText, styles.inkBtnTextOn]}>Done</Text>
        </Pressable>
      </View>
      {props.tool === 'text' ? (
        props.noteAt ? (
          <View style={styles.inkRow}>
            <TextInput
              style={styles.inkInput}
              value={props.noteText}
              onChangeText={props.onNoteText}
              placeholder="Note text"
              placeholderTextColor={color.text3}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={props.onPlaceNote}
            />
            <Pressable onPress={props.onPlaceNote} disabled={!props.noteText.trim()} style={[styles.inkBtn, styles.inkDone, !props.noteText.trim() && styles.inkBtnOff]}>
              <Text style={[styles.inkBtnText, styles.inkBtnTextOn]}>Place</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.inkNote}>Tap the plan where the note goes.</Text>
        )
      ) : props.tool === 'erase' ? (
        <Text style={styles.inkNote}>Touch any stroke to erase it, yours or someone else's (it stays in their layer).</Text>
      ) : props.tool === 'recolor' ? (
        <Text style={styles.inkNote}>Pick a colour, then touch any stroke to give it that colour.</Text>
      ) : null}
      {props.error ? <Text style={[styles.inkNote, styles.inkErr]}>{props.error}</Text> : null}
      {props.missing ? <Text style={styles.inkNote}>{props.missing} ink layer{props.missing === 1 ? '' : 's'} not downloaded yet.</Text> : null}
    </View>
  );
}

function PressItem({ label, onPress, disabled, note, testID, last }: { label: string; onPress: () => void; disabled?: boolean; note?: string; testID?: string; last?: boolean }) {
  return (
    <Pressable style={({ pressed }) => [styles.pressItem, last && styles.pressItemLast, pressed && !disabled && styles.pressedBg]} onPress={disabled ? undefined : onPress} testID={testID}>
      <Text style={[styles.pressText, disabled && styles.disabled]}>{label}</Text>
      {note ? <Text style={styles.menuNoteInline}>{note}</Text> : null}
    </Pressable>
  );
}

function Centered({ text, spinner }: { text?: string; spinner?: boolean }) {
  return (
    <View style={styles.centered}>
      {spinner ? <ActivityIndicator color={color.text3} /> : null}
      {text ? <Text style={styles.centeredText}>{text}</Text> : null}
    </View>
  );
}

/** A 44-pt icon button (the board's `.ib`): the toolbar's Ink, the floating Fit / Grid / Layers / Legend. */
function IconBtn({ icon, label, onPress, on, testID }: { icon: IconName; label: string; onPress: () => void; on?: boolean; testID: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.ib, on && styles.ibOn, pressed && !on && styles.pressedBg]}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} size={20} color={on ? color.primary : color.text} strokeWidth={1.8} />
    </Pressable>
  );
}

/** A link in the side panel's header row: Place ▸, Select, All n, Apply as ruling…, Cancel. */
function SideLink({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8} style={styles.sideLinkBox} testID={testID} accessibilityRole="button">
      <Text style={[styles.sideLink, disabled && styles.sideOff]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One group of the Filter popover: its title, its chips, an optional note under them. */
function FilterGroup({ title, note, testID, children }: { title: string; note?: string; testID: string; children: ReactNode }) {
  return (
    <View style={styles.filterGroup} testID={testID}>
      <Text style={styles.filterTitle}>{title}</Text>
      <View style={styles.filterChips}>{children}</View>
      {note ? <Text style={styles.menuNote}>{note}</Text> : null}
    </View>
  );
}

/** A Layers row: ☑ / ☐ and the layer's name (flows read the box from the row's text). */
function MenuItem(props: { label: string; on: boolean; onPress: () => void; disabled?: boolean; note?: string; testID?: string }) {
  return (
    <Pressable style={({ pressed }) => [styles.menuItem, pressed && !props.disabled && styles.pressedBg]} onPress={props.disabled ? undefined : props.onPress} testID={props.testID}>
      <Text style={[styles.menuCheck, props.on && styles.menuCheckOn, props.disabled && styles.disabled]}>{props.on ? '☑' : '☐'}</Text>
      <View style={styles.menuLabelBox}>
        <Text style={[styles.menuLabel, props.disabled && styles.disabled]}>{props.label}</Text>
        {props.note ? <Text style={styles.menuNoteInline}>{props.note}</Text> : null}
      </View>
    </Pressable>
  );
}

function togglePick(cur: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(cur);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function ListRowView({ row, selected, picking, onPress }: { row: ListRow; selected: boolean; picking?: boolean; onPress: () => void }) {
  const st = pinStyleFor(row.tab === 'connections' ? row.endStatus : row.deviceStatus);
  return (
    <Pressable style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && !selected && styles.pressedBg, row.badges.deleted && styles.rowDeleted]} onPress={onPress} testID={`plan.row.${row.tab}.${row.label}`}>
      {picking ? <Text style={[styles.pickBox, selected && styles.pickBoxOn]}>{selected ? '☑' : '☐'}</Text> : null}
      {row.tab === 'connections' ? <Swatch {...st} size={20} /> : <Text style={styles.rowNum}>{row.label}</Text>}
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

function DeviceRow({ device, badges, selected, picking, onPress }: { device: PlanDevice; badges: Badges; selected: boolean; picking?: boolean; onPress: () => void }) {
  const st = pinStyleFor(device.status);
  return (
    <Pressable style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && !selected && styles.pressedBg, device.deleted && styles.rowDeleted]} onPress={onPress} testID={`plan.device.${device.label}`}>
      {picking ? <Text style={[styles.pickBox, selected && styles.pickBoxOn]}>{selected ? '☑' : '☐'}</Text> : null}
      <Swatch {...st} size={20} />
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

/** The ink bar sits on the plan in a dark translucent strip, as before (T24): the text token at 88 %. */
const INK_BAR_BG = `${color.text}E0`;

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: color.bg },
  main: { flex: 1, minWidth: 0 },
  bar: {
    height: BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.md,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, height: hit.target, paddingLeft: space.xs, paddingRight: space.sm, borderRadius: radius.control, flexShrink: 0, maxWidth: 160 },
  backText: { ...font.body, color: color.primary, flexShrink: 1 },
  barRule: { width: StyleSheet.hairlineWidth, height: 24, backgroundColor: color.hairline },
  titleBox: { flexShrink: 1, minWidth: 48, paddingRight: space.xs },
  titleCode: { ...font.headline, ...tabular, color: color.text },
  titleSub: { ...font.caption, lineHeight: 16, color: color.text3 },
  search: {
    flex: 1,
    minWidth: 110,
    maxWidth: 220,
    height: hit.target,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    backgroundColor: color.bg,
  },
  searchInput: { flex: 1, minWidth: 0, ...font.callout, color: color.text, paddingVertical: 0 },
  tb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: hit.target,
    paddingHorizontal: 14,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  tbOn: { backgroundColor: color.primaryTint, borderColor: color.primaryTint },
  tbText: { ...font.calloutBold, color: color.text },
  tbTextOn: { color: color.primary },
  count: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: radius.pill, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center' },
  countText: { ...font.badge, ...tabular, lineHeight: 16, color: color.onPrimary },
  ib: {
    width: hit.target,
    height: hit.target,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ibOn: { backgroundColor: color.primaryTint, borderColor: color.primaryTint },
  pressedBg: { backgroundColor: color.surface2 },
  spacer: { flex: 1 },
  plan: { flex: 1, backgroundColor: color.surface2, overflow: 'hidden' },
  pdf: { flex: 1, backgroundColor: color.surface2 },
  planTools: { position: 'absolute', right: space.lg, bottom: space.lg, gap: 6, alignItems: 'flex-end' },
  bench: { backgroundColor: color.surface, borderRadius: radius.control, borderWidth: 1, borderColor: color.border, paddingHorizontal: 14, paddingVertical: 10 },
  benchText: { ...font.calloutBold, color: color.text },
  lists: { flex: 1 },
  hidden: { display: 'none' },
  dragDot: { position: 'absolute', width: 28, height: 28, borderRadius: 14, borderWidth: 3, borderColor: color.primary, backgroundColor: color.primaryTint },
  moveBanner: {
    position: 'absolute',
    top: space.md,
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: color.warningTint,
    ...shadow.card,
  },
  moveText: { flex: 1, ...font.callout, color: color.text },
  moveCancel: { ...font.calloutBold, color: color.primary },
  conflictSides: { ...font.caption, color: color.text2, marginTop: 2 },
  conflictError: { ...font.caption, color: color.danger, marginTop: 2 },
  side: { width: '28%', backgroundColor: color.surface, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  sideHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, minHeight: hit.target, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  sideNote: { flex: 1, ...font.caption, ...tabular, color: color.text3 },
  sideLinkBox: { paddingVertical: space.xs },
  sideLink: { ...font.calloutBold, color: color.primary },
  sideOff: { opacity: 0.4 },
  pickBox: { fontSize: 18, width: 22, color: color.text2 },
  pickBoxOn: { color: color.primary },
  empty: { padding: space.lg, ...font.callout, color: color.text3 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  rowSelected: { backgroundColor: color.primaryTint },
  rowMain: { flex: 1, minWidth: 0 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowId: { ...font.calloutBold, ...tabular, color: color.text },
  rowSub: { ...font.caption, lineHeight: 16, color: color.text3, marginTop: 1 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  rowCount: { ...font.caption, ...tabular, color: color.text2 },
  rowDeleted: { opacity: 0.55 },
  rowNum: { width: 40, ...font.calloutBold, ...tabular, color: color.text },
  rowTitle: { ...font.caption, lineHeight: 16, color: color.text, marginTop: 1 },
  tabs: { flexDirection: 'row', paddingHorizontal: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  tabBtn: { flex: 1, height: hit.target, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnOn: { borderColor: color.primary },
  tabText: { ...font.captionBold, color: color.text2 },
  tabCount: { ...font.caption, ...tabular, color: color.text2 },
  tabTextOn: { color: color.primary },
  popover: {
    position: 'absolute',
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    ...shadow.card,
  },
  popoverBody: { padding: space.lg, gap: space.md },
  popoverFoot: { flexDirection: 'row', justifyContent: 'flex-end' },
  filterGroup: { gap: space.sm },
  filterTitle: { ...font.captionBold, color: color.text2 },
  filterChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: `${color.text}40` },
  overlaySidebar: { position: 'absolute', top: 0, bottom: 0, left: 0, flexDirection: 'row', ...shadow.card },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: hit.target, paddingHorizontal: space.xs, borderRadius: radius.control },
  menuCheck: { fontSize: 18, width: 22, color: color.text2 },
  menuCheckOn: { color: color.primary },
  menuLabelBox: { flexShrink: 1 },
  menuLabel: { ...font.callout, color: color.text },
  menuNote: { ...font.caption, color: color.text3 },
  menuNoteInline: { ...font.caption, color: color.text3 },
  disabled: { color: color.text3 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xxl },
  centeredText: { ...font.body, color: color.text2, textAlign: 'center' },
  pressHandle: { position: 'absolute', width: PRESS_HANDLE, height: PRESS_HANDLE, alignItems: 'center', justifyContent: 'center' },
  pressDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: color.primary, backgroundColor: color.surface },
  pressMenu: {
    position: 'absolute',
    paddingVertical: space.xs,
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    ...shadow.card,
  },
  inkBar: { position: 'absolute', top: space.sm, left: space.sm, right: space.sm, padding: space.sm, gap: 6, borderRadius: radius.card, backgroundColor: INK_BAR_BG },
  inkRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  inkBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.control, borderWidth: 1, borderColor: color.text2 },
  inkBtnOn: { backgroundColor: color.primary, borderColor: color.primary },
  inkBtnOff: { opacity: 0.4 },
  inkBtnText: { ...font.captionBold, color: color.surface2 },
  inkBtnTextOn: { color: color.onPrimary },
  inkDone: { backgroundColor: color.success, borderColor: color.success },
  inkSep: { width: 1, height: 24, backgroundColor: color.text2, marginHorizontal: 2 },
  inkSwatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: color.muted },
  inkSwatchOn: { borderWidth: 3, borderColor: color.primary },
  inkNote: { ...font.caption, color: color.border },
  inkErr: { color: color.dangerTint },
  inkInput: { flex: 1, minWidth: 200, paddingHorizontal: space.sm, paddingVertical: 6, ...font.callout, borderRadius: radius.control, backgroundColor: color.surface, color: color.text },
  pressItem: { paddingHorizontal: space.lg, minHeight: hit.target, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  pressItemLast: { borderBottomWidth: 0 },
  pressText: { ...font.calloutBold, fontSize: 16, color: color.primary },
});
