import { Editor, LIBRARY_STREAM, OpError, ROLE, ROLE_LABEL, type Role, type Store } from '@field-survey/core';
import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { PIN_SHAPE_LABEL, PIN_SHAPE_NAMES, type PinShapeMap } from '../plan/pins';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import {
  acceptValue,
  addPair,
  addPlaceholder,
  addValue,
  copyAppVocab,
  editPlaceholder,
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
import { PLACEHOLDER_KIND_LABEL, VOCAB_LISTS, VOCAB_PAIR_LISTS, type PlaceholderKind, type VocabListKey, type VocabPairListKey } from '../vocab/seed';

type Tab = 'lists' | 'pairs' | 'shapes' | 'placeholders';
type Scope = 'project' | 'app';
const KINDS = Object.keys(PLACEHOLDER_KIND_LABEL) as PlaceholderKind[];
const TAB_LABEL: Record<Tab, string> = { lists: 'Lists', pairs: 'Model map & levels', shapes: 'Pin shapes', placeholders: 'Placeholders' };

/**
 * Vocabulary (T40, T104; PLAN §2.2, D26, D182, D187, D214): the picker lists (notes, punch
 * items, photo captions, device types, categories, cable codes), the BOM's model map and level
 * aliases (canonical / variant pairs), the pin shape per role and the placeholder endpoints. Two
 * scopes like the library (D65): **This project** (a new value is a draft, usable at once) and
 * **App library** (drafts for Landry; new projects copy the accepted ones). Pin shapes are always
 * the app library's and apply to every project at once. `?project=` names the project.
 */
export default function VocabularyScreen() {
  const params = useLocalSearchParams<{ project?: string; tab?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
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
  useEffect(() => {
    if (!store || (!app && !projectId)) return;
    let live = true;
    Promise.all([loadVocab(store, scopeId), loadPairs(store, scopeId), loadPinShapes(store), projectId ? loadPlaceholders(store, projectId) : Promise.resolve([])]).then(
      ([v, p, sh, ph]) => {
        if (!live) return;
        setLists(v);
        setPairs(p);
        setShapes(sh);
        setPlaceholders(ph);
      },
      (e: unknown) => live && setNote(String(e)),
    );
    return () => {
      live = false;
    };
  }, [store, projectId, scopeId, app, tick, dataKey]);

  const projectEditor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);
  const libraryEditor = useMemo(() => (store ? new Editor(store, { projectId: LIBRARY_STREAM, userId: user.id }) : null), [store, user.id]);
  const editor = app ? libraryEditor : projectEditor;

  const run = useCallback(
    async (fn: (e: Editor, s: Store) => Promise<unknown>, on: Editor | null = editor) => {
      if (!on || !store) return false;
      try {
        await fn(on, store);
        setNote('');
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

  const drafts = (lists ? Object.values(lists).flat() : []).filter((e) => e.draft).length;
  const pairDrafts = (pairs ? Object.values(pairs).flat().flatMap((p) => [p, ...p.variants]) : []).filter((e) => e.draft).length;
  const tabs: Tab[] = app ? ['lists', 'pairs', 'shapes'] : ['lists', 'pairs', 'shapes', 'placeholders'];
  const shown = tabs.includes(tab) ? tab : 'lists';
  const tabText = (t: Tab) => {
    const n = t === 'lists' ? drafts : t === 'pairs' ? pairDrafts : 0;
    return t === 'placeholders' ? `${TAB_LABEL[t]} · ${placeholders.length}` : `${TAB_LABEL[t]}${n ? ` · ${n} draft${n === 1 ? '' : 's'}` : ''}`;
  };

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Link href={{ pathname: '/', params: projectId ? { project: projectId } : {} }} style={styles.link}>
          ◀ Levels
        </Link>
        <Text style={styles.title}>Vocabulary</Text>
        {!app ? (
          <Pressable
            disabled={!editor || !projectId}
            onPress={() =>
              run(async (e, s) => {
                const n = await copyAppVocab(e, s, projectId!);
                setNote(n ? `Copied ${n} value${n === 1 ? '' : 's'} from the app library.` : 'This project already has every accepted app value.');
              })
            }
            style={styles.btnPlain}>
            <Text style={styles.link}>Copy from app library</Text>
          </Pressable>
        ) : null}
        <Pressable
          disabled={!editor}
          onPress={() =>
            run(async (e, s) => {
              const n = await loadStandard(e, s);
              const what = app ? `${n.values} draft${n.values === 1 ? '' : 's'} to the app library` : `${n.values} value${n.values === 1 ? '' : 's'} and ${n.placeholders} placeholder${n.placeholders === 1 ? '' : 's'}`;
              setNote(n.values || n.placeholders ? `Added ${what}.` : 'Everything standard is already here.');
            })
          }
          style={styles.btn}>
          <Text style={styles.btnText}>Load standard lists</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {(['project', 'app'] as const).map((s) => (
          <Pressable key={s} onPress={() => setScope(s)} style={[styles.chip, scope === s && styles.chipOn]}>
            <Text style={scope === s ? styles.chipTextOn : styles.chipText}>{s === 'project' ? 'This project' : 'App library'}</Text>
          </Pressable>
        ))}
        <Text style={[styles.sub, styles.grow]}>
          {app ? '  Drafts here are for Landry to accept; new projects copy the accepted values.' : '  This project only. Promote a value to offer it to every new project.'}
        </Text>
      </View>
      <View style={styles.tabs}>
        {tabs.map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, shown === t && styles.tabOn]}>
            <Text style={shown === t ? styles.tabTextOn : styles.tabText}>{tabText(t)}</Text>
          </Pressable>
        ))}
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {shown === 'lists'
          ? VOCAB_LISTS.map((l) => <ListSection key={`${scope}-${l.list}`} list={l.list} title={l.title} hint={l.hint} entries={lists?.[l.list] ?? []} canEdit={!!editor} run={run} promote={promote} />)
          : shown === 'pairs'
            ? VOCAB_PAIR_LISTS.map((l) => <PairSection key={`${scope}-${l.list}`} spec={l} pairs={pairs?.[l.list] ?? []} canEdit={!!editor} run={run} promote={promote} />)
            : shown === 'shapes'
              ? <PinShapes shapes={shapes} canEdit={!!libraryEditor} run={(fn) => run(fn, libraryEditor)} />
              : <Placeholders items={placeholders} canEdit={!!projectEditor} run={run} />}
      </ScrollView>
    </View>
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
        <TextInput value={editing} onChangeText={setEditing} style={[styles.input, styles.grow]} autoFocus />
        <Pressable onPress={async () => (await run((ed, s) => renameValue(ed, s, e.id, editing))) && setEditing(null)} style={styles.btn}>
          <Text style={styles.btnText}>Save</Text>
        </Pressable>
        <Pressable onPress={() => setEditing(null)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={[styles.value, styles.grow]}>
        {props.prefix ?? ''}
        {e.value}
        {e.draft ? <Text style={styles.draft}>  draft</Text> : null}
      </Text>
      {props.canEdit ? (
        <>
          {e.draft ? (
            <Pressable onPress={() => run((ed) => acceptValue(ed, e.id))}>
              <Text style={styles.link}>Accept</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setEditing(e.value)}>
            <Text style={styles.link}>Edit</Text>
          </Pressable>
          {props.promote && !e.draft ? (
            <Pressable onPress={() => props.promote!(e.id)}>
              <Text style={styles.link}>Promote</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => run((ed, s) => removeValue(ed, e.id, s))}>
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
          <TextInput value={text} onChangeText={setText} placeholder="Add a value" placeholderTextColor="#888" style={[styles.input, styles.grow]} />
          <Pressable
            disabled={!text.trim()}
            onPress={async () => (await run((ed, s) => addValue(ed, s, list, text))) && setText('')}
            style={[styles.btn, !text.trim() && styles.off]}>
            <Text style={styles.btnText}>Add</Text>
          </Pressable>
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
          <TextInput value={raw} onChangeText={setRaw} placeholder={spec.variant} placeholderTextColor="#888" autoCapitalize="none" style={[styles.input, styles.grow]} />
          <Text style={styles.value}>→</Text>
          <TextInput value={canonical} onChangeText={setCanonical} placeholder={spec.canonical} placeholderTextColor="#888" autoCapitalize="none" style={[styles.input, styles.grow]} />
          <Pressable
            disabled={!ready}
            onPress={async () => (await run((ed, s) => addPair(ed, s, spec.list, raw, canonical))) && (setRaw(''), setCanonical(''))}
            style={[styles.btn, !ready && styles.off]}>
            <Text style={styles.btnText}>Add</Text>
          </Pressable>
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
      <Text style={styles.sub}>
        The shape of a device's pin follows its role (its library type's, else its category's). A change here applies at once to every project, on the plan and in the floor PDF. The fill colour stays the status.
      </Text>
      {ROLE.map((role: Role) => (
        <View key={role} style={styles.group}>
          <Text style={styles.sectionTitle}>
            {PIN_SHAPE_LABEL[shapes[role]!].glyph} {ROLE_LABEL[role]}
            {shared.has(role) ? <Text style={styles.draft}>  shares its shape with another role</Text> : null}
          </Text>
          <View style={styles.wrap}>
            {PIN_SHAPE_NAMES.map((name) => (
              <Pressable
                key={name}
                disabled={!props.canEdit}
                onPress={() => props.run((e, s) => setPinShape(e, s, role, name))}
                style={[styles.chip, shapes[role] === name && styles.chipOn]}>
                <Text style={shapes[role] === name ? styles.chipTextOn : styles.chipText}>
                  {PIN_SHAPE_LABEL[name].glyph} {PIN_SHAPE_LABEL[name].label}
                </Text>
              </Pressable>
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
      <Text style={styles.sub}>Endpoints a connection can name when the far end is not a device (D26). The text is what the export prints.</Text>
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
                  <Pressable onPress={async () => (await run((ed, s) => editPlaceholder(ed, s, p.id, { label: editing.text }))) && setEditing(null)} style={styles.btn}>
                    <Text style={styles.btnText}>Save</Text>
                  </Pressable>
                  <Pressable onPress={() => setEditing(null)}>
                    <Text style={styles.link}>Cancel</Text>
                  </Pressable>
                </View>
              ) : (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.value, styles.grow]}>{p.label}</Text>
                  {props.canEdit ? (
                    <>
                      <Pressable onPress={() => setEditing({ id: p.id, text: p.label })}>
                        <Text style={styles.link}>Edit</Text>
                      </Pressable>
                      <Pressable onPress={() => run((ed, s) => removePlaceholder(ed, s, p.id))}>
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
      {!props.items.length ? <Text style={styles.sub}>No placeholders yet. Load the standard lists, or add one.</Text> : null}
      {props.canEdit ? (
        <View style={styles.group}>
          <Text style={styles.sectionTitle}>Add a placeholder</Text>
          <View style={styles.wrap}>
            {KINDS.map((k) => (
              <Pressable key={k} onPress={() => setKind(k)} style={[styles.chip, kind === k && styles.chipOn]}>
                <Text style={kind === k ? styles.chipTextOn : styles.chipText}>{PLACEHOLDER_KIND_LABEL[k]}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            <TextInput value={text} onChangeText={setText} placeholder="Label" placeholderTextColor="#888" style={[styles.input, styles.grow]} />
            <Pressable
              disabled={!text.trim()}
              onPress={async () => (await run((ed, s) => addPlaceholder(ed, s, text, kind))) && setText('')}
              style={[styles.btn, !text.trim() && styles.off]}>
              <Text style={styles.btnText}>Add</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 24, fontWeight: '600', flex: 1 },
  link: { color: '#1f6feb', fontSize: 16 },
  danger: { color: '#b3261e', fontSize: 16 },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingBottom: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: '#c9ccd1' },
  tabOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  tabText: { color: '#111' },
  tabTextOn: { color: '#fff' },
  note: { paddingHorizontal: 20, paddingBottom: 8, color: '#b3261e', fontSize: 14 },
  body: { padding: 20, gap: 20, borderTopWidth: 1, borderTopColor: '#e1e4e8' },
  section: { gap: 8 },
  group: { gap: 6, marginTop: 8 },
  indent: { paddingLeft: 24 },
  sectionTitle: { fontSize: 17, fontWeight: '600' },
  sub: { fontSize: 13, color: '#666', fontWeight: '400' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  grow: { flex: 1 },
  value: { fontSize: 16 },
  draft: { fontSize: 12, color: '#9a6700', fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1565c0' },
  btnPlain: { paddingHorizontal: 6, paddingVertical: 10 },
  btnText: { color: '#fff', fontWeight: '600' },
  off: { opacity: 0.4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
});
