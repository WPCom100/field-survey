import { Editor, LIBRARY_STREAM, OpError, ROLE, ROLE_LABEL, type Role, type Store } from '@field-survey/core';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { SectionScreen } from '../home/SectionScreen';
import { useCurrentUser } from '../identity/IdentityGate';
import { PIN_SHAPE_LABEL, PIN_SHAPE_NAMES, type PinShapeMap } from '../plan/pins';
import { useRulesVersion } from '../rules/useRulesVersion';
import { projectDataKey } from '../sync/dataKey';
import { useReload } from '../sync/useReload';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Banner, Btn, Chip, FilterRow, PAGE_GUTTER, color, fieldStyles, font, radius, space } from '../ui';
import {
  acceptValue,
  addPair,
  addPlaceholder,
  addValue,
  copyAppVocab,
  editPlaceholder,
  listsOf,
  loadPairs,
  loadPlaceholders,
  loadStandard,
  loadVocab,
  promoteValue,
  removePlaceholder,
  removeValue,
  renameValue,
  type PlaceholderEntry,
  type VocabEntry,
  type VocabPairView,
  type VocabView,
} from '../vocab/model';
import { loadPinShapes, setPinShape, sharedShapes } from '../vocab/pinShapes';
import { PLACEHOLDER_KIND_LABEL, VOCAB_PAIR_LISTS, type PlaceholderKind, type VocabListKey, type VocabPairListKey } from '../vocab/seed';

type Tab = 'lists' | 'pairs' | 'shapes' | 'placeholders';
type Scope = 'project' | 'app';
const KINDS = Object.keys(PLACEHOLDER_KIND_LABEL) as PlaceholderKind[];
const TAB_LABEL: Record<Tab, string> = { lists: 'Lists', pairs: 'Model map & levels', shapes: 'Pin shapes', placeholders: 'Placeholders' };

/**
 * Vocabulary (T40, T104; PLAN §2.2, D26, D182, D187, D214): the picker lists (notes, punch
 * items, photo captions, device types, categories, cable codes), the BOM's model map and level
 * aliases (canonical / variant pairs), the pin shape per role and the placeholder endpoints. Two
 * scopes: **This project** (a new value is a draft, usable at once) and **App library** (drafts
 * for Landry; new projects copy the accepted ones). Pin shapes, device categories and cable codes
 * are the app library's only and apply to every project at once (D214, T197, D292 (9)): This
 * project does not list the last two. `?project=` names the project.
 */
