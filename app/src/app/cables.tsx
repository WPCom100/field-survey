import { Editor, vocab, type BlobQueue, type Store } from '@field-survey/core';
import { draftFromSelection } from '@field-survey/rules';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getBlobFiles, getBlobQueue } from '../blobs/queue';
import { confirmEndpoint } from '../cables/actions';
import { CABLE_CHECKS, UNSURVEYED, codeRank, codeTitle, endCell, groupCables, loadCables, statusCell, type CableData, type CableFilter, type CableRow, type CodeNames, type GroupBy } from '../cables/model';
import { RiserCrop } from '../cables/RiserCrop';
import { openAppStore } from '../db';
import { EndEditor } from '../ends/EndEditor';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { logTo } from '../log';
import { pinStyleFor } from '../plan/pins';
import { handRuling } from '../rulings/handoff';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

type Item = { type: 'group'; key: string; title: string; count: number; collapsed: boolean } | { type: 'row'; key: string; row: CableRow };

const STATUSES: readonly string[] = [...vocab.CONNECTION_STATUS, UNSURVEYED];

/**
 * Cable / riser view (T39, Phase 3 §5): every cable of the project with both ends, grouped by
 * vertical, level or code, filtered by code, end status and checks; the project's consistency
 * check counts along the bottom (tap one to filter). Selecting a cable opens the connection end
 * editor (T22) in the side panel with the cable's checks, Confirm endpoint (D6, D180), its Needs
 * review item and the riser crop below it. Select → Apply as ruling… hands the chosen cables' ends
 * to the ruling editor (T37). `?project=` names the project.
 */
