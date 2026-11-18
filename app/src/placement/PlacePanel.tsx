/**
 * "Place devices" in the plan's side panel (T46, Phase 3 §3.4): the level's unplaced list (this
 * level · pool · flagged, by type), the selected item with "tap the plan, or drag ⠿ onto it",
 * Flag: not on this sheet (a flagged one: Move to… another level or the pool, T143), and — once a
 * spot is chosen — the confirm form: ID (the device's, or `<level>-? NEW` for the server to number,
 * D93 / D118), panel tag, Drawing Position and Room
 * (defaults from the grid and the nearest room at the spot, T45) → Place ✓. Dashed pins on the
 * plan are proposals from what the sheet prints (types and panel tags, T140), a guess fainter and
 * named so in the form; tapping one selects it with its spot. The row
 * just placed stays at the top with ↶ Undo until the panel closes (T139).
 * The logic is in `model.ts` / `actions.ts`; this is the view.
 */

import { OpError, ROLE_LABEL, type Editor, type Role, type Store } from '@field-survey/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { chipStyles } from '../plan/chips';
import { Btn as UiBtn, Chip as UiChip, FormActions, PanelHeader, color, fieldStyles, font, radius, space, tabular } from '../ui';
import { flagNotOnSheet, moveDraft, placeItem, unplaceDevice, type PlaceResult } from './actions';
import { TAGGED_ROLES, itemLine, itemsIn, rolesIn, type LevelUnplaced, type PlaceScope, type UnplacedItem } from './model';

export type PlacePanelProps = {
  store: Store;
  editor: Editor | null;
  levelId: string;
  levelCode: string;
  sheetId: string;
  data: LevelUnplaced | null;
  proposals: number;
  /** …of which guessed by role alone (T140, D234 (3)): drawn fainter. */
  guesses: number;
  /** The printed tag behind the chosen spot when that spot is a guess. */
  spotGuess: string | null;
  selectedKey: string | null;
  /** The spot on the sheet (a tap, a drop or a proposal), null until chosen. */
  spot: { x: number; y: number } | null;
  /** Defaults at the spot from the grid calibration and the text pass. */
  defaults: { drawingPosition: string | null; room: string | null } | null;
  onSelect: (key: string | null) => void;
  onClearSpot: () => void;
  onPlaced: (r: PlaceResult, item: UnplacedItem) => void;
  onEdited: () => void;
  onClose: () => void;
  /** Dragging the selected item: page coordinates of the finger; `end` drops it. */
  onDrag: (pageX: number, pageY: number, end: boolean) => void;
};

