/**
 * Connection end editor (T22, Phase 3 §4.5) in the plan's side panel: the cable with both ends
 * stacked — the end it was opened on first — each with status buttons, note (with phrase chips),
 * From / To text (D32) and who surveyed it; the riser label check; "Jump to" the far end's device
 * (on this level: select it; on another: open that level's plan with the pin lit). Every tap is
 * one op (D45), `Field survey` (D96). Each end shows the photos linked to it (D128, T65); its
 * 📷 Photo preselects that end in the caption sheet. ⋯ → Delete… removes the cable with both ends
 * (T138, a `Correction` with the typed reason); a deleted cable shows why and offers Restore….
 * Render with `key={endId}`.
 */

import { OpError, vocab, type Editor, type Store } from '@field-survey/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { appendPhrase, deleteCable, restoreCable } from '../card/actions';
import type { JumpTarget } from '../card/model';
import { PhotoStrip } from '../photo/PhotoStrip';
import { chipStyles } from '../plan/chips';
import { pinStyleFor } from '../plan/pins';
import { PlaceholderPicker } from '../vocab/PlaceholderPicker';
import { setCableTermKit, setEndNote, setEndPlaceholder, setEndStatus, setEndText } from './actions';
import { CABLE_NAME, loadCableEnds, type CableView, type EndView } from './model';

const CHIPS_SHOWN = 4;

export type EndEditorProps = {
  store: Store;
  editor: Editor | null;
  endId: string;
  reloadKey: unknown;
  names: ReadonlyMap<string, string>;
  /** "◀ 06M-02" back to the card, or "◀ Connections" back to the list. */
  backLabel: string;
  onBack: () => void;
  onEdited: () => void;
  onJump: (t: JumpTarget) => void;
  canOpenLevels: boolean;
  /** Photo of this end (T21), linked to the end and its device, on the end's level. */
  onPhoto?: (t: { endId: string; deviceId: string | null; levelId: string | null; title: string }) => void;
  /** Thumbnails of the end's photos and opening one (caption, links, markup). */
  resolveBlobUri?: (sha: string, kind: 'thumb' | 'image') => string | null;
  onOpenPhoto?: (photoId: string, title: string) => void;
  /** Below the riser check, inside the scroll (the cable view's riser crop and checks, T39). */
  footer?: ReactNode;
};

type Run = (fn: (e: Editor) => Promise<unknown>) => Promise<boolean>;