export default function VocabularyScreen() {
  const params = useLocalSearchParams<{ project?: string; tab?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // this project's and the app library's pulls, this project's rules runs (T185, T186)
  const dataKey = projectDataKey(sync, projectId);
  const rulesKey = useRulesVersion(projectId);
  const [scope, setScope] = useState<Scope>('project');
  const [tab, setTab] = useState<Tab>(params.tab === 'placeholders' ? 'placeholders' : 'lists');
  const [lists, setLists] = useState<VocabView | null>(null);
  const [pairs, setPairs] = useState<VocabPairView | null>(null);
  const [shapes, setShapes] = useState<PinShapeMap | null>(null);
  const [placeholders, setPlaceholders] = useState<PlaceholderEntry[]>([]);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        setProjectId(pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setNote(String(e)),
    );
  }, [params.project]);
  useFocusEffect(useCallback(() => setTick((n) => n + 1), []));

  const app = scope === 'app';
  const scopeId = app ? null : projectId;
  // T186: a pull or a rules run during a load no longer throws it away (useReload)
  useReload({
    name: 'vocabulary',
    subject: store && (app || projectId) ? `${scope}|${projectId ?? ''}` : null,
    reloadKey: `${tick}|${dataKey}|${rulesKey}`,
    load: () =>
      Promise.all([loadVocab(store!, scopeId), loadPairs(store!, scopeId), loadPinShapes(store!), projectId ? loadPlaceholders(store!, projectId) : Promise.resolve([])]),
    apply: ([v, p, sh, ph]) => {
      setLists(v);
      setPairs(p);
      setShapes(sh);
      setPlaceholders(ph);
    },
    fail: (e) => setNote(String(e)),
  });

  const projectEditor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);
  const libraryEditor = useMemo(() => (store ? new Editor(store, { projectId: LIBRARY_STREAM, userId: user.id }) : null), [store, user.id]);
  const editor = app ? libraryEditor : projectEditor;

  const run = useCallback(
    async (fn: (e: Editor, s: Store) => Promise<unknown>, on: Editor | null = editor) => {
      if (!on || !store) return false;
      // clear before, not after: an action's own line ("Added n values …", "Promoted …") stays
      // (T154: cleared after, it never showed)
      setNote('');
      try {
        await fn(on, store);
        setTick((n) => n + 1);
        return true;
      } catch (e) {
        setNote(e instanceof OpError ? e.message : String(e));
        return false;
      }
    },
    [editor, store],
  );
  const promote = useMemo<PromoteFn | null>(
    () => (app || !libraryEditor ? null : (id) => run(async (e, s) => setNote(`Promoted ${await promoteValue(e, s, id)} value(s) to the app library as drafts.`), libraryEditor)),
    [app, libraryEditor, run],
  );

  const drafts = (lists ? listsOf(scope).flatMap((l) => lists[l.list]) : []).filter((e) => e.draft).length;
  const pairDrafts = (pairs ? Object.values(pairs).flat().flatMap((p) => [p, ...p.variants]) : []).filter((e) => e.draft).length;
  const tabs: Tab[] = app ? ['lists', 'pairs', 'shapes'] : ['lists', 'pairs', 'shapes', 'placeholders'];
  const shown = tabs.includes(tab) ? tab : 'lists';
  const tabText = (t: Tab) => {
    const n = t === 'lists' ? drafts : t === 'pairs' ? pairDrafts : 0;
    return t === 'placeholders' ? `${TAB_LABEL[t]} · ${placeholders.length}` : `${TAB_LABEL[t]}${n ? ` · ${n} draft${n === 1 ? '' : 's'}` : ''}`;
  };

  return (
    <SectionScreen
      section="Vocabulary"
      projectId={projectId}
      title="Vocabulary"
      backTestID="vocab.back"
      actions={
          <>
            {!app ? (
              <Btn
                title="Copy from app library"
                disabled={!editor || !projectId}
                onPress={() =>
                  run(async (e, s) => {
                    const n = await copyAppVocab(e, s, projectId!);
                    setNote(n ? `Copied ${n} value${n === 1 ? '' : 's'} from the app library.` : 'This project already has every accepted app value.');
                  })
                }
              />
            ) : null}
            <Btn
              kind="primary"
              title="Load standard lists"
              disabled={!editor}
              onPress={() =>
                run(async (e, s) => {
                  const n = await loadStandard(e, s);
                  const what = app ? `${n.values} draft${n.values === 1 ? '' : 's'} to the app library` : `${n.values} value${n.values === 1 ? '' : 's'} and ${n.placeholders} placeholder${n.placeholders === 1 ? '' : 's'}`;
                  setNote(n.values || n.placeholders ? `Added ${what}.` : 'Everything standard is already here.');
                })
              }
              testID="vocab.loadStandard"
            />
          </>
      }
    >
      <FilterRow>
        {(['project', 'app'] as const).map((s) => (
          <Chip key={s} small selected={scope === s} onPress={() => setScope(s)} label={s === 'project' ? 'This project' : 'App library'} testID={`vocab.scope.${s}`} />
        ))}
      </FilterRow>
      <FilterRow style={styles.tabs}>
        {tabs.map((t) => (
          <Chip key={t} selected={shown === t} onPress={() => setTab(t)} label={tabText(t)} testID={`vocab.tab.${t}`} />
        ))}
      </FilterRow>
      {note ? <Banner text={note} testID="vocab.note" style={styles.note} /> : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {shown === 'lists'
          ? listsOf(scope).map((l) => <ListSection key={`${scope}-${l.list}`} list={l.list} title={l.title} hint={l.hint} entries={lists?.[l.list] ?? []} canEdit={!!editor} run={run} promote={promote} />)
          : shown === 'pairs'
            ? VOCAB_PAIR_LISTS.map((l) => <PairSection key={`${scope}-${l.list}`} spec={l} pairs={pairs?.[l.list] ?? []} canEdit={!!editor} run={run} promote={promote} />)
            : shown === 'shapes'
              ? <PinShapes shapes={shapes} canEdit={!!libraryEditor} run={(fn) => run(fn, libraryEditor)} />
              : <Placeholders items={placeholders} canEdit={!!projectEditor} run={run} />}
      </ScrollView>
    </SectionScreen>
  );
}

type RunFn = (fn: (e: Editor, s: Store) => Promise<unknown>) => Promise<boolean>;
type PromoteFn = (id: string) => Promise<boolean>;

