import { Editor, resolutionReason, type ResolveChoice, type Store } from '@field-survey/core';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { logTo } from '../log';
import { kindLabel, loadReviewDetail, loadReviewList, shortStamp, type ReviewDetail, type ReviewList, type ReviewRow } from '../review/model';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

const CHOICE_LABEL: Record<ResolveChoice['choice'], string> = { A: 'Choose A', B: 'Choose B', combine: 'Combine', value: 'Set value' };

/**
 * Needs review (T26, Phase 3 §6): open review items by kind and level on the left, the selected
 * item's A/B panel on the right. A sync conflict is closed only by Choose A / Choose B / Combine /
 * a typed value (D98: no Dismiss); each choice writes one Reconcile group with the auto-filled
 * reason (T15). Pin conflicts are resolved on the plan, both pins drawn. The `IN REVIEW` badges
 * clear here at once and on the other iPads on their next pull. `?item=` selects an item.
 */
export default function NeedsReviewScreen() {
  const params = useLocalSearchParams<{ item?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [store, setStore] = useState<Store | null>(null);
  const names = useTeamNames(store);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [kind, setKind] = useState('all');
  const [levelId, setLevelId] = useState<string | null>(null);
  const [sort, setSort] = useState<'oldest' | 'newest'>('oldest');
  const [list, setList] = useState<ReviewList | null>(null);
  const [selected, setSelected] = useState<string | null>(params.item ?? null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        setProjectId((await listProjects(s))[0]?.id ?? null);
      },
      (e: unknown) => setNote(String(e)),
    );
  }, []);
  // Back from the plan (a pin conflict resolved there): reload.
  useFocusEffect(useCallback(() => setTick((n) => n + 1), []));

  useEffect(() => {
    if (!store || !projectId) return;
    let active = true;
    loadReviewList(store, projectId, { kind, levelId, sort }).then(
      (l) => {
        if (!active) return;
        setList(l);
        // Keep the selection while it is listed; otherwise the first row (an empty list: none).
        setSelected((cur) => (cur && l.rows.some((r) => r.id === cur) ? cur : (l.rows[0]?.id ?? null)));
      },
      (e: unknown) => active && setNote(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, projectId, kind, levelId, sort, tick, dataKey]);

  useEffect(() => {
    if (!store || !selected) return setDetail(null);
    let active = true;
    loadReviewDetail(store, selected, names).then(
      (d) => active && setDetail(d),
      (e: unknown) => active && setNote(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, selected, names, tick, dataKey]);

  const editor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);

  const resolve = useCallback(
    async (choice: ResolveChoice) => {
      if (!store || !editor || !detail) return;
      const userName = (id: string) => names.get(id);
      const reason = await resolutionReason(store, detail.item, choice, { userName });
      Alert.alert(CHOICE_LABEL[choice.choice], `Reason (auto-filled):\n${reason}`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Resolve',
          onPress: () => {
            editor.resolve(detail.item.id, choice, { userName }).then(
              (r) => {
                logTo('sync', 'info', 'review_resolved', { item: r.item_id, choice: choice.choice });
                setNote(`Resolved: ${r.reason}`);
                setTick((n) => n + 1);
              },
              (e: unknown) => setNote(`Not resolved: ${String((e as Error)?.message ?? e)}`),
            );
          },
        },
      ]);
    },
    [store, editor, detail, names],
  );

  const total = list?.tabs.find((t) => t.kind === 'all')?.count ?? 0;

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>Needs review ({total})</Text>
        <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
          {list?.tabs.map((t) => (
            <Chip key={t.kind} label={`${t.label}${t.kind === 'all' ? '' : ` ${t.count}`}`} on={kind === t.kind} onPress={() => setKind(t.kind)} />
          ))}
        </ScrollView>
        <Link href="/" style={styles.link}>
          ← Levels
        </Link>
      </View>
      <View style={styles.filters}>
        <Text style={styles.filterLabel}>Level</Text>
        <Chip label="All" on={!levelId} onPress={() => setLevelId(null)} />
        {list?.levels.map((l) => (
          <Chip key={l.id} label={l.code} on={levelId === l.id} onPress={() => setLevelId(l.id)} />
        ))}
        <Text style={[styles.filterLabel, { marginLeft: 16 }]}>Sort</Text>
        <Chip label={sort === 'oldest' ? 'Oldest first' : 'Newest first'} on={false} onPress={() => setSort(sort === 'oldest' ? 'newest' : 'oldest')} />
      </View>

      <View style={styles.body}>
        <FlatList
          style={styles.list}
          data={list?.rows ?? []}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <Row row={item} selected={item.id === selected} onPress={() => setSelected(item.id)} />}
          ListEmptyComponent={<Text style={styles.empty}>{list ? 'Nothing to review.' : 'Loading…'}</Text>}
        />
        <ScrollView style={styles.panel} contentContainerStyle={{ padding: 16, gap: 12 }}>
          {detail ? <Panel detail={detail} canEdit={!!editor} onResolve={resolve} /> : <Text style={styles.empty}>Select an item.</Text>}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </ScrollView>
      </View>
    </View>
  );
}

