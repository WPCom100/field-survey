import { LIBRARY_STREAM, Editor, linkPunchDevice, resolutionReason, type ResolveChoice, type Store } from '@field-survey/core';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AddDevicePanel } from '../additions/AddDevicePanel';
import { openAppStore } from '../db';
import { flaggedDraftCounts } from '../drafts/model';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { logTo } from '../log';
import {
  kindLabel,
  loadReviewDetail,
  loadReviewList,
  shortStamp,
  type FindingRow,
  type PunchDeviceReview,
  type ReviewDetail,
  type ReviewList,
  type ReviewRow,
} from '../review/model';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

const CHOICE_LABEL: Record<ResolveChoice['choice'], string> = { A: 'Choose A', B: 'Choose B', combine: 'Combine', value: 'Set value' };

/**
 * Needs review (T26, Phase 3 §6): open review items by kind and level on the left, the selected
 * item's A/B panel on the right. A sync conflict is closed only by Choose A / Choose B / Combine /
 * a typed value (D98: no Dismiss); each choice writes one Reconcile group with the auto-filled
 * reason (T15). Pin conflicts are resolved on the plan, both pins drawn. The `IN REVIEW` badges
 * clear here at once and on the other iPads on their next pull. `?item=` selects an item;
 * `?project=` names the project (else the one the home last showed, T83).
 *
 * An imported punch row linked to no device (T81, D148) shows the master's Device text with Link
 * to device (a device of the row's level) and Create device (the + Device form, created unplaced);
 * either writes one Reconcile op on `punch_item.device_id` and closes the item. Left unlinked, the
 * item keeps the master's text in the export (D150).
 */