/** One value's row: text with the draft badge, then Accept / Edit / Promote / Remove. */
function ValueRow(props: { e: VocabEntry; canEdit: boolean; run: RunFn; promote: PromoteFn | null; prefix?: string }) {
  const { e, run } = props;
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    return (
      <View style={styles.row}>
        <TextInput value={editing} onChangeText={setEditing} style={[styles.input, styles.grow]} autoFocus testID="vocab.rename.input" />
        <Btn title="Cancel" onPress={() => setEditing(null)} />
        <Btn kind="primary" title="Save" onPress={async () => (await run((ed, s) => renameValue(ed, s, e.id, editing))) && setEditing(null)} testID="vocab.rename.save" />
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={[styles.value, styles.grow]} testID={`vocab.value.${e.value}`}>
        {props.prefix ?? ''}
        {e.value}
        {e.draft ? <Text style={styles.draft}>  draft</Text> : null}
      </Text>
      {props.canEdit ? (
        <>
          {e.draft ? (
            <Pressable onPress={() => run((ed, s) => acceptValue(ed, e.id, s))} hitSlop={space.md} testID={`vocab.accept.${e.value}`}>
              <Text style={styles.link}>Accept</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setEditing(e.value)} hitSlop={space.md} testID={`vocab.edit.${e.value}`}>
            <Text style={styles.link}>Edit</Text>
          </Pressable>
          {props.promote && !e.draft ? (
            <Pressable onPress={() => props.promote!(e.id)} hitSlop={space.md}>
              <Text style={styles.link}>Promote</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => run((ed, s) => removeValue(ed, e.id, s))} hitSlop={space.md} testID={`vocab.remove.${e.value}`}>
            <Text style={styles.danger}>Remove</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function ListSection(props: { list: VocabListKey; title: string; hint: string; entries: VocabEntry[]; canEdit: boolean; run: RunFn; promote: PromoteFn | null }) {
  const { list, run } = props;
  const [text, setText] = useState('');
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {props.title} <Text style={styles.sub}>({props.entries.length})</Text>
      </Text>
      <Text style={styles.sub}>{props.hint}</Text>
      {props.entries.map((e) => (
        <ValueRow key={e.id} e={e} canEdit={props.canEdit} run={run} promote={props.promote} />
      ))}
      {props.canEdit ? (
        <View style={styles.row}>
          <TextInput value={text} onChangeText={setText} placeholder="Add a value" placeholderTextColor={color.text3} style={[styles.input, styles.grow]} testID={`vocab.add.${list}.input`} />
          <Btn kind="primary" title="Add" disabled={!text.trim()} onPress={async () => (await run((ed, s) => addValue(ed, s, list, text))) && setText('')} testID={`vocab.add.${list}`} />
        </View>
      ) : null}
    </View>
  );
}

/** A canonical / variant list (D187): each canonical with its spellings, and an add-pair row. */
function PairSection(props: { spec: (typeof VOCAB_PAIR_LISTS)[number]; pairs: VocabPairView[VocabPairListKey]; canEdit: boolean; run: RunFn; promote: PromoteFn | null }) {
  const { spec, run } = props;
  const [raw, setRaw] = useState('');
  const [canonical, setCanonical] = useState('');
  const ready = !!raw.trim() && !!canonical.trim();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {spec.title} <Text style={styles.sub}>({props.pairs.reduce((n, p) => n + p.variants.length, 0)} spellings)</Text>
      </Text>
      <Text style={styles.sub}>{spec.hint}</Text>
      {props.pairs.map((p) => (
        <View key={p.id} style={styles.group}>
          <ValueRow e={p} canEdit={props.canEdit} run={run} promote={props.promote} prefix={`${spec.canonical}: `} />
          {p.variants.map((v) => (
            <View key={v.id} style={styles.indent}>
              <ValueRow e={v} canEdit={props.canEdit} run={run} promote={props.promote} prefix="← " />
            </View>
          ))}
        </View>
      ))}
      {props.canEdit ? (
        <View style={styles.row}>
          <TextInput value={raw} onChangeText={setRaw} placeholder={spec.variant} placeholderTextColor={color.text3} autoCapitalize="none" style={[styles.input, styles.grow]} />
          <Text style={styles.value}>→</Text>
          <TextInput value={canonical} onChangeText={setCanonical} placeholder={spec.canonical} placeholderTextColor={color.text3} autoCapitalize="none" style={[styles.input, styles.grow]} />
          <Btn kind="primary" title="Add" disabled={!ready} onPress={async () => (await run((ed, s) => addPair(ed, s, spec.list, raw, canonical))) && (setRaw(''), setCanonical(''))} />
        </View>
      ) : null}
    </View>
  );
}

/** Pin shape per role (D64, T104): one row per role, the nine shapes as chips. */
function PinShapes(props: { shapes: PinShapeMap | null; canEdit: boolean; run: RunFn }) {
  const { shapes } = props;
  if (!shapes) return null;
  const shared = new Set(sharedShapes(shapes));
  return (
    <View style={styles.section}>
      <Text style={styles.sub}>A change here applies to every project.</Text>
      {ROLE.map((role: Role) => (
        <View key={role} style={styles.group}>
          <Text style={styles.sectionTitle} testID={`vocab.shape.${role}`}>
            {PIN_SHAPE_LABEL[shapes[role]!].glyph} {ROLE_LABEL[role]}
            {shared.has(role) ? <Text style={styles.draft}>  shares its shape with another role</Text> : null}
          </Text>
          <View style={styles.wrap}>
            {PIN_SHAPE_NAMES.map((name) => (
              <Chip
                key={name}
                small
                disabled={!props.canEdit}
                onPress={() => props.run((e, s) => setPinShape(e, s, role, name))}
                selected={shapes[role] === name}
                label={`${PIN_SHAPE_LABEL[name].glyph} ${PIN_SHAPE_LABEL[name].label}`}
                testID={`vocab.shape.${role}.${name}`}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function Placeholders(props: { items: PlaceholderEntry[]; canEdit: boolean; run: RunFn }) {
  const { run } = props;
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PlaceholderKind>('custom');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  return (
    <View style={styles.section}>
      {KINDS.map((k) => {
        const items = props.items.filter((p) => p.kind === k);
        if (!items.length) return null;
        return (
          <View key={k} style={styles.group}>
            <Text style={styles.sectionTitle}>{PLACEHOLDER_KIND_LABEL[k]}</Text>
            {items.map((p) =>
              editing?.id === p.id ? (
                <View key={p.id} style={styles.row}>
                  <TextInput value={editing.text} onChangeText={(t) => setEditing({ id: p.id, text: t })} style={[styles.input, styles.grow]} autoFocus />
                  <Btn title="Cancel" onPress={() => setEditing(null)} />
                  <Btn kind="primary" title="Save" onPress={async () => (await run((ed, s) => editPlaceholder(ed, s, p.id, { label: editing.text }))) && setEditing(null)} />
                </View>
              ) : (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.value, styles.grow]}>{p.label}</Text>
                  {props.canEdit ? (
                    <>
                      <Pressable onPress={() => setEditing({ id: p.id, text: p.label })} hitSlop={space.md}>
                        <Text style={styles.link}>Edit</Text>
                      </Pressable>
                      <Pressable onPress={() => run((ed, s) => removePlaceholder(ed, s, p.id))} hitSlop={space.md} testID={`vocab.placeholder.remove.${p.label}`}>
                        <Text style={styles.danger}>Remove</Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              ),
            )}
          </View>
        );
      })}
      {!props.items.length ? <Text style={styles.sub}>No placeholders yet.</Text> : null}
      {props.canEdit ? (
        <View style={styles.group}>
          <Text style={styles.sectionTitle}>Add a placeholder</Text>
          <View style={styles.wrap}>
            {KINDS.map((k) => (
              <Chip key={k} small onPress={() => setKind(k)} selected={kind === k} label={PLACEHOLDER_KIND_LABEL[k]} />
            ))}
          </View>
          <View style={styles.row}>
            <TextInput value={text} onChangeText={setText} placeholder="Label" placeholderTextColor={color.text3} style={[styles.input, styles.grow]} />
            <Btn kind="primary" title="Add" disabled={!text.trim()} onPress={async () => (await run((ed, s) => addPlaceholder(ed, s, text, kind))) && setText('')} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  link: { ...font.callout, color: color.primary },
  danger: { ...font.callout, color: color.danger },
  tabs: { paddingBottom: space.sm },
  note: { marginHorizontal: PAGE_GUTTER, marginBottom: space.sm },
  body: { paddingHorizontal: PAGE_GUTTER, paddingTop: space.sm, paddingBottom: space.xl, gap: space.lg },
  section: { gap: space.sm, backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.card, paddingVertical: space.lg, paddingHorizontal: 20 },
  group: { gap: 6, marginTop: space.sm },
  indent: { paddingLeft: space.xl },
  sectionTitle: { ...font.headline, color: color.text },
  sub: { ...font.caption, color: color.text3, fontWeight: '400' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 6, minHeight: 44, borderBottomWidth: 1, borderBottomColor: color.hairline },
  grow: { flex: 1 },
  value: { ...font.body, color: color.text },
  draft: { ...font.badge, color: color.warning },
  input: fieldStyles.input,
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});