export default function CablesScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [store, setStore] = useState<Store | null>(null);
  const [blobs, setBlobs] = useState<BlobQueue | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [data, setData] = useState<CableData | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('vertical');
  const [filter, setFilter] = useState<CableFilter>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState('');
  const names = useTeamNames(store);

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        setProjectId(pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setNote(String(e)),
    );
    getBlobQueue().then(setBlobs, (e: unknown) => console.error('[blobs] queue', e));
  }, [params.project]);
  useFocusEffect(useCallback(() => setTick((n) => n + 1), []));

  useEffect(() => {
    if (!store || !projectId) return;
    let live = true;
    loadCables(store, projectId).then(
      (d) => live && setData(d),
      (e: unknown) => live && setNote(String(e)),
    );
    return () => {
      live = false;
    };
  }, [store, projectId, tick, dataKey]);

  const groups = useMemo(() => (data ? groupCables(data, groupBy, filter) : []), [data, groupBy, filter]);
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const g of groups) {
      const c = collapsed.has(g.key);
      out.push({ type: 'group', key: g.key, title: g.title, count: g.rows.length, collapsed: c });
      if (!c) for (const r of g.rows) out.push({ type: 'row', key: `${g.key}|${r.id}`, row: r });
    }
    return out;
  }, [groups, collapsed]);
  const shown = useMemo(() => [...new Map(groups.flatMap((g) => g.rows).map((r) => [r.id, r])).values()], [groups]);
  const row = useMemo(() => data?.rows.find((r) => r.id === selected) ?? null, [data, selected]);
  const codes = useMemo(() => new Map((data?.levels ?? []).map((l) => [l.id, l.code] as const)), [data]);
  const presentCodes = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.code).filter((c): c is string => !!c))].sort((a, b) => codeRank(a, data?.names) - codeRank(b, data?.names)), [data]);
  const editor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);

  const set = (patch: Partial<CableFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const confirm = useCallback(
    (r: CableRow) => {
      if (!editor) return;
      confirmEndpoint(editor, r.id).then(
        () => {
          logTo('store', 'info', 'cable_endpoint_confirmed', { cable: r.id });
          setNote(`Endpoint confirmed: ${endCell(r.a)} ${r.code ?? ''}.`);
          reload();
        },
        (e: unknown) => setNote(`Not confirmed: ${String((e as Error)?.message ?? e)}`),
      );
    },
    [editor, reload],
  );

  const applyAsRuling = useCallback(() => {
    if (!picked?.size || !projectId || !data) return;
    const rows = data.rows.filter((r) => picked.has(r.id));
    const endIds = rows.flatMap((r) => [r.a?.id, r.b?.id]).filter((id): id is string => !!id);
    const levels = rows.flatMap((r) => r.levelIds).map((id) => codes.get(id)).filter((c): c is string => !!c);
    handRuling(projectId, draftFromSelection('cable_end', endIds, levels), 'Cable / riser');
    setPicked(null);
    router.push({ pathname: '/rulings', params: { project: projectId, from: 'handoff' } });
  }, [picked, projectId, data, codes]);

  const resolveBlobUri = useCallback((sha: string, kind: 'thumb' | 'image') => {
    const files = getBlobFiles();
    const f = files.file(files.pathFor(sha, kind));
    return f.exists ? f.uri : null;
  }, []);

  const endId = row ? (row.a?.id ?? row.b?.id ?? null) : null;
  const title = data ? `Cable / riser (${shown.length}${shown.length !== data.rows.length ? ` of ${data.rows.length}` : ''})` : 'Cable / riser';

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <Link href={projectId ? { pathname: '/', params: { project: projectId } } : '/'} style={styles.link}>
          ← Levels
        </Link>
        <View style={styles.flex} />
        {picked ? (
          <>
            <Btn label={`All ${shown.length}`} onPress={() => setPicked(new Set(shown.map((r) => r.id)))} />
            <Btn label={`Apply as ruling… (${picked.size})`} disabled={!picked.size} onPress={applyAsRuling} />
            <Btn label="Cancel" plain onPress={() => setPicked(null)} />
          </>
        ) : (
          <Btn label="Select" plain onPress={() => setPicked(new Set())} />
        )}
      </View>
      <View style={styles.filters}>
        <Text style={styles.filterLabel}>Group by</Text>
        <Chip label="Vertical" on={groupBy === 'vertical'} onPress={() => setGroupBy('vertical')} />
        <Chip label="Level" on={groupBy === 'level'} onPress={() => setGroupBy('level')} />
        <Chip label="Code" on={groupBy === 'code'} onPress={() => setGroupBy('code')} />
        <Text style={[styles.filterLabel, styles.gap]}>Level</Text>
        <Chip label="All" on={!filter.levelId} onPress={() => set({ levelId: null })} />
        {data?.levels.map((l) => (
          <Chip key={l.id} label={l.code} on={filter.levelId === l.id} onPress={() => set({ levelId: l.id })} />
        ))}
      </View>
      <View style={styles.filters}>
        <Text style={styles.filterLabel}>Code</Text>
        <Chip label="All" on={!filter.code} onPress={() => set({ code: null })} />
        {presentCodes.map((c) => (
          <Chip key={c} label={c} on={filter.code === c} onPress={() => set({ code: c })} />
        ))}
        <Text style={[styles.filterLabel, styles.gap]}>Status</Text>
        <Chip label="All" on={!filter.status} onPress={() => set({ status: null })} />
        {STATUSES.map((s) => (
          <Chip key={s} label={s} on={filter.status === s} onPress={() => set({ status: s })} />
        ))}
        <Text style={[styles.filterLabel, styles.gap]}>Checks</Text>
        <Chip label="☑ only" on={!!filter.check} onPress={() => set({ check: filter.check ? null : 'any' })} />
      </View>

      <View style={styles.body}>
        <View style={styles.list}>
          <View style={[styles.tr, styles.th]}>
            {picked ? <Text style={styles.tick} /> : null}
            <Text style={[styles.cCode, styles.thText]}>Code</Text>
            <Text style={[styles.cEnd, styles.thText]}>A</Text>
            <Text style={[styles.cStatus, styles.thText]}>A status</Text>
            <Text style={[styles.cEnd, styles.thText]}>B</Text>
            <Text style={[styles.cStatus, styles.thText]}>B status</Text>
            <Text style={[styles.cChecks, styles.thText]}>⚑</Text>
          </View>
          <FlatList
            data={items}
            keyExtractor={(it) => it.key}
            renderItem={({ item }) =>
              item.type === 'group' ? (
                <Pressable
                  style={styles.groupHead}
                  onPress={() =>
                    setCollapsed((cur) => {
                      const next = new Set(cur);
                      if (next.has(item.key)) next.delete(item.key);
                      else next.add(item.key);
                      return next;
                    })
                  }>
                  <Text style={styles.groupTitle}>
                    {item.collapsed ? '▸' : '▾'} {item.title} <Text style={styles.groupCount}>{item.count}</Text>
                  </Text>
                </Pressable>
              ) : (
                <CableLine
                  row={item.row}
                  on={item.row.id === selected}
                  picked={picked ? picked.has(item.row.id) : null}
                  onPress={() => {
                    if (picked) {
                      const next = new Set(picked);
                      if (next.has(item.row.id)) next.delete(item.row.id);
                      else next.add(item.row.id);
                      setPicked(next);
                    } else setSelected(item.row.id);
                  }}
                />
              )
            }
            ListEmptyComponent={<Text style={styles.empty}>{data ? 'No cables match.' : 'Loading…'}</Text>}
          />
        </View>
        <View style={styles.panel}>
          {row && endId && store ? (
            <EndEditor
              key={endId}
              store={store}
              editor={editor}
              endId={endId}
              reloadKey={`${tick}|${dataKey}`}
              names={names}
              backLabel="Cables"
              onBack={() => setSelected(null)}
              onEdited={reload}
              onJump={(t) => router.push({ pathname: '/plan/[levelId]', params: { levelId: t.levelId, device: t.deviceId } })}
              canOpenLevels
              resolveBlobUri={resolveBlobUri}
              footer={
                <>
                  <CableChecks row={row} names={data?.names} canEdit={!!editor} onConfirm={() => confirm(row)} projectId={projectId} />
                  <RiserCrop store={store} projectId={projectId} riser={row.riserRef} blobs={blobs} />
                </>
              }
            />
          ) : row ? (
            <ScrollView contentContainerStyle={styles.panelBody}>
              <Text style={styles.empty}>This cable has no ends.</Text>
              <CableChecks row={row} names={data?.names} canEdit={!!editor} onConfirm={() => confirm(row)} projectId={projectId} />
            </ScrollView>
          ) : (
            <Text style={styles.empty}>Select a cable.</Text>
          )}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerLabel}>Consistency checks (project)</Text>
        {CABLE_CHECKS.map((k) => (
          <Pressable key={k.id} onPress={() => set({ check: filter.check === k.id ? null : k.id })} style={[styles.count, filter.check === k.id && styles.countOn]}>
            <Text style={[styles.countText, filter.check === k.id && styles.countTextOn, !!data?.totals[k.id] && filter.check !== k.id && styles.countWarn]}>
              {k.title} {data?.totals[k.id] ?? '…'}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function CableLine({ row: r, on, picked, onPress }: { row: CableRow; on: boolean; picked: boolean | null; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tr, on && styles.rowOn]}>
      {picked != null ? <Text style={styles.tick}>{picked ? '☑' : '☐'}</Text> : null}
      <Text style={styles.cCode} numberOfLines={1}>
        {r.code ?? '?'}
        {r.singleRow ? ' ·1' : ''}
      </Text>
      <Text style={styles.cEnd} numberOfLines={1}>
        {endCell(r.a)} {r.a?.levelCode && r.b?.levelCode !== r.a.levelCode ? `(${r.a.levelCode})` : ''}
      </Text>
      <StatusText value={statusCell(r.a)} />
      <Text style={styles.cEnd} numberOfLines={1}>
        {endCell(r.b)} {r.b?.levelCode && r.b.levelCode !== r.a?.levelCode ? `(${r.b.levelCode})` : ''}
      </Text>
      <StatusText value={statusCell(r.b)} />
      <Text style={[styles.cChecks, r.checks.length ? styles.warn : styles.ok]}>
        {r.checks.length ? `⚠${r.checks.length}` : '✓'}
        {r.reviewItemId ? ' ⓡ' : ''}
      </Text>
    </Pressable>
  );
}

function StatusText({ value }: { value: string }) {
  const st = pinStyleFor(value === UNSURVEYED || value.startsWith('⚠') ? null : value);
  return (
    <Text style={[styles.cStatus, { color: value.startsWith('⚠') ? '#e65100' : st.fill }]} numberOfLines={1}>
      {value}
    </Text>
  );
}

function CableChecks({ row: r, names, canEdit, onConfirm, projectId }: { row: CableRow; names: CodeNames | undefined; canEdit: boolean; onConfirm: () => void; projectId: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        Checks on this cable · {codeTitle(r.code, names)}
        {r.vertical ? ` · ${r.vertical}` : ''}
      </Text>
      {r.checks.length ? (
        r.checks.map((k, i) => (
          <View key={`${k.id}${i}`}>
            <Text style={styles.finding}>
              ⚠ {CABLE_CHECKS.find((c) => c.id === k.id)?.title}: {k.message}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.okText}>✓ none</Text>
      )}
      {r.checks.length ? <Text style={styles.muted}>{[...new Set(r.checks.map((k) => CABLE_CHECKS.find((c) => c.id === k.id)!.hint))].join(' ')}</Text> : null}
      <View style={styles.btnRow}>
        {!r.endpointConfirmed ? <Btn label="Confirm endpoint" small disabled={!canEdit} onPress={onConfirm} /> : <Text style={styles.muted}>Endpoint confirmed{r.origin ? ` · origin ${r.origin}` : ''}</Text>}
        {r.reviewItemId && projectId ? <Btn label="Open Needs review item ▸" small plain onPress={() => router.push({ pathname: '/review', params: { project: projectId, item: r.reviewItemId! } })} /> : null}
      </View>
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

function Btn({ label, onPress, disabled, plain, small }: { label: string; onPress: () => void; disabled?: boolean; plain?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, plain && styles.btnPlain, small && styles.btnSmall, disabled && styles.off]} accessibilityRole="button">
      <Text style={[styles.btnText, plain && styles.btnTextPlain, small && styles.btnTextSmall]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16 },
  title: { fontSize: 24, fontWeight: '600' },
  link: { color: '#1f6feb', fontSize: 16 },
  filters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingHorizontal: 20, paddingTop: 8 },
  filterLabel: { fontSize: 14, color: '#555' },
  gap: { marginLeft: 14 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111', fontSize: 13 },
  chipTextOn: { color: '#fff', fontSize: 13 },
  body: { flex: 1, flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e1e4e8', marginTop: 10 },
  list: { width: '62%', borderRightWidth: 1, borderRightColor: '#e1e4e8' },
  panel: { flex: 1 },
  panelBody: { padding: 8, gap: 8 },
  th: { backgroundColor: '#fafbfc', borderBottomWidth: 1, borderBottomColor: '#e1e4e8' },
  thText: { fontWeight: '700', color: '#444' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  rowOn: { backgroundColor: '#dce8fb' },
  tick: { width: 22, fontSize: 18 },
  cCode: { width: 56, fontSize: 14, fontWeight: '600' },
  cEnd: { flex: 3, fontSize: 14, fontVariant: ['tabular-nums'] },
  cStatus: { flex: 2, fontSize: 13 },
  cChecks: { width: 54, fontSize: 13, textAlign: 'right' },
  warn: { color: '#e65100', fontWeight: '700' },
  ok: { color: '#2e7d32' },
  groupHead: { paddingVertical: 9, paddingHorizontal: 12, backgroundColor: '#f4f5f7', borderBottomWidth: 1, borderBottomColor: '#e1e4e8' },
  groupTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  groupCount: { fontSize: 13, fontWeight: '400', color: '#777' },
  empty: { fontSize: 15, color: '#666', padding: 16 },
  section: { marginHorizontal: 8, marginTop: 8, padding: 10, gap: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  finding: { fontSize: 13, color: '#e65100' },
  okText: { fontSize: 13, color: '#2e7d32', fontWeight: '600' },
  muted: { fontSize: 12, color: '#777' },
  btnRow: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  btn: { backgroundColor: '#1f6feb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: '#1f6feb' },
  btnPlain: { backgroundColor: '#fff' },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  btnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  btnTextPlain: { color: '#1f6feb' },
  btnTextSmall: { fontSize: 13 },
  off: { opacity: 0.4 },
  note: { color: '#0a5', fontSize: 14, padding: 8 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#e1e4e8', backgroundColor: '#fafbfc' },
  footerLabel: { fontSize: 13, fontWeight: '700', color: '#444', marginRight: 6 },
  count: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: '#d6d9de' },
  countOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  countText: { fontSize: 13, color: '#333' },
  countTextOn: { color: '#fff' },
  countWarn: { color: '#e65100', fontWeight: '600' },
});