export function PlacePanel(props: PlacePanelProps) {
  const { data, selectedKey, spot, editor } = props;
  const [scope, setScope] = useState<PlaceScope>('level');
  const [role, setRole] = useState<Role | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The last placement, with ↶ Undo until the panel closes (T139). */
  const [last, setLast] = useState<{ deviceId: string; what: string; text: string } | null>(null);

  const all = useMemo(() => (data ? [...data.items, ...data.flagged] : []), [data]);
  const selected = selectedKey ? (all.find((i) => i.key === selectedKey) ?? null) : null;
  const rows = useMemo(() => (data ? itemsIn(data, scope, role) : []), [data, scope, role]);
  const roles = useMemo(() => (data ? rolesIn(data) : []), [data]);
  const counts = useMemo(
    () => (data ? { level: itemsIn(data, 'level').length, pool: itemsIn(data, 'pool').length, flagged: data.flagged.length } : { level: 0, pool: 0, flagged: 0 }),
    [data],
  );

  // a proposal or a row from another scope selects an item this scope hides: show its scope
  useEffect(() => {
    if (!selected || !data) return;
    const where: PlaceScope = selected.kind === 'draft' && selected.notOnSheet ? 'flagged' : selected.kind === 'draft' && selected.pool ? 'pool' : 'level';
    if (where !== scope) setScope(where);
    if (role && selected.role !== role) setRole(null);
  }, [selectedKey]);

  const run = async (what: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await what());
    } catch (e) {
      setNote(e instanceof OpError ? e.message : `Not saved: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  const p = data?.progress;
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        {/* placing mode closes to the plan's panel: × at the top right (D280 (5), T191; was "◀ Done placing") */}
        <PanelHeader title={`Place devices — ${props.levelCode}`} close={{ onPress: props.onClose, testID: 'place.done', label: 'Done placing' }} />
        {p ? (
          <Text style={styles.muted} testID="place.progress">
            Placed {p.placed} of {p.devices}
            {p.draftUnits ? ` · ${p.draftUnits} to place from drafts` : ''}
            {p.flagged ? ` · ${p.flagged} flagged` : ''}
          </Text>
        ) : null}
        <View style={styles.rowWrap}>
          <Chip label={`${props.levelCode} ${counts.level}`} on={scope === 'level'} onPress={() => setScope('level')} testID="place.scope.level" />
          <Chip label={`Pool ${counts.pool}`} on={scope === 'pool'} onPress={() => setScope('pool')} testID="place.scope.pool" />
          <Chip label={`Flagged ${counts.flagged}`} on={scope === 'flagged'} onPress={() => setScope('flagged')} testID="place.scope.flagged" />
        </View>
        {roles.length > 1 ? (
          <View style={styles.rowWrap}>
            <Chip label="All types" on={!role} onPress={() => setRole(null)} small />
            {roles.map((r) => (
              <Chip key={r} label={ROLE_LABEL[r]} on={role === r} onPress={() => setRole(role === r ? null : r)} small />
            ))}
          </View>
        ) : null}
        {props.proposals > 0 ? (
          <Text style={styles.note}>
            {props.proposals} dashed pin{props.proposals === 1 ? '' : 's'} where the sheet prints the type or tag: tap one to confirm it.
            {props.guesses > 0 ? ` ${props.guesses} faint one${props.guesses === 1 ? ' is a guess' : 's are guesses'} by type alone.` : ''}
          </Text>
        ) : null}
        {spot && props.spotGuess ? <Text style={styles.warn}>Guess: the sheet prints {props.spotGuess} here, not this model.</Text> : null}
        {!editor ? <Text style={styles.warn}>Pick who you are to place devices.</Text> : null}
        {note ? <Text style={styles.note} testID="place.note">{note}</Text> : null}
        {last ? (
          <View style={[styles.row, styles.lastRow]}>
            <Text style={[styles.rowText, styles.lastText]} numberOfLines={2} testID="place.last">
              {last.text}
            </Text>
            <Btn
              label="↶ Undo"
              testID="place.undo"
              disabled={busy || !editor}
              onPress={() =>
                void run(async () => {
                  if (!editor) return null;
                  const r = await unplaceDevice(editor, props.store, last.deviceId);
                  console.log(`[plan] unplaced ${last.deviceId}: ${r.deleted ? 'deleted' : 'pin cleared'}${r.endsBack ? `, ${r.endsBack} end(s) wait for the draft again` : ''}`);
                  setLast(null);
                  props.onEdited();
                  return `${last.what}: back in the unplaced list.`;
                })
              }
            />
          </View>
        ) : null}
      </View>

      {selected ? (
        <Selected
          key={selected.key}
          item={selected}
          levelCode={props.levelCode}
          levels={data?.levels ?? []}
          spot={spot}
          defaults={props.defaults}
          busy={busy}
          canEdit={!!editor}
          onDrag={props.onDrag}
          onCancel={() => (spot ? props.onClearSpot() : props.onSelect(null))}
          onFlag={(flag) =>
            void run(async () => {
              if (!editor || selected.kind !== 'draft') return null;
              await flagNotOnSheet(editor, selected, flag);
              props.onSelect(null);
              props.onEdited();
              return flag ? `${selected.title}: flagged not on this sheet.` : `${selected.title}: back on the list.`;
            })
          }
          onMove={(to) =>
            void run(async () => {
              if (!editor || selected.kind !== 'draft') return null;
              await moveDraft(editor, selected, to);
              props.onSelect(null);
              props.onEdited();
              return `${selected.title}: moved to ${to.code ?? 'the pool'}${to.levelId === props.levelId ? ', back on the list' : ''}.`;
            })
          }
          onPlace={(form) =>
            void run(async () => {
              if (!editor || !spot) return null;
              const r = await placeItem(editor, props.store, selected, { levelId: props.levelId, sheetId: props.sheetId, at: spot, ...form });
              console.log(`[plan] placed ${selected.key} → ${r.deviceId}${r.cablesMade ? `, ${r.cablesMade} waiting cable(s) made` : ''}`);
              props.onPlaced(r, selected);
              const what = selected.kind === 'device' ? selected.label : `${props.levelCode}-? ${selected.title}`;
              setLast({ deviceId: r.deviceId, what, text: `Placed ${what}.${r.cablesMade ? ` ${r.cablesMade} waiting cable${r.cablesMade === 1 ? '' : 's'} made.` : ''}` });
              return null;
            })
          }
        />
      ) : null}

      {!data ? (
        <ActivityIndicator style={{ marginTop: 20 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(i) => i.key}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.muted}>
              {scope === 'flagged' ? 'Nothing flagged.' : scope === 'pool' ? 'Nothing left in the pool.' : `Everything on ${props.levelCode} is placed.`}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => props.onSelect(item.key === selectedKey ? null : item.key)} style={[styles.row, item.key === selectedKey && styles.rowOn]} testID="place.item">
              <Text style={styles.rowText} numberOfLines={2}>
                {itemLine(item)}
              </Text>
              <View style={styles.rowWrap}>
                <Text style={styles.rowSub}>{ROLE_LABEL[item.role]}</Text>
                {item.kind === 'device' ? <Text style={styles.rowSub}>in the baseline</Text> : <Text style={styles.rowSub}>draft</Text>}
                {item.kind === 'device' && item.isNew ? <Text style={chipStyles.badge}>NEW</Text> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

type Form = { drawingPosition: string | null; room: string | null; panelName?: string | null };

function Selected(props: {
  item: UnplacedItem;
  levelCode: string;
  levels: { levelId: string; code: string }[];
  spot: { x: number; y: number } | null;
  defaults: { drawingPosition: string | null; room: string | null } | null;
  busy: boolean;
  canEdit: boolean;
  onDrag: (pageX: number, pageY: number, end: boolean) => void;
  onCancel: () => void;
  onFlag: (flag: boolean) => void;
  onMove: (to: { levelId: string | null; code: string | null }) => void;
  onPlace: (form: Form) => void;
}) {
  const { item, spot } = props;
  const existing = item.kind === 'device' ? { dp: item.drawingPosition, room: item.room } : { dp: null, room: null };
  // a device's own text wins over the default at the spot (its Drawing Position may be the master's)
  const [dp, setDp] = useState(existing.dp ?? props.defaults?.drawingPosition ?? '');
  const [room, setRoom] = useState(existing.room ?? props.defaults?.room ?? '');
  // a moved spot brings its own defaults into the fields nobody typed in
  const typed = useRef({ dp: false, room: false });
  useEffect(() => {
    if (!typed.current.dp) setDp(existing.dp ?? props.defaults?.drawingPosition ?? '');
    if (!typed.current.room) setRoom(existing.room ?? props.defaults?.room ?? '');
  }, [props.defaults?.drawingPosition, props.defaults?.room]);
  // a master panel of `Power Distribution` with no type is `other` but has its tag (T127)
  const tagged = (TAGGED_ROLES.has(item.role) && item.role !== 'equipment_rack') || (item.role === 'other' && !!item.panelName);
  const [panel, setPanel] = useState(item.panelName ?? '');
  const [moving, setMoving] = useState(false);
  const flagged = item.kind === 'draft' && item.notOnSheet ? item : null;

  const onDrag = useRef(props.onDrag);
  onDrag.current = props.onDrag;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (e) => onDrag.current(e.nativeEvent.pageX, e.nativeEvent.pageY, false),
        onPanResponderRelease: (e) => onDrag.current(e.nativeEvent.pageX, e.nativeEvent.pageY, true),
        onPanResponderTerminate: (e) => onDrag.current(e.nativeEvent.pageX, e.nativeEvent.pageY, true),
      }),
    [],
  );

  const id = item.kind === 'device' ? item.label : `${props.levelCode}-?`;
  const isNew = item.kind === 'device' ? item.isNew : true;
  return (
    <View style={styles.selected}>
      <Text style={styles.selTitle} numberOfLines={2} testID="place.selected">
        {itemLine(item)}
      </Text>
      {!spot ? (
        <>
          <View style={styles.rowWrap}>
            <View {...responder.panHandlers} style={styles.handle}>
              <Text style={styles.handleText}>⠿ Drag onto the plan</Text>
            </View>
            {item.kind === 'draft' ? (
              <Btn label={item.notOnSheet ? 'Unflag: back on the list' : 'Flag: not on this sheet ⊗'} onPress={() => props.onFlag(!item.notOnSheet)} disabled={props.busy || !props.canEdit} testID="place.flag" />
            ) : null}
            {flagged ? <Btn label="Move to…" onPress={() => setMoving(!moving)} disabled={props.busy || !props.canEdit} testID="place.move" /> : null}
            <Btn label="Cancel" onPress={props.onCancel} testID="place.cancel" />
          </View>
          {flagged && moving && !props.busy ? (
            <>
              <Text style={styles.muted} testID="place.moveHint">
                {flagged.placed ? `${flagged.remaining} unit${flagged.remaining === 1 ? '' : 's'} left move; the ${flagged.placed} placed keep their level. ` : ''}It comes off Flagged.
              </Text>
              <View style={styles.rowWrap}>
                {props.levels
                  .filter((l) => l.levelId !== flagged.levelId)
                  .map((l) => (
                    <Chip key={l.levelId} label={l.code} on={false} onPress={() => props.onMove({ levelId: l.levelId, code: l.code })} testID={`place.moveTo.${l.code}`} />
                  ))}
                {!flagged.pool ? <Chip label="Pool, every level" on={false} onPress={() => props.onMove({ levelId: null, code: null })} testID="place.moveTo.pool" /> : null}
              </View>
            </>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.label}>ID</Text>
          <View style={styles.rowWrap}>
            <Text style={styles.idText}>{id}</Text>
            {isNew ? <Text style={chipStyles.badge}>NEW</Text> : null}
          </View>
          {tagged ? (
            <>
              <Text style={styles.label}>Panel tag</Text>
              <TextInput style={styles.input} value={panel} onChangeText={setPanel} placeholder="e.g. CT06LCPA" placeholderTextColor={color.text3} autoCapitalize="characters" autoCorrect={false} />
            </>
          ) : null}
          <Text style={styles.label}>Drawing Position</Text>
          <TextInput style={styles.input} value={dp} onChangeText={(t) => { typed.current.dp = true; setDp(t); }} placeholder="e.g. Grid B-C / 9-8" placeholderTextColor={color.text3} autoCorrect={false} />
          <Text style={styles.label}>Room / Location</Text>
          <TextInput style={styles.input} value={room} onChangeText={(t) => { typed.current.room = true; setRoom(t); }} placeholder="e.g. Elec Rm XX06M-1E05" placeholderTextColor={color.text3} />
          <FormActions>
            <Btn label="Cancel" onPress={props.onCancel} testID="place.cancel" />
            <Btn
              label={props.busy ? 'Placing…' : 'Place ✓'}
              testID="place.confirm"
              primary
              disabled={props.busy || !props.canEdit}
              onPress={() => props.onPlace({ drawingPosition: dp, room, ...(tagged ? { panelName: panel } : {}) })}
            />
          </FormActions>
        </>
      )}
    </View>
  );
}

/** The panel's chips and buttons on the system's primitives (T180); every chip is the 32-pt one. */
function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; small?: boolean; testID?: string }) {
  return <UiChip small label={label} selected={on} onPress={onPress} testID={testID} />;
}

/** Placing… shows the spinner (`loading`) while the button waits. */
function Btn({ label, onPress, primary, disabled, testID }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; testID?: string }) {
  return <UiBtn small title={label} kind={primary ? 'primary' : 'secondary'} onPress={onPress} disabled={disabled} loading={!!primary && !!disabled && label.endsWith('…')} testID={testID} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  head: { paddingHorizontal: space.md, paddingTop: 10, paddingBottom: space.sm, gap: 6, borderBottomWidth: 1, borderColor: color.hairline },
  muted: { ...font.caption, color: color.text3 },
  note: { ...font.caption, color: color.primary },
  warn: { ...font.caption, color: color.warning },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  selected: { padding: space.md, gap: 6, backgroundColor: color.primaryTint, borderBottomWidth: 1, borderColor: color.hairline },
  selTitle: { ...font.headline, color: color.text },
  label: { ...font.captionBold, color: color.text2, marginTop: 2 },
  idText: { ...font.headline, ...tabular, color: color.text },
  input: fieldStyles.input,
  handle: { minHeight: 36, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.control, backgroundColor: color.text },
  handleText: { ...font.captionBold, color: color.onPrimary },
  list: { padding: space.sm, gap: space.xs, paddingBottom: 40 },
  row: { minHeight: 44, paddingHorizontal: 10, paddingVertical: space.sm, borderRadius: radius.control, borderWidth: 1, borderColor: color.hairline, gap: 3 },
  rowOn: { backgroundColor: color.primaryTint, borderColor: color.primary },
  lastText: { flex: 1 },
  lastRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.successTint, borderColor: color.success },
  rowText: { ...font.calloutBold, color: color.text },
  rowSub: { ...font.caption, color: color.text3 },
});
