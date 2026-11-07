/**
 * Punch item / missing part editor (T162, D254) in the plan's side panel, opened from the device
 * card's Punch items / Missing parts rows or the plan's Punch / Parts tabs; ◀ goes back to where
 * it was opened. Tracking status (Date closed set with it) or Part status, Owner, Notes with the
 * project's phrase chips; Item / Part text and Type stay as the rules or the import wrote them.
 * Every tap is one `Field survey` op (D45, D96). An R3c address item is kept by the rules: its
 * status is read-only and the devices it waits for are links per floor. Render with `key={id}`.
 */

import { OpError, vocab, type Editor, type Store } from '@field-survey/core';
import { ADDRESS_ARTICLE } from '@field-survey/rules';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { appendPhrase } from '../card/actions';
import type { HistoryEntry, JumpTarget } from '../card/model';
import { chipStyles } from '../plan/chips';
import { setItemNotes, setItemOwner, setPartStatus, setTrackingStatus, type ItemKind } from './actions';
import { loadItem, type ItemView } from './model';

const CHIPS_SHOWN = 4;

export type ItemEditorProps = {
  store: Store;
  editor: Editor | null;
  kind: ItemKind;
  id: string;
  /** The plan's level: a device there is selected, one elsewhere opens its level. */
  levelId: string | null;
  reloadKey: unknown;
  names: ReadonlyMap<string, string>;
  /** "◀ 06M-02" back to the card, or "◀ Punch" / "◀ Parts" back to the list. */
  backLabel: string;
  onBack: () => void;
  onEdited: () => void;
  /** Open a device's card (the item's device, or one an R3c item waits for). */
  onJump: (t: JumpTarget) => void;
  canOpenLevels: boolean;
};

type Run = (fn: (e: Editor) => Promise<unknown>) => void;

/** Fill per status: Closed / Installed read done (green), In progress / Ordered / On site under way (purple). */
const STATUS_FILL: Readonly<Record<string, string>> = {
  Open: '#c62828',
  'In progress': '#6a1b9a',
  Closed: '#2e7d32',
  Needed: '#c62828',
  Ordered: '#6a1b9a',
  'On site': '#6a1b9a',
  Installed: '#2e7d32',
};

