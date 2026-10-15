import { Editor, OpError, type Store } from '@field-survey/core';
import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import {
  acceptValue,
  addPlaceholder,
  addValue,
  editPlaceholder,
  loadPlaceholders,
  loadStandard,
  loadVocab,
  removePlaceholder,
  removeValue,
  renameValue,
  type PlaceholderEntry,
  type VocabView,
} from '../vocab/model';
import { PLACEHOLDER_KIND_LABEL, VOCAB_LISTS, type PlaceholderKind, type VocabListKey } from '../vocab/seed';

type Tab = 'lists' | 'placeholders';
const KINDS = Object.keys(PLACEHOLDER_KIND_LABEL) as PlaceholderKind[];

/**
 * Vocabulary (T40, PLAN §2.2, D26, D182): the project's picker lists (device / connection / punch /
 * part notes, photo captions, categories) and its placeholder endpoints. A new value is a draft,
 * usable at once and flagged until accepted. "Load standard lists" adds the master workbook's
 * phrases, categories and placeholders that are missing. `?project=` names the project.
 */
export default function VocabularyScreen() {
  const params = useLocalSearchParams<{ project?: string; tab?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(params.tab === 'placeholders' ? 'placeholders' : 'lists');
  const [lists, setLists] = useState<VocabView | null>(null);
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

  useEffect(() => {
    if (!store || !projectId) return;
    let live = true;
    Promise.all([loadVocab(store, projectId), loadPlaceholders(store, projectId)]).then(
      ([v, p]) => {
        if (!live) return;
        setLists(v);
        setPlaceholders(p);
      },
      (e: unknown) => live && setNote(String(e)),
    );
    return () => {
      live = false;
    };
  }, [store, projectId, tick, dataKey]);

  const editor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);

  const run = useCallback(async (fn: (e: Editor, s: Store) => Promise<unknown>) => {
    if (!editor || !store) return false;
    try {
      await fn(editor, store);
      setNote('');
      setTick((n) => n + 1);
      return true;
    } catch (e) {
      setNote(e instanceof OpError ? e.message : String(e));
      return false;
    }
  }, [editor, store]);

  const drafts = lists ? Object.values(lists).reduce((n, es) => n + es.filter((e) => e.draft).length, 0) : 0;

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Link href={{ pathname: '/', params: projectId ? { project: projectId } : {} }} style={styles.link}>
          ◀ Levels
        </Link>
        <Text style={styles.title}>Vocabulary</Text>
        <Pressable
          disabled={!editor}
          onPress={() =>
            run(async (e, s) => {
              const n = await loadStandard(e, s);
              setNote(n.values || n.placeholders ? `Added ${n.values} value${n.values === 1 ? '' : 's'} and ${n.placeholders} placeholder${n.placeholders === 1 ? '' : 's'}.` : 'Everything standard is already here.');
            })
          }
          style={styles.btn}>
          <Text style={styles.btnText}>Load standard lists</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {(['lists', 'placeholders'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
            <Text style={tab === t ? styles.tabTextOn : styles.tabText}>
              {t === 'lists' ? `Lists${drafts ? ` · ${drafts} draft${drafts === 1 ? '' : 's'}` : ''}` : `Placeholders · ${placeholders.length}`}
            </Text>
          </Pressable>
        ))}
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {tab === 'lists' ? (
          VOCAB_LISTS.map((l) => <ListSection key={l.list} list={l.list} title={l.title} hint={l.hint} entries={lists?.[l.list] ?? []} canEdit={!!editor} run={run} />)
        ) : (
          <Placeholders items={placeholders} canEdit={!!editor} run={run} />
        )}
      </ScrollView>
    </View>
  );
}

type RunFn = (fn: (e: Editor, s: Store) => Promise<unknown>) => Promise<boolean>;

function ListSection(props: { list: VocabListKey; title: string; hint: string; entries: VocabView[VocabListKey]; canEdit: boolean; run: RunFn }) {
  const { list, run } = props;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {props.title} <Text style={styles.sub}>({props.entries.length})</Text>
      </Text>
      <Text style={styles.sub}>{props.hint}</Text>
      {props.entries.map((e) =>
        editing?.id === e.id ? (
          <View key={e.id} style={styles.row}>
            <TextInput value={editing.text} onChangeText={(t) => setEditing({ id: e.id, text: t })} style={[styles.input, styles.grow]} autoFocus />
            <Pressable onPress={async () => (await run((ed, s) => renameValue(ed, s, e.id, editing.text))) && setEditing(null)} style={styles.btn}>
              <Text style={styles.btnText}>Save</Text>
            </Pressable>
            <Pressable onPress={() => setEditing(null)}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <View key={e.id} style={styles.row}>
            <Text style={[styles.value, styles.grow]}>
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
                <Pressable onPress={() => setEditing({ id: e.id, text: e.value })}>
                  <Text style={styles.link}>Edit</Text>
                </Pressable>
                <Pressable onPress={() => run((ed) => removeValue(ed, e.id))}>
                  <Text style={styles.danger}>Remove</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ),
      )}
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
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: '#c9ccd1' },
  tabOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  tabText: { color: '#111' },
  tabTextOn: { color: '#fff' },
  note: { paddingHorizontal: 20, paddingBottom: 8, color: '#b3261e', fontSize: 14 },
  body: { padding: 20, gap: 20, borderTopWidth: 1, borderTopColor: '#e1e4e8' },
  section: { gap: 8 },
  group: { gap: 6, marginTop: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '600' },
  sub: { fontSize: 13, color: '#666', fontWeight: '400' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  grow: { flex: 1 },
  value: { fontSize: 16 },
  draft: { fontSize: 12, color: '#9a6700', fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1565c0' },
  btnText: { color: '#fff', fontWeight: '600' },
  off: { opacity: 0.4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
});
