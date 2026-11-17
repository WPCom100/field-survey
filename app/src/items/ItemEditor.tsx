/**
 * Punch item / missing part editor (T162, D254) in the plan's side panel, opened from the device
 * card's Punch items / Missing parts rows or the plan's Punch / Parts tabs; ‹ goes back to where
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
import { useReload } from '../sync/useReload';
import { Btn, Chip, PanelHeader, color, fieldStyles, font, hit, radius, space, status as statusFills, tabular, tinted } from '../ui';
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
  /** "‹ 06M-02" back to the card, or "‹ Punch" / "‹ Parts" back to the list (`PanelHeader`, T191). */
  backLabel: string;
  onBack: () => void;
  onEdited: () => void;
  /** Open a device's card (the item's device, or one an R3c item waits for). */
  onJump: (t: JumpTarget) => void;
  canOpenLevels: boolean;
};

type Run = (fn: (e: Editor) => Promise<unknown>) => void;

/**
 * Fill per status, borrowed from the D64 device statuses: Open / Needed read as Issue (red), In
 * progress / Ordered / On site under way as Installed, untested (purple), Closed / Installed done
 * as Complete (green).
 */
const ISSUE = statusFills.style.Issue.fill;
const UNDER_WAY = statusFills.style['Installed, untested'].fill;
const DONE = statusFills.style.Complete.fill;
const STATUS_FILL: Readonly<Record<string, string>> = {
  Open: ISSUE,
  'In progress': UNDER_WAY,
  Closed: DONE,
  Needed: ISSUE,
  Ordered: UNDER_WAY,
  'On site': UNDER_WAY,
  Installed: DONE,
};

export function ItemEditor(props: ItemEditorProps) {
  const { store, editor, kind, id, levelId, reloadKey, onEdited } = props;
  const [view, setView] = useState<ItemView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // T185: an edit's reload is never thrown away by a pull or a rules run that lands during it
  useReload({
    name: 'item',
    subject: `${kind}|${id}|${levelId}`,
    reloadKey,
    load: () => loadItem(store, kind, id, levelId),
    apply: (v) => (v ? setView(v) : setError(kind === 'punch' ? 'This punch item is not on this iPad.' : 'This part is not on this iPad.')),
    fail: (e) => setError(String(e)),
  });

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
        <View style={styles.backRow}>
          <PanelHeader back={{ label: props.backLabel, onPress: props.onBack, testID: 'item.back' }} />
        </View>
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
            <Btn
              title={`${view.device.label}${view.device.jump.sameLevel ? '' : ' (another level)'} ▸`}
              small
              onPress={() => props.onJump(view.device!.jump!)}
              testID="item.device"
            />
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
              return (
                <Option
                  key={s}
                  label={s}
                  on={on}
                  fill={STATUS_FILL[s] ?? color.primary}
                  locked={statusLocked}
                  onPress={() =>
                    run((e) => (kind === 'punch' ? setTrackingStatus(e, view.id, s as vocab.TrackingStatus) : setPartStatus(e, view.id, s as vocab.PartStatus)))
                  }
                  testID={`item.status.${s}`}
                />
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
                      <Chip key={d.label} label={`${d.label} ▸`} small selected onPress={() => props.onJump(d.jump!)} testID={`item.missing.${d.label}`} />
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
                <Option key={o} label={o} on={on} fill={color.primary} locked={readOnly} onPress={() => run((e) => setItemOwner(e, kind, view.id, o))} testID={`item.owner.${o}`} />
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
        style={[styles.input, styles.multi, props.readOnly && fieldStyles.off]}
        value={draft}
        editable={!props.readOnly}
        onChangeText={edit}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit(typed.current);
        }}
        placeholder="Notes"
        placeholderTextColor={color.text3}
        multiline
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
        testID="item.notes"
      />
      {props.hint ? <Text style={styles.muted}>{props.hint}</Text> : null}
      {!props.readOnly && chips.length ? (
        <View style={styles.rowWrap}>
          {chips.map((p) => (
            <Chip
              key={p}
              label={p}
              small
              style={styles.phrase}
              testID={`item.notes.chip.${p}`}
              onPress={() => {
                const next = appendPhrase(typed.current, p);
                edit(next);
                commit(next);
              }}
            />
          ))}
          {props.phrases.length > CHIPS_SHOWN ? <Chip label={more ? 'less ▴' : `more (${props.phrases.length - CHIPS_SHOWN}) ▾`} small onPress={() => setMore((m) => !m)} /> : null}
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
      <Pressable onPress={() => setOpen((o) => !o)} hitSlop={4} style={styles.historyHead} testID="item.history">
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

/**
 * One choice of Tracking / Part status or Owner. The current one reads "✓ <value>" (what the flows
 * assert) in its colour over the pale tint, as the device card's status buttons (T175), and is the
 * disabled one.
 */
function Option({ label, on, fill, locked, onPress, testID }: { label: string; on: boolean; fill: string; locked: boolean; onPress: () => void; testID: string }) {
  const t = tinted(fill, color.text);
  return (
    <Pressable
      disabled={locked || on}
      onPress={onPress}
      style={({ pressed }) => [styles.statusBtn, on && { backgroundColor: t.bg, borderColor: fill, borderWidth: 1.5 }, pressed && styles.pressed, locked && !on && styles.off]}
      accessibilityRole="radio"
      accessibilityState={{ selected: on, disabled: locked }}
      testID={testID}>
      <Text style={[styles.statusText, on && { color: t.fg, fontWeight: '600' }]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  scroll: { paddingBottom: 40 },
  head: { paddingHorizontal: space.md, paddingTop: 10, paddingBottom: space.sm, gap: space.xs, borderBottomWidth: 1, borderBottomColor: color.hairline },
  // the panel's back sits at its top left, the chevron aligned with the text under it (T191)
  backRow: { marginLeft: -space.sm },
  headLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  headId: { ...font.headline, ...tabular, color: color.text },
  title: { ...font.calloutBold, color: color.text },
  error: { ...font.caption, color: color.danger, paddingHorizontal: space.md, paddingVertical: space.xs },
  muted: { ...font.caption, color: color.text3 },
  ruleNote: { ...font.caption, color: color.text2 },
  section: { marginHorizontal: space.sm, marginTop: space.sm, padding: 10, gap: 6, borderRadius: radius.card, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface },
  review: { borderColor: color.warning, borderWidth: 2 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  statusBtn: { minHeight: hit.small, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.control, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  statusText: { ...font.caption, color: color.text },
  pressed: { backgroundColor: color.surface2 },
  off: { opacity: 0.45 },
  field: { gap: space.xs },
  label: { ...font.captionBold, color: color.text2 },
  marks: { ...font.caption, color: color.warning },
  // the panel is 287 pt in portrait: 15-pt boxes rather than the 17-pt Field (as the end editor)
  input: { ...fieldStyles.input, minHeight: hit.small, paddingHorizontal: space.sm, paddingVertical: 6, ...font.callout },
  multi: { minHeight: 48, textAlignVertical: 'top' },
  phrase: { maxWidth: '100%' },
  missingGroup: { gap: space.xs },
  missingLevel: { ...font.captionBold, color: color.text2 },
  unlinked: { ...font.caption, color: color.text2, paddingHorizontal: space.xs },
  historyHead: { minHeight: hit.small, justifyContent: 'center' },
  hist: { paddingVertical: space.xs, borderTopWidth: 1, borderTopColor: color.hairline, gap: 1 },
  histHead: { ...font.captionBold, color: color.text2 },
  histBody: { ...font.caption, color: color.text },
  histWhy: { ...font.caption, color: color.text3 },
});