export function EndEditor(props: EndEditorProps) {
  const { store, editor, endId, reloadKey, onEdited } = props;
  const [view, setView] = useState<CableView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  /** The reason being typed for ⋯ → Delete… / Restore… (T138). */
  const [pending, setPending] = useState<{ kind: 'delete' | 'restore'; reason: string } | null>(null);

  useEffect(() => {
    let active = true;
    loadCableEnds(store, endId).then(
      (v) => active && (v ? setView(v) : setError('This connection is not on this iPad.')),
      (e: unknown) => active && setError(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, endId, reloadKey]);

  const run: Run = useCallback(
    async (fn) => {
      if (!editor) return false;
      try {
        setError(null);
        await fn(editor);
        onEdited();
        return true;
      } catch (e) {
        setError(e instanceof OpError ? e.message : `Not saved: ${String((e as Error)?.message ?? e)}`);
        console.warn('[store] end edit refused', e);
        return false;
      }
    },
    [editor, onEdited],
  );

  if (!view) {
    return <View style={styles.loading}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}</View>;
  }
  const [mine, other] = view.ends;
  const readOnly = !editor || view.deleted;
  const name = view.code ? CABLE_NAME[view.code] : null;
  const title = `${view.code ?? '?'} ${mine.label}`;
  const confirmPending = () => {
    if (!pending) return;
    const { kind, reason } = pending;
    void run((e) => (kind === 'delete' ? deleteCable(e, view.id, reason) : restoreCable(e, view.id, reason))).then((ok) => ok && setPending(null));
  };

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Pressable onPress={props.onBack} hitSlop={8} testID="end.back">
          <Text style={styles.back}>◀ {props.backLabel}</Text>
        </Pressable>
        <View style={styles.headLine}>
          <Text style={styles.headId}>{mine.label}</Text>
          <Text style={styles.headCable}>
            {view.code ?? '?'}
            {name && name !== view.code ? ` (${name})` : ''}
          </Text>
          {view.qty != null ? <Text style={styles.muted}>Qty {view.qty}</Text> : null}
          {view.singleRow ? <Text style={chipStyles.badgePlain}>1 row</Text> : null}
          {view.deleted ? <Text style={[chipStyles.badge, chipStyles.badgeDeleted]}>DELETED</Text> : null}
          <View style={styles.flex} />
          {editor ? (
            <Pressable onPress={() => setMenu((m) => !m)} hitSlop={8} style={styles.headBtn} accessibilityLabel="Connection menu">
              <Text style={styles.headBtnText}>⋯</Text>
            </Pressable>
          ) : null}
        </View>
        {view.vertical ? <Text style={styles.muted}>Vertical {view.vertical}</Text> : null}
      </View>
      {menu ? (
        <View style={styles.menu}>
          <Pressable style={styles.menuItem} onPress={() => (setMenu(false), setPending({ kind: view.deleted ? 'restore' : 'delete', reason: '' }))}>
            <Text style={[styles.menuText, !view.deleted && styles.danger]}>{view.deleted ? 'Restore connection…' : 'Delete connection…'}</Text>
          </Pressable>
        </View>
      ) : null}
      {pending ? (
        <View style={styles.reasonBox}>
          <Text style={styles.label}>
            {pending.kind === 'delete' ? `Delete ${title} with both ends: why?` : `Restore ${title}: why?`}
          </Text>
          <TextInput
            style={styles.input}
            value={pending.reason}
            onChangeText={(t) => setPending({ ...pending, reason: t })}
            placeholder="Reason (kept in the history)"
            placeholderTextColor="#888"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={confirmPending}
          />
          <View style={styles.rowWrap}>
            <Pressable
              disabled={!pending.reason.trim()}
              onPress={confirmPending}
              style={[styles.btn, pending.kind === 'delete' && styles.btnDanger, !pending.reason.trim() && styles.off]}>
              <Text style={[styles.btnText, pending.kind === 'delete' && styles.danger]}>{pending.kind === 'delete' ? 'Delete' : 'Restore'}</Text>
            </Pressable>
            <Pressable onPress={() => setPending(null)} style={styles.btn}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {view.deleted ? (
        <View style={styles.deleted}>
          <Text style={styles.deletedText}>Deleted{view.deleteReason ? `: ${view.deleteReason}` : ''}</Text>
          {editor && !pending ? (
            <Pressable onPress={() => setPending({ kind: 'restore', reason: '' })} style={styles.btn}>
              <Text style={styles.btnText}>Restore…</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <EndSection
          title="This end"
          side="this"
          end={mine}
          view={view}
          readOnly={readOnly}
          run={run}
          store={store}
          editor={editor}
          names={props.names}
          onJump={props.onJump}
          canOpenLevels={props.canOpenLevels}
          onPhoto={props.onPhoto}
          resolveBlobUri={props.resolveBlobUri}
          onOpenPhoto={props.onOpenPhoto}
        />
        {other ? (
          <EndSection
            title="Other end"
            side="other"
            end={other}
            view={view}
            readOnly={readOnly}
            run={run}
            store={store}
            editor={editor}
            names={props.names}
            onJump={props.onJump}
            canOpenLevels={props.canOpenLevels}
            onPhoto={props.onPhoto}
            resolveBlobUri={props.resolveBlobUri}
            onOpenPhoto={props.onOpenPhoto}
          />
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Other end</Text>
            <Text style={styles.muted}>Not recorded for this cable.</Text>
          </View>
        )}
        <TermKitSection view={view} readOnly={readOnly} run={run} />
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Riser check</Text>
          {view.riser.state === 'none' ? (
            <Text style={styles.muted}>No riser label for this cable.</Text>
          ) : view.riser.state === 'match' ? (
            <Text style={styles.ok}>Riser says To: “{view.riser.riser}” ✓ matches</Text>
          ) : (
            <>
              <Text style={styles.finding}>Riser says To: “{view.riser.riser}” ≠ To text</Text>
              <Text style={styles.muted}>The riser governs To (R2); correct the To text above if the riser is right.</Text>
            </>
          )}
        </View>
        {props.footer}
      </ScrollView>
    </View>
  );
}

/**
 * Termination kits (T103, D213): whether this cable gets a kit part at each device end. "As <code>"
 * follows the project's Rules setting for the code; Yes / No set this cable alone.
 */
function TermKitSection({ view, readOnly, run }: { view: CableView; readOnly: boolean; run: Run }) {
  const { own, code, takes } = view.termKit;
  const options: { value: boolean | null; label: string }[] = [
    { value: null, label: `As ${view.code ?? 'its code'} (${code ? 'yes' : 'no'})` },
    { value: true, label: 'Yes' },
    { value: false, label: 'No' },
  ];
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Termination kits</Text>
      <View style={styles.rowWrap}>
        {options.map((o) => {
          const on = own === o.value;
          return (
            <Pressable
              key={String(o.value)}
              disabled={readOnly || on}
              onPress={() => void run((e) => setCableTermKit(e, view.id, o.value))}
              style={[styles.statusBtn, on && styles.optionOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: readOnly }}
            >
              <Text style={[styles.statusText, on && styles.optionOnText]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.muted}>
        {takes
          ? 'A kit part at each device end: once the Run item is accepted, or the kit item of an end Issue “no term kit”.'
          : 'No kit items or kit parts for this cable.'}
      </Text>
    </View>
  );
}

function fmt(at: string | null): string {
  if (!at) return '';
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return at;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}/${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

function EndSection(props: {
  title: string;
  /** `testID` prefix: `end.this.*` / `end.other.*` (Maestro, T155). */
  side: 'this' | 'other';
  end: EndView;
  view: CableView;
  readOnly: boolean;
  run: Run;
  store: Store;
  editor: Editor | null;
  names: ReadonlyMap<string, string>;
  onJump: (t: JumpTarget) => void;
  canOpenLevels: boolean;
  onPhoto?: EndEditorProps['onPhoto'];
  resolveBlobUri?: EndEditorProps['resolveBlobUri'];
  onOpenPhoto?: EndEditorProps['onOpenPhoto'];
}) {
  const { end, view, run } = props;
  const ep = end.endpoint;
  // a draft's end is surveyed once its device is placed (D235; R5: far-end items wait)
  const readOnly = props.readOnly || end.deleted || ep.kind === 'draft';
  const who = end.surveyedBy ? (props.names.get(end.surveyedBy) ?? `user …${end.surveyedBy.slice(-4)}`) : null;
  const review = (f: string) => end.inReview.has(f);
  const marks = (f: string) => [review(f) ? 'in review' : null, end.pending.has(f) ? '↑' : null].filter(Boolean).join(' ');
  const where = ep.kind === 'device' ? `${ep.label}${ep.model ? ` ${ep.model}` : ''}` : ep.kind === 'placeholder' || ep.kind === 'draft' ? ep.label : '(no endpoint)';
  const level = end.levelCode ? ` (Level ${end.levelCode})` : '';
  const [picking, setPicking] = useState(false);
  const canPick = !readOnly && !!props.editor && ep.kind !== 'device';
  const canJump = !!end.jump && (end.jump.sameLevel || props.canOpenLevels);

  return (
    <View style={[styles.section, (review('status') || review('note')) && styles.review]}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle} numberOfLines={2}>
          {props.title}: {where}
          {level}
        </Text>
        <Text style={styles.endLabel}>{end.label}</Text>
      </View>
      {ep.kind === 'draft' ? <Text style={styles.muted}>Its device is not on the plan yet: place the draft (Setup → Place devices), then survey this end.</Text> : null}
      {canPick && !picking ? (
        <Pressable onPress={() => setPicking(true)} style={styles.btn} testID={`end.${props.side}.placeholder`}>
          <Text style={styles.btnText}>{ep.kind === 'placeholder' ? 'Change placeholder…' : 'Choose placeholder…'}</Text>
        </Pressable>
      ) : null}
      {canPick && picking ? (
        <PlaceholderPicker
          store={props.store}
          editor={props.editor!}
          currentLabel={ep.kind === 'placeholder' ? ep.label : null}
          onPick={(id) => run((e) => setEndPlaceholder(e, end.id, id))}
          onClose={() => setPicking(false)}
        />
      ) : null}
      <View style={styles.rowWrap}>
        {vocab.CONNECTION_STATUS.map((s) => {
          const on = end.status === s;
          const st = pinStyleFor(s);
          return (
            <Pressable
              key={s}
              disabled={readOnly}
              onPress={() => !(on && end.statusSource === 'surveyed') && run((e) => setEndStatus(e, end.id, s))}
              testID={`end.${props.side}.status.${s}`}
              style={[styles.statusBtn, on && (st.hollow ? { borderColor: st.fill, borderWidth: 2 } : { backgroundColor: st.fill, borderColor: st.fill })]}>
              <Text style={[styles.statusText, on && { color: st.hollow ? st.fill : '#fff', fontWeight: '700' }]}>
                {on ? '✓ ' : ''}
                {s}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.muted}>
        {end.status ? '' : 'No status yet · '}
        {end.statusSource === 'copied' ? 'copied from the other end (R2f) · ' : end.statusSource === 'derived' ? 'derived · ' : ''}
        {who ? `surveyed by ${who} ${fmt(end.surveyedAt)}` : 'not surveyed'}
        {marks('status') ? ` · ${marks('status')}` : ''}
      </Text>
      <TextField
        label="Note"
        value={end.note}
        marks={marks('note')}
        review={review('note')}
        readOnly={readOnly}
        multiline
        testID={`end.${props.side}.note`}
        phrases={view.phrases}
        onCommit={(t) => run((e) => setEndNote(e, end.id, t))}
      />
      {end.photos.length && props.resolveBlobUri ? (
        <>
          <Text style={styles.muted}>Photos ({end.photos.length})</Text>
          <PhotoStrip
            photos={end.photos}
            resolveBlobUri={props.resolveBlobUri}
            onOpen={props.onOpenPhoto ? (id) => props.onOpenPhoto!(id, `${end.label} ${view.code ?? ''}`.trim()) : undefined}
          />
        </>
      ) : null}
      <TextField label="From" value={end.fromText} marks={marks('from_text')} review={review('from_text')} readOnly={readOnly} onCommit={(t) => run((e) => setEndText(e, end.id, 'from_text', t))} />
      <TextField label="To" value={end.toText} marks={marks('to_text')} review={review('to_text')} readOnly={readOnly} onCommit={(t) => run((e) => setEndText(e, end.id, 'to_text', t))} />
      <View style={styles.rowWrap}>
        {end.jump && canJump ? (
          <Pressable onPress={() => props.onJump(end.jump!)} style={styles.btn} testID={`end.${props.side}.jump`}>
            <Text style={styles.btnText}>
              Jump to {end.jump.label}
              {end.jump.sameLevel ? '' : ` (Level ${ep.kind === 'device' ? ep.levelCode : '?'})`} ▸
            </Text>
          </Pressable>
        ) : null}
        {props.onPhoto && !readOnly ? (
          <Pressable
            onPress={() =>
              props.onPhoto!({
                endId: end.id,
                deviceId: ep.kind === 'device' ? ep.deviceId : null,
                levelId: end.levelId,
                title: `${end.label} ${view.code ?? ''}`.trim(),
              })
            }
            style={styles.btn}>
            <Text style={styles.btnText}>📷 Photo</Text>
          </Pressable>
        ) : null}
        {ep.kind === 'device' && ep.deleted ? <Text style={styles.finding}>The device at this end is deleted.</Text> : null}
      </View>
    </View>
  );
}

/** A text box that commits one op on blur (or a phrase chip), never while typing. */
function TextField(props: {
  label: string;
  value: string | null;
  marks: string;
  review: boolean;
  readOnly: boolean;
  multiline?: boolean;
  phrases?: readonly string[];
  onCommit: (text: string) => void;
  /** The box's `testID`; its chips are `<testID>.chip.<phrase>`. */
  testID?: string;
}) {
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

  const chips = props.phrases ? (more ? props.phrases : props.phrases.slice(0, CHIPS_SHOWN)) : [];
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {props.label}
        {props.marks ? <Text style={styles.marks}> {props.marks}</Text> : null}
      </Text>
      <TextInput
        style={[styles.input, props.multiline && styles.multi, props.review && styles.review]}
        value={draft}
        editable={!props.readOnly}
        onChangeText={edit}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit(typed.current);
        }}
        placeholder={props.label}
        placeholderTextColor="#888"
        multiline={props.multiline}
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
        testID={props.testID}
      />
      {!props.readOnly && chips.length ? (
        <View style={styles.rowWrap}>
          {chips.map((p) => (
            <Pressable
              key={p}
              style={styles.phrase}
              testID={props.testID ? `${props.testID}.chip.${p}` : undefined}
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
          {props.phrases!.length > CHIPS_SHOWN ? (
            <Pressable style={styles.phrase} onPress={() => setMore((m) => !m)} testID={props.testID ? `${props.testID}.more` : undefined}>
              <Text style={styles.phraseMore}>{more ? 'less ▴' : `more (${props.phrases!.length - CHIPS_SHOWN}) ▾`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
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
  headId: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headCable: { fontSize: 16, fontWeight: '600', color: '#222' },
  endLabel: { fontSize: 13, fontWeight: '700', color: '#555' },
  error: { color: '#b71c1c', fontSize: 13, paddingHorizontal: 12, paddingVertical: 4 },
  muted: { fontSize: 12, color: '#777' },
  ok: { fontSize: 13, color: '#2e7d32', fontWeight: '600' },
  finding: { fontSize: 13, color: '#e65100' },
  section: { marginHorizontal: 8, marginTop: 8, padding: 10, gap: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de' },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  sectionTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: '#333' },
  review: { borderColor: '#e65100', borderWidth: 2 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  statusBtn: { paddingHorizontal: 8, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  statusText: { fontSize: 12, color: '#222' },
  optionOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  optionOnText: { color: '#fff', fontWeight: '600' },
  field: { gap: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#444' },
  marks: { fontSize: 11, color: '#e65100', fontWeight: '400' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, backgroundColor: '#fff' },
  multi: { minHeight: 48, textAlignVertical: 'top' },
  phrase: { maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, backgroundColor: '#eef2f7' },
  phraseText: { fontSize: 12, color: '#1f3b63' },
  phraseMore: { fontSize: 12, color: '#1565c0', fontWeight: '600' },
  btn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
  btnDanger: { borderColor: '#b71c1c' },
  danger: { color: '#b71c1c' },
  off: { opacity: 0.4 },
  headBtn: { paddingHorizontal: 8, paddingVertical: 2 },
  headBtnText: { fontSize: 22, color: '#1565c0', fontWeight: '600' },
  menu: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1', backgroundColor: '#f8f9fb' },
  menuItem: { paddingHorizontal: 14, paddingVertical: 10 },
  menuText: { fontSize: 15, color: '#1565c0' },
  reasonBox: { padding: 12, gap: 6, backgroundColor: '#fff8e1', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  deleted: { margin: 8, padding: 10, borderRadius: 6, backgroundColor: '#ffebee', gap: 6, alignItems: 'flex-start' },
  deletedText: { color: '#b71c1c', fontWeight: '600' },
});
