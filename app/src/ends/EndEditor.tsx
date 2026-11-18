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
import { useReload } from '../sync/useReload';
import { Btn, Chip, FormActions, PanelHeader, color, fieldStyles, font, hit, hitSlopTo, radius, space, tabular, tinted } from '../ui';
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
  /** "‹ 06M-02" back to the card, "‹ Connections" back to the list, "‹ Cables" on Cable / riser (`PanelHeader`, T191). */
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

  // T185: an edit's reload is never thrown away by a pull or a rules run that lands during it
  useReload({
    name: 'end',
    subject: endId,
    reloadKey,
    load: () => loadCableEnds(store, endId),
    apply: (v) => (v ? setView(v) : setError('This connection is not on this iPad.')),
    fail: (e) => setError(String(e)),
  });

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
        <View style={styles.backRow}>
          <PanelHeader back={{ label: props.backLabel, onPress: props.onBack, testID: 'end.back' }} />
        </View>
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
            <Pressable
              onPress={() => setMenu((m) => !m)}
              hitSlop={hitSlopTo(hit.small)}
              style={({ pressed }) => [styles.headBtn, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Connection menu"
              testID="end.menu">
              <Text style={styles.headBtnText}>⋯</Text>
            </Pressable>
          ) : null}
        </View>
        {view.vertical ? <Text style={styles.muted}>Vertical {view.vertical}</Text> : null}
      </View>
      {menu ? (
        <View style={styles.menu}>
          <Pressable style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]} accessibilityRole="menuitem" onPress={() => (setMenu(false), setPending({ kind: view.deleted ? 'restore' : 'delete', reason: '' }))} testID="end.menu.delete">
            <Text style={[styles.menuText, !view.deleted && styles.danger]}>{view.deleted ? 'Restore connection…' : 'Delete connection…'}</Text>
          </Pressable>
        </View>
      ) : null}
      {pending ? (
        <View style={styles.reasonBox}>
          <Text style={styles.reasonQuestion}>
            {pending.kind === 'delete' ? `Delete ${title} with both ends: why?` : `Restore ${title}: why?`}
          </Text>
          <TextInput
            style={fieldStyles.input}
            value={pending.reason}
            onChangeText={(t) => setPending({ ...pending, reason: t })}
            placeholder="Reason"
            placeholderTextColor={color.text3}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={confirmPending}
            testID="end.reason"
          />
          <FormActions>
            <Btn title="Cancel" small onPress={() => setPending(null)} />
            <Btn
              title={pending.kind === 'delete' ? 'Delete' : 'Restore'}
              kind={pending.kind === 'delete' ? 'destructive' : 'primary'}
              small
              disabled={!pending.reason.trim()}
              onPress={confirmPending}
              testID="end.reason.ok"
            />
          </FormActions>
        </View>
      ) : null}
      {view.deleted ? (
        <View style={styles.deleted}>
          <Text style={styles.deletedText}>Deleted{view.deleteReason ? `: ${view.deleteReason}` : ''}</Text>
          {editor && !pending ? <Btn title="Restore…" small onPress={() => setPending({ kind: 'restore', reason: '' })} testID="end.restore" /> : null}
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
            <Text style={styles.finding}>Riser says To: “{view.riser.riser}” ≠ To text</Text>
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
  const { own, code } = view.termKit;
  const options: { value: boolean | null; label: string; id: string }[] = [
    { value: null, label: `As ${view.code ?? 'its code'} (${code ? 'yes' : 'no'})`, id: 'as' },
    { value: true, label: 'Yes', id: 'yes' },
    { value: false, label: 'No', id: 'no' },
  ];
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Termination kits</Text>
      <View style={styles.rowWrap}>
        {options.map((o) => {
          const on = own === o.value;
          return (
            <Chip
              key={String(o.value)}
              label={o.label}
              small
              selected={on}
              // the selected option is the disabled one (`_rules-kits` asserts it), drawn at full strength
              disabled={readOnly || on}
              style={on && !readOnly ? styles.fullStrength : undefined}
              onPress={() => void run((e) => setCableTermKit(e, view.id, o.value))}
              testID={`end.termkit.${o.id}`}
            />
          );
        })}
      </View>
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
      {ep.kind === 'draft' ? <Text style={styles.muted}>Its device is not on the plan yet.</Text> : null}
      {canPick && !picking ? (
        <Btn title={ep.kind === 'placeholder' ? 'Change placeholder…' : 'Choose placeholder…'} small onPress={() => setPicking(true)} testID={`end.${props.side}.placeholder`} />
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
          // as the device card's status buttons (T175): the status colour as border and text over its pale tint
          const t = tinted(st.fill, color.text);
          return (
            <Pressable
              key={s}
              disabled={readOnly}
              onPress={() => !(on && end.statusSource === 'surveyed') && run((e) => setEndStatus(e, end.id, s))}
              testID={`end.${props.side}.status.${s}`}
              style={({ pressed }) => [
                styles.statusBtn,
                on && { borderColor: st.fill, borderWidth: 1.5, backgroundColor: t.bg },
                pressed && !on && styles.pressed,
                readOnly && !on && styles.off,
              ]}>
              <Text style={[styles.statusText, on && { color: t.fg, fontWeight: '600' }]}>
                {on ? '✓ ' : ''}
                {s}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.muted}>
        {end.status ? '' : 'No status yet · '}
        {end.statusSource === 'copied' ? 'copied from the other end · ' : end.statusSource === 'derived' ? 'derived · ' : ''}
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
          <Btn
            title={`Jump to ${end.jump.label}${end.jump.sameLevel ? '' : ` (Level ${ep.kind === 'device' ? ep.levelCode : '?'})`} ▸`}
            small
            onPress={() => props.onJump(end.jump!)}
            testID={`end.${props.side}.jump`}
          />
        ) : null}
        {props.onPhoto && !readOnly ? (
          <Btn
            title="📷 Photo"
            small
            onPress={() =>
              props.onPhoto!({
                endId: end.id,
                deviceId: ep.kind === 'device' ? ep.deviceId : null,
                levelId: end.levelId,
                title: `${end.label} ${view.code ?? ''}`.trim(),
              })
            }
          />
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
        style={[styles.input, props.multiline && styles.multi, props.review && styles.reviewInput, props.readOnly && fieldStyles.off]}
        value={draft}
        editable={!props.readOnly}
        onChangeText={edit}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit(typed.current);
        }}
        placeholder={props.label}
        placeholderTextColor={color.text3}
        multiline={props.multiline}
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
        testID={props.testID}
      />
      {!props.readOnly && chips.length ? (
        <View style={styles.rowWrap}>
          {chips.map((p) => (
            <Chip
              key={p}
              label={p}
              small
              style={styles.phrase}
              testID={props.testID ? `${props.testID}.chip.${p}` : undefined}
              onPress={() => {
                const next = appendPhrase(typed.current, p);
                edit(next);
                commit(next);
              }}
            />
          ))}
          {props.phrases!.length > CHIPS_SHOWN ? (
            <Chip
              label={more ? 'less ▴' : `more (${props.phrases!.length - CHIPS_SHOWN}) ▾`}
              small
              onPress={() => setMore((m) => !m)}
              testID={props.testID ? `${props.testID}.more` : undefined}
            />
          ) : null}
        </View>
      ) : null}
    </View>
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
  headCable: { ...font.callout, color: color.text },
  endLabel: { ...font.captionBold, ...tabular, color: color.text2 },
  error: { ...font.caption, color: color.danger, paddingHorizontal: space.md, paddingVertical: space.xs },
  muted: { ...font.caption, color: color.text3 },
  ok: { ...font.captionBold, color: color.success },
  finding: { ...font.caption, color: color.warning },
  section: { marginHorizontal: space.sm, marginTop: space.sm, padding: 10, gap: 6, borderRadius: radius.card, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm },
  sectionTitle: { flex: 1, ...font.calloutBold, color: color.text },
  review: { borderColor: color.warning, borderWidth: 2 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  statusBtn: { minHeight: hit.small, justifyContent: 'center', paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.control, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  statusText: { ...font.caption, color: color.text },
  pressed: { backgroundColor: color.surface2 },
  off: { opacity: 0.45 },
  fullStrength: { opacity: 1 },
  field: { gap: space.xs },
  label: { ...font.captionBold, color: color.text2 },
  marks: { ...font.caption, color: color.warning },
  // the panel is 287 pt in portrait: the editor keeps its 15-pt boxes rather than the 17-pt Field
  input: { ...fieldStyles.input, minHeight: hit.small, paddingHorizontal: space.sm, paddingVertical: 6, ...font.callout },
  multi: { minHeight: 48, textAlignVertical: 'top' },
  reviewInput: { borderColor: color.warning, borderWidth: 2 },
  phrase: { maxWidth: '100%' },
  headBtn: { width: hit.target, height: hit.small, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  headBtnText: { fontSize: 22, lineHeight: 26, color: color.text2, fontWeight: '600' },
  menu: { borderBottomWidth: 1, borderBottomColor: color.hairline, backgroundColor: color.surface },
  menuItem: { minHeight: hit.target, justifyContent: 'center', paddingHorizontal: space.lg },
  menuText: { ...font.callout, color: color.primary },
  danger: { color: color.danger },
  reasonBox: { padding: space.md, gap: space.sm, backgroundColor: color.warningTint, borderBottomWidth: 1, borderBottomColor: color.hairline },
  reasonQuestion: { ...font.captionBold, color: color.warning },
  deleted: { margin: space.sm, padding: 10, borderRadius: radius.control, backgroundColor: color.dangerTint, gap: 6, alignItems: 'flex-start' },
  deletedText: { ...font.calloutBold, color: color.danger },
});
