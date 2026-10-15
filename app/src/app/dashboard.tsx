import { vocab, type Store } from '@field-survey/core';
import { draftFromSelection } from '@field-survey/rules';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { StackedBars } from '../dashboard/StackedBars';
import {
  asFound,
  drillRows,
  drillTitle,
  loadDashboard,
  searchProject,
  summaryTables,
  type DashFilter,
  type DashRow,
  type DashboardData,
  type Drill,
  type SearchGroup,
  type SearchResult,
  type SummaryTable,
} from '../dashboard/model';
import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { handRuling } from '../rulings/handoff';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

type Panel = { kind: 'drill'; drill: Drill } | { kind: 'search' } | null;

/**
 * Dashboard (T38, Phase 3 §7, D17): the export's four Summary tables from the local store with a
 * stacked bar chart each, Levels and Owner filters, the as-found line and per-level readiness.
 * Tapping any count opens the records behind it in the side panel; a row opens its card on the
 * plan, and Select → Apply as ruling… hands the chosen records to the ruling editor (T37). The
 * search box searches the whole project, grouped by entity. `?project=` names the project.
 */
export default function DashboardScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [filter, setFilter] = useState<DashFilter>({});
  const [panel, setPanel] = useState<Panel>(null);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchGroup[] | null>(null);
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
    loadDashboard(store, projectId).then(
      (d) => live && setData(d),
      (e: unknown) => live && setNote(String(e)),
    );
    return () => {
      live = false;
    };
  }, [store, projectId, tick, dataKey]);

  // Search as you type, a quarter second after the last key.
  useEffect(() => {
    if (!store || !projectId) return;
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      searchProject(store, projectId, query).then(
        (r) => live && setResults(r),
        (e: unknown) => live && setNote(String(e)),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [store, projectId, query, tick, dataKey]);
  // Typing opens the results; a sync while a drill-down is open leaves it open.
  useEffect(() => {
    if (!query.trim()) return;
    setPanel({ kind: 'search' });
    setPicked(null);
  }, [query]);

  const tables = useMemo(() => (data ? summaryTables(data, filter) : []), [data, filter]);
  const found = useMemo(() => (data ? asFound(data, filter) : null), [data, filter]);
  const drill = panel?.kind === 'drill' ? panel.drill : null;
  const rows = useMemo(() => (data && drill ? drillRows(data, drill, filter) : []), [data, drill, filter]);

  const open = (d: Drill) => {
    setPanel({ kind: 'drill', drill: d });
    setPicked(null);
  };
  const openCard = (r: { levelId: string | null; deviceId: string | null }) => {
    if (!r.levelId) return;
    router.push({ pathname: '/plan/[levelId]', params: { levelId: r.levelId, ...(r.deviceId ? { device: r.deviceId } : {}) } });
  };
  const applyAsRuling = () => {
    if (!picked?.size || !projectId || !drill) return;
    const chosen = rows.filter((r) => picked.has(r.id));
    if (!chosen.length) return;
    handRuling(projectId, draftFromSelection(chosen[0]!.entity, chosen.map((r) => r.id), chosen.map((r) => r.levelCode)), `Dashboard: ${drillTitle(drill)}`);
    setPicked(null);
    router.push({ pathname: '/rulings', params: { project: projectId, from: 'handoff' } });
  };

  const asOf = sync.lastSyncAt ? `as of sync ${new Date(sync.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (local data)` : 'not synced yet (local data)';

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>Dashboard</Text>
        <Link href={projectId ? { pathname: '/', params: { project: projectId } } : '/'} style={styles.link}>
          ← Levels
        </Link>
        <Text style={styles.muted}>{asOf}</Text>
        <View style={styles.flex} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search the project: ID, tag, room, item, notes, Neuron ID"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      <View style={styles.filters}>
        <Text style={styles.filterLabel}>Levels</Text>
        <Chip label="All" on={!filter.levelId} onPress={() => setFilter((f) => ({ ...f, levelId: null }))} />
        {data?.levels.map((l) => (
          <Chip key={l.id} label={l.code} on={filter.levelId === l.id} onPress={() => setFilter((f) => ({ ...f, levelId: l.id }))} />
        ))}
        <Text style={[styles.filterLabel, styles.gap]}>Owner</Text>
        <Chip label="All" on={!filter.owner} onPress={() => setFilter((f) => ({ ...f, owner: null }))} />
        {vocab.OWNER.map((o) => (
          <Chip key={o} label={o} on={filter.owner === o} onPress={() => setFilter((f) => ({ ...f, owner: o }))} />
        ))}
      </View>

      <View style={styles.body}>
        <ScrollView style={styles.main} contentContainerStyle={styles.mainBody}>
          {!data ? <Text style={styles.empty}>{note || 'Loading…'}</Text> : null}
          {tables.map((t) => (
            <View key={t.id} style={styles.section}>
              <Text style={styles.sectionTitle}>{t.title}</Text>
              <View style={styles.sectionRow}>
                <SummaryGrid table={t} drill={drill} onPress={open} />
                <StackedBars table={t} />
              </View>
              {t.outside ? <Text style={styles.muted}>{t.id === 'devices' ? `${t.outside} Unsurveyed (in no column, as the export)` : `${t.outside} without a status (in no column, as the export)`}</Text> : null}
            </View>
          ))}
          {found ? (
            <View style={styles.line}>
              <Text style={styles.lineLabel}>As-found:</Text>
              <CountLink text={`field additions ${found.fieldAdditions}`} on={drill?.table === 'asFound' && drill.key === 'fieldAdditions'} onPress={() => open({ table: 'asFound', key: 'fieldAdditions', status: null })} />
              <Text style={styles.muted}>·</Text>
              <CountLink text={`never found ${found.neverFound}`} on={drill?.table === 'asFound' && drill.key === 'neverFound'} onPress={() => open({ table: 'asFound', key: 'neverFound', status: null })} />
              <Text style={styles.muted}>·</Text>
              <CountLink text={`Neuron IDs captured ${found.neuronCaptured}/${found.neuronDevices}`} on={drill?.table === 'asFound' && drill.key === 'neuronMissing'} onPress={() => open({ table: 'asFound', key: 'neuronMissing', status: null })} />
            </View>
          ) : null}
          {data ? (
            <View style={styles.line}>
              <Text style={styles.lineLabel}>Readiness:</Text>
              {data.readiness
                .filter((r) => !filter.levelId || r.levelId === filter.levelId)
                .map((r, i) => (
                  <View key={r.levelId} style={styles.readiness}>
                    {i ? <Text style={styles.muted}>·</Text> : null}
                    <Pressable
                      onPress={() =>
                        r.toReview && projectId ? router.push({ pathname: '/review', params: { project: projectId } }) : router.push({ pathname: '/plan/[levelId]', params: { levelId: r.levelId } })
                      }>
                      <Text style={[styles.lineText, r.state === 'surveying' ? styles.surveying : r.state === 'ready' ? styles.ready : styles.setup]}>
                        {r.code} {r.state}
                        {r.toReview ? ` (${r.toReview} review)` : ''}
                      </Text>
                    </Pressable>
                  </View>
                ))}
            </View>
          ) : null}
          {data ? <Text style={styles.muted}>Same counts as the export&apos;s Summary tab: in-scope levels, live records; tap any count for its list.</Text> : null}
        </ScrollView>

        {panel ? (
          <View style={styles.panel}>
            <View style={styles.panelHead}>
              <Text style={styles.panelTitle} numberOfLines={2}>
                {panel.kind === 'drill' ? `${drillTitle(panel.drill)} (${rows.length})` : `Search “${query.trim()}” (${(results ?? []).reduce((n, g) => n + g.results.length, 0)})`}
              </Text>
              {panel.kind === 'drill' && rows.length ? (
                picked ? (
                  <>
                    <Btn label={`All ${rows.length}`} onPress={() => setPicked(new Set(rows.map((r) => r.id)))} />
                    <Btn label={`Apply as ruling… (${picked.size})`} disabled={!picked.size} onPress={applyAsRuling} />
                    <Btn label="Cancel" plain onPress={() => setPicked(null)} />
                  </>
                ) : (
                  <Btn label="Select" plain onPress={() => setPicked(new Set())} />
                )
              ) : null}
              <Btn
                label="Close"
                plain
                onPress={() => {
                  setPanel(null);
                  setPicked(null);
                  if (panel.kind === 'search') setQuery('');
                }}
              />
            </View>
            {panel.kind === 'drill' ? (
              <FlatList
                data={rows}
                keyExtractor={(r) => r.id}
                renderItem={({ item }) => (
                  <DrillLine
                    row={item}
                    picked={picked ? picked.has(item.id) : null}
                    onPress={() => {
                      if (!picked) return openCard(item);
                      const next = new Set(picked);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      setPicked(next);
                    }}
                  />
                )}
                ListEmptyComponent={<Text style={styles.empty}>Nothing here.</Text>}
              />
            ) : (
              <FlatList
                data={(results ?? []).flatMap((g) => [{ type: 'group' as const, key: g.kind, g }, ...g.results.map((r) => ({ type: 'row' as const, key: r.id, r }))])}
                keyExtractor={(it) => it.key}
                renderItem={({ item }) =>
                  item.type === 'group' ? (
                    <Text style={styles.groupTitle}>
                      {item.g.title} <Text style={styles.groupCount}>{item.g.results.length}</Text>
                    </Text>
                  ) : (
                    <SearchLine r={item.r} onPress={() => openCard(item.r)} />
                  )
                }
                ListEmptyComponent={<Text style={styles.empty}>{results ? 'No matches.' : 'Searching…'}</Text>}
              />
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function SummaryGrid({ table: t, drill, onPress }: { table: SummaryTable; drill: Drill | null; onPress: (d: Drill) => void }) {
  const isOn = (key: string | null, status: string | null) => drill?.table === t.id && drill.key === key && drill.status === status;
  const cell = (n: number, key: string | null, status: string | null, bold = false) => (
    <Pressable key={`${key}|${status}`} style={[styles.cell, isOn(key, status) && styles.cellOn]} onPress={() => onPress({ table: t.id, key, status })}>
      <Text style={[styles.cellText, bold && styles.bold, !n && styles.zero, isOn(key, status) && styles.cellTextOn]}>{n}</Text>
    </Pressable>
  );
  return (
    <View style={styles.grid}>
      <View style={[styles.tr, styles.th]}>
        <Text style={[styles.keyCell, styles.thText]}>{t.keyHeader}</Text>
        {t.dates ? (
          <>
            <Text style={[styles.dateCell, styles.thText]}>Surveyed</Text>
            <Text style={[styles.dateCell, styles.thText]}>Updated</Text>
          </>
        ) : null}
        {t.statuses.map((s) => (
          <Text key={s} style={[styles.cell, styles.thText, styles.thCell]} numberOfLines={2}>
            {s}
          </Text>
        ))}
        <Text style={[styles.cell, styles.thText, styles.thCell]}>Total</Text>
      </View>
      {t.keys.map((k, i) => (
        <View key={k} style={styles.tr}>
          <Text style={styles.keyCell}>{k}</Text>
          {t.dates ? (
            <>
              <Text style={styles.dateCell}>{t.dates.surveyed[i] ?? ''}</Text>
              <Text style={styles.dateCell}>{t.dates.updated[i] ?? ''}</Text>
            </>
          ) : null}
          {t.statuses.map((s, j) => cell(t.counts[i]![j]!, k, s))}
          {cell(t.rowTotals[i]!, k, null, true)}
        </View>
      ))}
      <View style={[styles.tr, styles.totalRow]}>
        <Text style={[styles.keyCell, styles.bold]}>Total</Text>
        {t.dates ? (
          <>
            <Text style={styles.dateCell} />
            <Text style={styles.dateCell} />
          </>
        ) : null}
        {t.statuses.map((s, j) => cell(t.columnTotals[j]!, null, s, true))}
        {cell(t.total, null, null, true)}
      </View>
    </View>
  );
}

function DrillLine({ row: r, picked, onPress }: { row: DashRow; picked: boolean | null; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.listRow}>
      {picked != null ? <Text style={styles.tick}>{picked ? '☑' : '☐'}</Text> : null}
      <Text style={styles.listLevel}>{r.levelCode}</Text>
      <Text style={styles.listLabel} numberOfLines={1}>
        {r.label}
      </Text>
      <Text style={styles.listText} numberOfLines={2}>
        {r.text}
        {r.owner ? ` · ${r.owner}` : ''} · {r.status || '—'}
      </Text>
      {picked == null ? <Text style={styles.chev}>▸</Text> : null}
    </Pressable>
  );
}

function SearchLine({ r, onPress }: { r: SearchResult; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.listRow} disabled={!r.levelId}>
      <Text style={styles.listLevel}>{r.levelCode}</Text>
      <Text style={styles.listLabel} numberOfLines={1}>
        {r.label}
      </Text>
      <Text style={styles.listText} numberOfLines={2}>
        {r.text}
      </Text>
      <Text style={styles.chev}>▸</Text>
    </Pressable>
  );
}

function CountLink({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.countLink, on && styles.cellOn]}>
      <Text style={[styles.lineText, styles.linkText, on && styles.cellTextOn]}>{text}</Text>
    </Pressable>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function Btn({ label, onPress, disabled, plain }: { label: string; onPress: () => void; disabled?: boolean; plain?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, plain && styles.btnPlain, disabled && styles.off]} accessibilityRole="button">
      <Text style={[styles.btnText, plain && styles.btnTextPlain]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16 },
  title: { fontSize: 24, fontWeight: '600' },
  link: { color: '#1f6feb', fontSize: 16 },
  search: { width: 380, borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 15 },
  filters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingHorizontal: 20, paddingTop: 8 },
  filterLabel: { fontSize: 14, color: '#555' },
  gap: { marginLeft: 14 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111', fontSize: 13 },
  chipTextOn: { color: '#fff', fontSize: 13 },
  body: { flex: 1, flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e1e4e8', marginTop: 10 },
  main: { flex: 1 },
  mainBody: { padding: 16, gap: 18 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: '#222' },
  sectionRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  grid: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de', borderRadius: 4, alignSelf: 'flex-start' },
  tr: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e1e4e8' },
  th: { backgroundColor: '#fafbfc' },
  thText: { fontWeight: '700', color: '#444', fontSize: 12 },
  thCell: { textAlign: 'center' },
  totalRow: { backgroundColor: '#f4f5f7' },
  keyCell: { width: 64, paddingHorizontal: 8, paddingVertical: 7, fontSize: 14 },
  dateCell: { width: 86, paddingHorizontal: 4, fontSize: 12, color: '#555', textAlign: 'center' },
  cell: { width: 70, paddingVertical: 7, alignItems: 'center', justifyContent: 'center' },
  cellOn: { backgroundColor: '#1565c0', borderRadius: 4 },
  cellText: { fontSize: 14, color: '#1f6feb', fontVariant: ['tabular-nums'], textAlign: 'center' },
  cellTextOn: { color: '#fff' },
  zero: { color: '#9aa0a6' },
  bold: { fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  lineLabel: { fontSize: 15, fontWeight: '700', color: '#222' },
  lineText: { fontSize: 15, color: '#222' },
  linkText: { color: '#1f6feb' },
  countLink: { paddingHorizontal: 4, paddingVertical: 2 },
  readiness: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  surveying: { color: '#2e7d32', fontWeight: '600' },
  ready: { color: '#1565c0', fontWeight: '600' },
  setup: { color: '#e65100' },
  muted: { fontSize: 13, color: '#777' },
  empty: { fontSize: 15, color: '#666', padding: 16 },
  panel: { width: '40%', borderLeftWidth: 1, borderLeftColor: '#e1e4e8' },
  panelHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: 10, borderBottomWidth: 1, borderBottomColor: '#e1e4e8', backgroundColor: '#fafbfc' },
  panelTitle: { flex: 1, minWidth: 160, fontSize: 15, fontWeight: '700', color: '#333' },
  groupTitle: { fontSize: 14, fontWeight: '700', color: '#333', paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f4f5f7' },
  groupCount: { fontWeight: '400', color: '#777' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  tick: { width: 22, fontSize: 18 },
  listLevel: { width: 40, fontSize: 13, color: '#555' },
  listLabel: { width: 84, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  listText: { flex: 1, fontSize: 13, color: '#333' },
  chev: { fontSize: 14, color: '#9aa0a6' },
  btn: { backgroundColor: '#1f6feb', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: '#1f6feb' },
  btnPlain: { backgroundColor: '#fff' },
  btnText: { color: 'white', fontSize: 13, fontWeight: '600' },
  btnTextPlain: { color: '#1f6feb' },
  off: { opacity: 0.4 },
});