export function ItemEditor(props: ItemEditorProps) {
  const { store, editor, kind, id, levelId, reloadKey, onEdited } = props;
  const [view, setView] = useState<ItemView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadItem(store, kind, id, levelId).then(
      (v) => active && (v ? setView(v) : setError(kind === 'punch' ? 'This punch item is not on this iPad.' : 'This part is not on this iPad.')),
      (e: unknown) => active && setError(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, kind, id, levelId, reloadKey]);

  const run: Run = useCallback(
    (fn) => {
      if (!editor) return;
      setError(null);
      fn(editor).then(onEdited, (e: unknown) => {
        setError(e instanceof OpError ? e.message : `Not saved: ${String((e as Error)?.message ?? e)}`);
        console.warn('[store] item edit refused', e);
      });
    },
    [editor, onEdited],
  );

  if (!view) {
    return <View style={styles.loading}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}</View>;
  }
  const readOnly = !editor || view.deleted;
  const marks = (f: string) => [view.inReview.has(f) ? 'in review' : null, view.pending.has(f) ? '↑' : null].filter(Boolean).join(' ');
  const statusField = kind === 'punch' ? 'tracking_status' : 'part_status';
  const statuses: readonly string[] = kind === 'punch' ? vocab.TRACKING_STATUS : vocab.PART_STATUS;
  const statusLocked = readOnly || !!view.rule;
  const canJump = (j: JumpTarget | null): j is JumpTarget => !!j && (j.sameLevel || props.canOpenLevels);

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Pressable onPress={props.onBack} hitSlop={8} testID="item.back">
          <Text style={styles.back}>◀ {props.backLabel}</Text>
        </Pressable>
        <View style={styles.headLine}>
          <Text style={styles.headId}>{view.label === 'NEW' ? 'NEW' : `${kind === 'punch' ? 'Punch' : 'Part'} #${view.label}`}</Text>
          {view.levelCode ? <Text style={styles.muted}>Level {view.levelCode}</Text> : null}
          {view.deleted ? <Text style={[chipStyles.badge, chipStyles.badgeDeleted]}>DELETED</Text> : null}
        </View>
        <Text style={styles.title} testID="item.title">
          {view.title}
        </Text>
        <Text style={styles.muted} numberOfLines={2}>
          {[view.sub, view.deviceText].filter(Boolean).join(' · ')}
        </Text>
        {view.device ? (
          canJump(view.device.jump) ? (
            <Pressable onPress={() => props.onJump(view.device!.jump!)} style={styles.btn} testID="item.device">
              <Text style={styles.btnText}>
                {view.device.label}
                {view.device.jump.sameLevel ? '' : ' (another level)'} ▸
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.muted}>
              Device {view.device.label}
              {view.device.deleted ? ' (deleted)' : ''}
            </Text>
          )
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View style={[styles.section, view.inReview.has(statusField) && styles.review]}>
          <Text style={styles.label}>
            {kind === 'punch' ? 'Tracking status' : 'Part status'}
            {marks(statusField) ? <Text style={styles.marks}> {marks(statusField)}</Text> : null}
          </Text>
          <View style={styles.rowWrap}>
            {statuses.map((s) => {
              const on = view.status === s;
              const fill = STATUS_FILL[s] ?? '#1565c0';
              return (
                <Pressable
                  key={s}
                  disabled={statusLocked || on}
                  onPress={() =>
                    run((e) => (kind === 'punch' ? setTrackingStatus(e, view.id, s as vocab.TrackingStatus) : setPartStatus(e, view.id, s as vocab.PartStatus)))
                  }
                  style={[styles.statusBtn, on && { backgroundColor: fill, borderColor: fill }, statusLocked && !on && styles.off]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: statusLocked }}
                  testID={`item.status.${s}`}>
                  <Text style={[styles.statusText, on && styles.onText]}>
                    {on ? '✓ ' : ''}
                    {s}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {kind === 'punch' ? (
            <Text style={styles.muted} testID="item.dateClosed">
              {view.dateClosed ? `Date closed ${view.dateClosed}${marks('date_closed') ? ` ${marks('date_closed')}` : ''}` : 'Closing sets Date closed to today.'}
            </Text>
          ) : null}
          {view.rule ? (
            <Text style={styles.ruleNote} testID="item.rule">
              Kept by the rules (R3c): reads “all” while no device on the floor has its {view.rule.label} and “some” once some do, closes by itself when every
              device has one, and reopens when one is missing again.
            </Text>
          ) : null}
        </View>

        {view.rule ? (
          <View style={styles.section} testID="item.missing">
            <Text style={styles.label}>Waiting on</Text>
            {view.rule.all ? (
              <Text style={styles.muted} testID="item.missing.all">
                Every device on this floor that needs {ADDRESS_ARTICLE[view.rule.kind]}.
              </Text>
            ) : view.rule.missing.length === 0 ? (
              <Text style={styles.muted}>No device listed.</Text>
            ) : null}
            {view.rule.missing.map((g) => (
              <View key={g.levelCode ?? '-'} style={styles.missingGroup}>
                <Text style={styles.missingLevel}>{g.levelCode ? `Level ${g.levelCode} (${g.devices.length})` : `Not found on this iPad (${g.devices.length})`}</Text>
                <View style={styles.rowWrap}>
                  {g.devices.map((d) =>
                    canJump(d.jump) ? (
                      <Pressable key={d.label} onPress={() => props.onJump(d.jump!)} style={styles.link} testID={`item.missing.${d.label}`}>
                        <Text style={styles.linkText}>{d.label} ▸</Text>
                      </Pressable>
                    ) : (
                      <Text key={d.label} style={styles.unlinked}>
                        {d.label}
                      </Text>
                    ),
                  )}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        <View style={[styles.section, view.inReview.has('owner') && styles.review]}>
          <Text style={styles.label}>
            Owner
            {marks('owner') ? <Text style={styles.marks}> {marks('owner')}</Text> : null}
          </Text>
          <View style={styles.rowWrap}>
            {vocab.OWNER.map((o) => {
              const on = view.owner === o;
              return (
                <Pressable
                  key={o}
                  disabled={readOnly || on}
                  onPress={() => run((e) => setItemOwner(e, kind, view.id, o))}
                  style={[styles.statusBtn, on && styles.optionOn, readOnly && !on && styles.off]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: readOnly }}
                  testID={`item.owner.${o}`}>
                  <Text style={[styles.statusText, on && styles.onText]}>
                    {on ? '✓ ' : ''}
                    {o}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={[styles.section, view.inReview.has('notes') && styles.review]}>
          <NotesField
            value={view.notes}
            marks={marks('notes')}
            readOnly={readOnly}
            phrases={view.phrases}
            hint={view.rule ? 'The rules rewrite these Notes on each run.' : null}
            onCommit={(t) => run((e) => setItemNotes(e, kind, view.id, t))}
          />
        </View>

        <History history={view.history} names={props.names} />
      </ScrollView>
    </View>
  );
}

/** Notes: commits one op on blur or a chip, never while typing (as the end editor's Note). */
function NotesField(props: { value: string | null; marks: string; readOnly: boolean; phrases: readonly string[]; hint: string | null; onCommit: (t: string) => void }) {
  const [draft, setDraft] = useState(props.value ?? '');
  const [more, setMore] = useState(false);
  const focused = useRef(false);
  const typed = useRef(draft);
  const saved = useRef(props.value ?? '');
  const edit = (t: string) => {
    typed.current = t;
    setDraft(t);
  };
  useEffect(() => {
    saved.current = props.value ?? '';
    if (!focused.current) edit(props.value ?? '');
  }, [props.value]);
  const commit = (t: string) => {
    if (t.trim() === saved.current.trim()) return;
    saved.current = t.trim();
    props.onCommit(t);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(typed.current), []);
  const chips = more ? props.phrases : props.phrases.slice(0, CHIPS_SHOWN);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        Notes
        {props.marks ? <Text style={styles.marks}> {props.marks}</Text> : null}
      </Text>
      <TextInput
        style={[styles.input, styles.multi]}
        value={draft}
        editable={!props.readOnly}
        onChangeText={edit}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit(typed.current);
        }}
        placeholder="Notes"
        placeholderTextColor="#888"
        multiline
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
        testID="item.notes"
      />
      {props.hint ? <Text style={styles.muted}>{props.hint}</Text> : null}
      {!props.readOnly && chips.length ? (
        <View style={styles.rowWrap}>
          {chips.map((p) => (
            <Pressable
              key={p}
              style={styles.phrase}
              testID={`item.notes.chip.${p}`}
              onPress={() => {
                const next = appendPhrase(typed.current, p);
                edit(next);
                commit(next);
              }}>
              <Text style={styles.phraseText} numberOfLines={1}>
                {p}
              </Text>
            </Pressable>
          ))}
          {props.phrases.length > CHIPS_SHOWN ? (
            <Pressable style={styles.phrase} onPress={() => setMore((m) => !m)}>
              <Text style={styles.phraseMore}>{more ? 'less ▴' : `more (${props.phrases.length - CHIPS_SHOWN}) ▾`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function History({ history, names }: { history: HistoryEntry[]; names: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <View style={styles.section}>
      <Pressable onPress={() => setOpen((o) => !o)} hitSlop={4} testID="item.history">
        <Text style={styles.label}>
          {open ? '▾' : '▸'} History ({history.length})
        </Text>
      </Pressable>
      {open
        ? history.map((h) => {
            const t = new Date(h.at);
            const when = Number.isNaN(t.getTime()) ? h.at : `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
            return (
              <View key={h.opId} style={styles.hist}>
                <Text style={styles.histHead} numberOfLines={1}>
                  {when} {names.get(h.userId) ?? `user …${h.userId.slice(-4)}`} · {h.what}
                  {h.pending ? ' ↑' : ''}
                  {h.inReview ? ' · in review' : ''}
                </Text>
                {h.was !== null || h.now !== null ? (
                  <Text style={styles.histBody} numberOfLines={3}>
                    {h.was ?? ''} → {h.now ?? ''}
                  </Text>
                ) : null}
                <Text style={styles.histWhy} numberOfLines={2}>
                  {h.changeType}
                  {h.reason && h.reason !== h.changeType ? ` · "${h.reason}"` : ''}
                </Text>
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  scroll: { paddingBottom: 40 },
  head: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  back: { fontSize: 15, color: '#1565c0', fontWeight: '600' },
  headLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  headId: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  title: { fontSize: 15, fontWeight: '600', color: '#222' },
  error: { color: '#b71c1c', fontSize: 13, paddingHorizontal: 12, paddingVertical: 4 },
  muted: { fontSize: 12, color: '#777' },
  ruleNote: { fontSize: 12, color: '#5d4037' },
  section: { marginHorizontal: 8, marginTop: 8, padding: 10, gap: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de' },
  review: { borderColor: '#e65100', borderWidth: 2 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  statusBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  statusText: { fontSize: 13, color: '#222' },
  onText: { color: '#fff', fontWeight: '700' },
  optionOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  off: { opacity: 0.4 },
  field: { gap: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#444' },
  marks: { fontSize: 11, color: '#e65100', fontWeight: '400' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, backgroundColor: '#fff' },
  multi: { minHeight: 48, textAlignVertical: 'top' },
  phrase: { maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, backgroundColor: '#eef2f7' },
  phraseText: { fontSize: 12, color: '#1f3b63' },
  phraseMore: { fontSize: 12, color: '#1565c0', fontWeight: '600' },
  btn: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
  missingGroup: { gap: 4 },
  missingLevel: { fontSize: 12, fontWeight: '600', color: '#333' },
  link: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, backgroundColor: '#e3f2fd' },
  linkText: { fontSize: 12, color: '#1565c0', fontWeight: '600' },
  unlinked: { fontSize: 12, color: '#555', paddingHorizontal: 4 },
  hist: { paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#e0e0e0', gap: 1 },
  histHead: { fontSize: 12, fontWeight: '600', color: '#333' },
  histBody: { fontSize: 12, color: '#444' },
  histWhy: { fontSize: 11, color: '#777' },
});
