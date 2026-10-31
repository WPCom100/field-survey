/**
 * "Place devices" in the plan's side panel (T46, Phase 3 §3.4): the level's unplaced list (this
 * level · pool · flagged, by type), the selected item with "tap the plan, or drag ⠿ onto it",
 * Flag: not on this sheet, and — once a spot is chosen — the confirm form: ID (the device's, or
 * `<level>-? NEW` for the server to number, D93 / D118), panel tag, Drawing Position and Room
 * (defaults from the grid and the nearest room at the spot, T45) → Place ✓. Dashed pins on the
 * plan are proposals from the sheet's text tags; tapping one selects it with its spot.
 * The logic is in `model.ts` / `actions.ts`; this is the view.
 */

import { OpError, ROLE_LABEL, type Editor, type Role, type Store } from '@field-survey/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { chipStyles } from '../plan/chips';
import { flagNotOnSheet, placeItem, type PlaceResult } from './actions';
import { TAGGED_ROLES, itemLine, itemsIn, rolesIn, type LevelUnplaced, type PlaceScope, type UnplacedItem } from './model';

export type PlacePanelProps = {
  store: Store;
  editor: Editor | null;
  levelId: string;
  levelCode: string;
  sheetId: string;
  data: LevelUnplaced | null;
  proposals: number;
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
        <Pressable onPress={props.onClose} hitSlop={8}>
          <Text style={styles.back}>◀ Done placing</Text>
        </Pressable>
        <Text style={styles.title}>Place devices — {props.levelCode}</Text>
        {p ? (
          <Text style={styles.muted}>
            Placed {p.placed} of {p.devices}
            {p.draftUnits ? ` · ${p.draftUnits} to place from drafts` : ''}
            {p.flagged ? ` · ${p.flagged} flagged` : ''}
          </Text>
        ) : null}
        <View style={styles.rowWrap}>
          <Chip label={`${props.levelCode} ${counts.level}`} on={scope === 'level'} onPress={() => setScope('level')} />
          <Chip label={`Pool ${counts.pool}`} on={scope === 'pool'} onPress={() => setScope('pool')} />
          <Chip label={`Flagged ${counts.flagged}`} on={scope === 'flagged'} onPress={() => setScope('flagged')} />
        </View>
        {roles.length > 1 ? (
          <View style={styles.rowWrap}>
            <Chip label="All types" on={!role} onPress={() => setRole(null)} small />
            {roles.map((r) => (
              <Chip key={r} label={ROLE_LABEL[r]} on={role === r} onPress={() => setRole(role === r ? null : r)} small />
            ))}
          </View>
        ) : null}
        {props.proposals > 0 ? <Text style={styles.note}>{props.proposals} dashed pin{props.proposals === 1 ? '' : 's'} proposed from the sheet's tags: tap one to confirm it.</Text> : null}
        {!editor ? <Text style={styles.warn}>Pick who you are to place devices.</Text> : null}
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>

      {selected ? (
        <Selected
          key={selected.key}
          item={selected}
          levelCode={props.levelCode}
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
          onPlace={(form) =>
            void run(async () => {
              if (!editor || !spot) return null;
              const r = await placeItem(editor, props.store, selected, { levelId: props.levelId, sheetId: props.sheetId, at: spot, ...form });
              console.log(`[plan] placed ${selected.key} → ${r.deviceId}${r.cablesMade ? `, ${r.cablesMade} waiting cable(s) made` : ''}`);
              props.onPlaced(r, selected);
              const what = selected.kind === 'device' ? selected.label : `${props.levelCode}-? ${selected.title}`;
              return `Placed ${what}.${r.cablesMade ? ` ${r.cablesMade} waiting cable${r.cablesMade === 1 ? '' : 's'} made.` : ''}`;
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
            <Pressable onPress={() => props.onSelect(item.key === selectedKey ? null : item.key)} style={[styles.row, item.key === selectedKey && styles.rowOn]}>
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
  spot: { x: number; y: number } | null;
  defaults: { drawingPosition: string | null; room: string | null } | null;
  busy: boolean;
  canEdit: boolean;
  onDrag: (pageX: number, pageY: number, end: boolean) => void;
  onCancel: () => void;
  onFlag: (flag: boolean) => void;
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
      <Text style={styles.selTitle} numberOfLines={2}>
        {itemLine(item)}
      </Text>
      {!spot ? (
        <>
          <Text style={styles.muted}>Tap the plan where it is, or drag the handle onto the plan.</Text>
          <View style={styles.rowWrap}>
            <View {...responder.panHandlers} style={styles.handle}>
              <Text style={styles.handleText}>⠿ Drag onto the plan</Text>
            </View>
            {item.kind === 'draft' ? (
              <Btn label={item.notOnSheet ? 'Unflag: back on the list' : 'Flag: not on this sheet ⊗'} onPress={() => props.onFlag(!item.notOnSheet)} disabled={props.busy || !props.canEdit} />
            ) : null}
            <Btn label="Cancel" onPress={props.onCancel} />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.label}>ID</Text>
          <View style={styles.rowWrap}>
            <Text style={styles.idText}>{id}</Text>
            {isNew ? <Text style={chipStyles.badge}>NEW</Text> : null}
            {isNew ? <Text style={styles.muted}>numbered by the server at the next sync</Text> : null}
          </View>
          {tagged ? (
            <>
              <Text style={styles.label}>Panel tag</Text>
              <TextInput style={styles.input} value={panel} onChangeText={setPanel} placeholder="e.g. CT06LCPA" placeholderTextColor="#888" autoCapitalize="characters" autoCorrect={false} />
            </>
          ) : null}
          <Text style={styles.label}>Drawing Position</Text>
          <TextInput style={styles.input} value={dp} onChangeText={(t) => { typed.current.dp = true; setDp(t); }} placeholder="e.g. Grid B-C / 9-8" placeholderTextColor="#888" autoCorrect={false} />
          <Text style={styles.label}>Room / Location</Text>
          <TextInput style={styles.input} value={room} onChangeText={(t) => { typed.current.room = true; setRoom(t); }} placeholder="e.g. Elec Rm XX06M-1E05" placeholderTextColor="#888" />
          <View style={styles.rowWrap}>
            <Btn
              label={props.busy ? 'Placing…' : 'Place ✓'}
              primary
              disabled={props.busy || !props.canEdit}
              onPress={() => props.onPlace({ drawingPosition: dp, room, ...(tagged ? { panelName: panel } : {}) })}
            />
            <Btn label="Cancel" onPress={props.onCancel} />
          </View>
          <Text style={styles.muted}>Tap the plan again to move the spot.</Text>
        </>
      )}
    </View>
  );
}

function Chip({ label, on, onPress, small }: { label: string; on: boolean; onPress: () => void; small?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, small && styles.chipSmall, on && styles.chipOn]}>
      <Text style={[styles.chipText, small && styles.chipTextSmall, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Btn({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, primary && styles.btnPrimary, disabled && styles.btnOff]}>
      {primary && disabled && label.endsWith('…') ? <ActivityIndicator color="#fff" /> : <Text style={[styles.btnText, primary && styles.btnTextPrimary]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  back: { fontSize: 15, color: '#1565c0', fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700' },
  muted: { fontSize: 12, color: '#777' },
  note: { fontSize: 12, color: '#6a1b9a' },
  warn: { fontSize: 12, color: '#e65100' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  chipSmall: { paddingHorizontal: 8, paddingVertical: 4 },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { fontSize: 13, color: '#222' },
  chipTextSmall: { fontSize: 12 },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  selected: { padding: 12, gap: 6, backgroundColor: '#f1f6fd', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  selTitle: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '700', color: '#333', marginTop: 2 },
  idText: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 7, fontSize: 15, backgroundColor: '#fff' },
  handle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, backgroundColor: '#37474f' },
  handleText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btn: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff', minWidth: 60, alignItems: 'center' },
  btnPrimary: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  btnOff: { opacity: 0.5 },
  btnText: { fontSize: 14, color: '#1565c0', fontWeight: '600' },
  btnTextPrimary: { color: '#fff' },
  list: { padding: 8, gap: 4, paddingBottom: 40 },
  row: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de', gap: 3 },
  rowOn: { backgroundColor: '#dce8fb', borderColor: '#1565c0' },
  rowText: { fontSize: 14, fontWeight: '600', color: '#222' },
  rowSub: { fontSize: 12, color: '#666' },
});