function Row({ row, selected, onPress }: { row: ReviewRow; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.row, selected && styles.rowOn]}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        <Text style={styles.dot}>● </Text>
        {row.subject} · {row.field}
      </Text>
      <Text style={styles.rowSub}>
        {kindLabel(row.kind).toLowerCase()} · {row.levelCode ?? 'no level'} · {shortStamp(row.at)}
        {row.ruling ? ' · ⚑ ruling' : ''}
      </Text>
    </Pressable>
  );
}

function Panel({ detail: d, canEdit, onResolve }: { detail: ReviewDetail; canEdit: boolean; onResolve: (c: ResolveChoice) => void }) {
  const [combine, setCombine] = useState<string | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    setCombine(null);
    setValue('');
  }, [d.item.id]);

  const head = (
    <Text style={styles.panelTitle}>
      {kindLabel(d.item.kind)} — {d.row.subject} · {d.row.field}
    </Text>
  );
  if (d.item.kind !== 'sync_conflict') {
    return (
      <>
        {head}
        <Text style={styles.sub}>
          {kindLabel(d.item.kind)} items are reviewed in Setup (their screens come with the setup tasks). Listed here so nothing is missed.
        </Text>
      </>
    );
  }
  const was = d.fields.some((f) => f.was !== null);
  const openOnPlan = (review: boolean) => {
    if (!d.row.levelId) return;
    router.push({
      pathname: '/plan/[levelId]',
      params: { levelId: d.row.levelId, ...(d.row.deviceId ? { device: d.row.deviceId } : {}), ...(review ? { review: d.item.id } : {}) },
    });
  };

  return (
    <>
      {head}
      {d.item.state !== 'open' ? <Text style={styles.sub}>This item is {d.item.state}.</Text> : null}
      <View style={styles.sides}>
        <Side letter="A" title="A (official now)" side={d.a} values={d.fields.map((f) => [f.label, f.a])} solid />
        <Side letter="B" title="B" side={d.b} values={d.fields.map((f) => [f.label, f.b])} />
      </View>
      {was ? (
        <Text style={styles.sub}>
          was: {d.fields.map((f) => `${d.fields.length > 1 ? `${f.label} ` : ''}${f.was ?? '?'}`).join(' · ')} — the value before both edits
        </Text>
      ) : null}
      {d.item.ruling ? <Text style={styles.flag}>⚑ A ruling lost to a field edit here</Text> : null}

      {d.resolvable ? (
        <>
          {d.pins ? (
            <Btn label="Resolve on the plan ▸ (A solid, B dashed)" onPress={() => openOnPlan(true)} disabled={!d.row.levelId} />
          ) : null}
          <View style={styles.btnRow}>
            <Btn label="Choose A" onPress={() => onResolve({ choice: 'A' })} disabled={!canEdit} />
            <Btn label="Choose B" onPress={() => onResolve({ choice: 'B' })} disabled={!canEdit} />
            {d.choices.includes('combine') ? (
              <Btn label={combine === null ? 'Combine ▸' : 'Combine ▾'} onPress={() => setCombine(combine === null ? (d.combine ?? '') : null)} disabled={!canEdit} />
            ) : null}
          </View>
          {combine !== null ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.sub}>Combined text (pre-filled "A; B", A first — edit as needed)</Text>
              <TextInput style={styles.input} value={combine} onChangeText={setCombine} multiline />
              <Btn label="Save combined" disabled={!combine.trim()} onPress={() => onResolve({ choice: 'combine', text: combine })} />
            </View>
          ) : null}
          {d.choices.includes('value') ? (
            <View style={styles.btnRow}>
              <TextInput style={[styles.input, { width: 120 }]} value={value} onChangeText={setValue} keyboardType="numeric" placeholder="Value" />
              <Btn
                label="Set value"
                disabled={!canEdit || !Number.isFinite(Number(value)) || value.trim() === ''}
                onPress={() => onResolve({ choice: 'value', value: Number(value) })}
              />
            </View>
          ) : null}
          <Text style={styles.sub}>No dismiss: a sync conflict is closed by a choice (D98). The reason is filled in for you.</Text>
        </>
      ) : null}
      {d.row.levelId ? (
        <Pressable onPress={() => openOnPlan(false)}>
          <Text style={styles.link}>Context: open {d.row.deviceId ? 'the device card' : 'the level'} on the plan ▸</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function Side(props: { letter: string; title: string; side: ReviewDetail['a']; values: [string, string][]; solid?: boolean }) {
  return (
    <View style={[styles.side, !props.solid && styles.sideB]}>
      <Text style={styles.sideTitle}>{props.title}</Text>
      <Text style={styles.sub}>
        {props.side ? `${props.side.who} · ${shortStamp(props.side.when)}` : '—'}
        {'\n'}
        {props.side?.install ?? ''}
      </Text>
      {props.values.map(([label, v]) => (
        <Text key={label} style={styles.value}>
          {props.values.length > 1 ? <Text style={styles.sub}>{label}: </Text> : null}
          {v}
        </Text>
      ))}
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function Btn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, disabled && { opacity: 0.4 }]} accessibilityRole="button">
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 16 },
  title: { fontSize: 24, fontWeight: '600' },
  link: { color: '#1f6feb', fontSize: 16 },
  chips: { gap: 8, alignItems: 'center' },
  filters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingVertical: 10 },
  filterLabel: { fontSize: 14, color: '#555' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
  body: { flex: 1, flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e1e4e8' },
  list: { width: '42%', flexGrow: 0, borderRightWidth: 1, borderRightColor: '#e1e4e8' },
  panel: { flex: 1 },
  row: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  rowOn: { backgroundColor: '#dce8fb' },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 13, color: '#666', marginTop: 2 },
  dot: { color: '#e65100' },
  empty: { fontSize: 15, color: '#666', padding: 16 },
  panelTitle: { fontSize: 18, fontWeight: '600' },
  sides: { flexDirection: 'row', gap: 12 },
  side: { flex: 1, borderWidth: 2, borderColor: '#9aa0a8', borderRadius: 8, padding: 12, gap: 6 },
  sideB: { borderStyle: 'dashed' },
  sideTitle: { fontSize: 15, fontWeight: '700' },
  value: { fontSize: 16 },
  sub: { fontSize: 13, color: '#666' },
  flag: { fontSize: 14, color: '#b42318', fontWeight: '600' },
  btnRow: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  btn: { alignSelf: 'flex-start', backgroundColor: '#1f6feb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  btnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  note: { color: '#0a5', fontSize: 14 },
});