export default function NeedsReviewScreen() {
  const params = useLocalSearchParams<{ item?: string; project?: string; kind?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [store, setStore] = useState<Store | null>(null);
  const names = useTeamNames(store);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [kind, setKind] = useState(params.kind ?? 'all');
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
        // The project the link names, else the one the home last showed (T83), else the first.
        setProjectId(params.project === LIBRARY_STREAM ? LIBRARY_STREAM : pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setNote(String(e)),
    );
  }, [params.project]);
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

  // Flagged extraction drafts (D11) wait in Setup → Review drafts; the Extraction tab links there (T44).
  const [drafts, setDrafts] = useState<{ devices: number; cables: number } | null>(null);
  useEffect(() => {
    if (!store || !projectId || projectId === LIBRARY_STREAM) return setDrafts(null);
    let active = true;
    flaggedDraftCounts(store, projectId).then(
      (d) => active && setDrafts(d),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [store, projectId, tick, dataKey]);

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

  const linkPunch = useCallback(
    (deviceId: string, deviceLabel: string, confirm: boolean) => {
      if (!editor || !detail) return;
      const run = () =>
        linkPunchDevice(editor, detail.item.id, deviceId, { deviceLabel }).then(
          (r) => {
            logTo('sync', 'info', 'punch_device_linked', { item: detail.item.id, device: deviceId });
            setNote(`Linked: ${r.reason}`);
            setTick((n) => n + 1);
          },
          (e: unknown) => setNote(`Not linked: ${String((e as Error)?.message ?? e)}`),
        );
      if (!confirm) return void run();
      Alert.alert('Link to device', `Link this punch item to ${deviceLabel}? Its Device text then follows the device.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Link', onPress: () => void run() },
      ]);
    },
    [editor, detail],
  );

  const total = list?.tabs.find((t) => t.kind === 'all')?.count ?? 0;
  const draftLine =
    drafts && drafts.devices + drafts.cables > 0 && (kind === 'all' || kind === 'extraction') && projectId && projectId !== LIBRARY_STREAM ? (
      <Pressable onPress={() => router.push({ pathname: '/setup/[projectId]', params: { projectId, step: 'drafts' } })} style={styles.row}>
        <Text style={styles.rowTitle}>
          Extraction drafts: {drafts.devices} device{drafts.devices === 1 ? '' : 's'} and {drafts.cables} cable{drafts.cables === 1 ? '' : 's'} under 0.7 or in conflict
        </Text>
        <Text style={styles.link}>Open Setup → Review drafts ▸</Text>
      </Pressable>
    ) : null;

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>{projectId === LIBRARY_STREAM ? 'App library — needs review' : 'Needs review'} ({total})</Text>
        <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
          {list?.tabs.map((t) => (
            <Chip key={t.kind} label={`${t.label}${t.kind === 'all' ? '' : ` ${t.count}`}`} on={kind === t.kind} onPress={() => setKind(t.kind)} />
          ))}
        </ScrollView>
        {projectId === LIBRARY_STREAM ? (
          <Link href={{ pathname: '/library', params: { scope: 'app' } }} style={styles.link}>
            ← Library
          </Link>
        ) : (
          <Link href={projectId ? { pathname: '/', params: { project: projectId } } : '/'} style={styles.link}>
            ← Levels
          </Link>
        )}
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
          ListHeaderComponent={draftLine}
          ListEmptyComponent={
            (list?.findings.length && kind === 'lint') || draftLine ? null : <Text style={styles.empty}>{list ? 'Nothing to review.' : 'Loading…'}</Text>
          }
          ListFooterComponent={
            kind === 'lint' && list?.findings.length ? (
              <View>
                <Text style={styles.sectionHead}>Lint findings ({list.findings.length})</Text>
                <Pressable onPress={() => router.push({ pathname: '/lint', params: projectId ? { project: projectId } : {} })} style={styles.row}>
                  <Text style={styles.link}>Open the Lint view to dismiss or fix them ▸</Text>
                </Pressable>
                {list.findings.map((f) => (
                  <FindingItem key={f.id} finding={f} />
                ))}
              </View>
            ) : null
          }
        />
        <ScrollView style={styles.panel} contentContainerStyle={{ padding: 16, gap: 12 }}>
          {detail?.punchDevice && store && editor && projectId ? (
            <PunchDevicePanel detail={detail} review={detail.punchDevice} store={store} editor={editor} projectId={projectId} onLink={linkPunch} />
          ) : detail ? (
            <Panel detail={detail} canEdit={!!editor} onResolve={resolve} />
          ) : (
            <Text style={styles.empty}>Select an item.</Text>
          )}
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

function FindingItem({ finding: f }: { finding: FindingRow }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>
        <Text style={styles.dot}>● </Text>
        {f.lintId} · {f.subject}
      </Text>
      <Text style={styles.finding}>{f.message}</Text>
      <Text style={styles.rowSub}>finding · {f.levelCode ?? 'no level'}</Text>
      {f.levelId ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/plan/[levelId]', params: { levelId: f.levelId!, ...(f.deviceId ? { device: f.deviceId } : {}) } })
          }
        >
          <Text style={styles.link}>Open {f.deviceId ? 'the device card' : 'the level'} on the plan ▸</Text>
        </Pressable>
      ) : null}
    </View>
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
    const subj = d.item.subject;
    const draft = subj && (subj.entity_kind === 'draft_device' || subj.entity_kind === 'draft_cable') ? subj.entity_id : null;
    return (
      <>
        {head}
        <Text style={styles.sub}>
          {draft
            ? 'Settled in Setup → Review drafts (T44): Accept with the count you choose, or Reject to keep the baseline.'
            : `${kindLabel(d.item.kind)} items are reviewed in Setup (their screens come with the setup tasks). Listed here so nothing is missed.`}
        </Text>
        {draft ? (
          <Pressable onPress={() => router.push({ pathname: '/setup/[projectId]', params: { projectId: d.item.project_id, step: 'drafts', draft } })}>
            <Text style={styles.link}>Open in Review drafts ▸</Text>
          </Pressable>
        ) : null}
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

/** The room part of a master Device text (`UFMP4 - BH OBS RM 47` → `BH OBS RM 47`), for the form. */
function roomOf(master: string): string {
  const i = master.indexOf(' - ');
  return i >= 0 ? master.slice(i + 3).trim() : '';
}

function PunchDevicePanel(props: {
  detail: ReviewDetail;
  review: PunchDeviceReview;
  store: Store;
  editor: Editor;
  projectId: string;
  onLink: (deviceId: string, deviceLabel: string, confirm: boolean) => void;
}) {
  const { detail: d, review: r } = props;
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setFilter('');
    setCreating(false);
  }, [d.item.id]);
  const open = d.item.state === 'open';
  const q = filter.trim().toLowerCase();
  const shown = q ? r.devices.filter((x) => `${x.label} ${x.text ?? ''} ${x.category ?? ''}`.toLowerCase().includes(q)) : r.devices;
  const linked = r.linkedTo ? r.devices.find((x) => x.id === r.linkedTo) : null;

  return (
    <>
      <Text style={styles.panelTitle}>Punch item without a device — {r.levelCode}</Text>
      <Text style={styles.value}>{r.punch}</Text>
      <View style={styles.side}>
        <Text style={styles.sub}>Device, as the master wrote it</Text>
        <Text style={styles.value}>{r.master || '(blank)'}</Text>
      </View>
      {!open ? (
        <Text style={styles.sub}>
          This item is {d.item.state}
          {linked ? `: linked to ${linked.label}${linked.text ? ` · ${linked.text}` : ''}` : ''}.
        </Text>
      ) : creating ? (
        <View style={styles.form}>
          <AddDevicePanel
            store={props.store}
            editor={props.editor}
            projectId={props.projectId}
            levelId={r.levelId}
            levelCode={r.levelCode}
            sheetId={null}
            at={null}
            title="Create device for this punch item"
            defaults={{ drawingPosition: null, room: roomOf(r.master) || null }}
            onCancel={() => setCreating(false)}
            onCategory={() => {}}
            onAdded={(id) => {
              setCreating(false);
              props.onLink(id, `${r.levelCode}-? (new)`, false);
            }}
          />
        </View>
      ) : (
        <>
          <Text style={styles.sub}>
            Link it to the device it is about, or create that device. Once linked, its Device text follows the device (renames included). A row
            that is really about a room or several devices can stay unlinked: the export then keeps the master&apos;s text.
          </Text>
          <View style={styles.btnRow}>
            <Btn label="Create device ▸" onPress={() => setCreating(true)} />
          </View>
          <Text style={styles.sideTitle}>Link to a device on {r.levelCode}</Text>
          <TextInput style={styles.input} value={filter} onChangeText={setFilter} placeholder="Filter: ID, model, room" autoCorrect={false} autoCapitalize="none" />
          {shown.length === 0 ? <Text style={styles.sub}>No device matches.</Text> : null}
          {shown.map((x) => (
            <Pressable key={x.id} onPress={() => props.onLink(x.id, x.label, true)} style={styles.pick} accessibilityRole="button">
              <Text style={styles.pickId}>{x.label}</Text>
              <Text style={styles.pickText} numberOfLines={1}>
                {x.text ?? x.category ?? ''}
              </Text>
            </Pressable>
          ))}
        </>
      )}
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
  sectionHead: { fontSize: 14, fontWeight: '700', color: '#444', padding: 12, backgroundColor: '#f4f5f7' },
  finding: { fontSize: 14, marginTop: 2 },
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
  form: { height: 620, borderWidth: 1, borderColor: '#e1e4e8', borderRadius: 8, overflow: 'hidden' },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  pickId: { fontSize: 15, fontWeight: '700', minWidth: 72, fontVariant: ['tabular-nums'] },
  pickText: { fontSize: 15, flex: 1 },
});
