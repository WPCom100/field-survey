import { vocab, type Store } from '@field-survey/core';
import { draftFromSelection } from '@field-survey/rules';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
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
import { Btn as UiBtn, Chip as UiChip, FilterLabel, FilterRow, PageHeader, PAGE_GUTTER, color, fieldStyles, font, radius, space, tabular } from '../ui';

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
      <PageHeader
        title="Dashboard"
        caption={asOf}
        actions={
          <>
            <UiBtn kind="tertiary" title="← Levels" onPress={() => router.dismissTo(projectId ? { pathname: '/', params: { project: projectId } } : '/')} />
            <TextInput
              style={styles.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search the project: ID, tag, room, item, notes, Neuron ID, IP, DMX"
              placeholderTextColor={color.text3}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              testID="dash.search"
            />
          </>
        }
      />
      <FilterRow>
        <FilterLabel text="Levels" />
        <Chip label="All" on={!filter.levelId} onPress={() => setFilter((f) => ({ ...f, levelId: null }))} testID="dash.level.all" />
        {data?.levels.map((l) => (
          <Chip key={l.id} label={l.code} on={filter.levelId === l.id} onPress={() => setFilter((f) => ({ ...f, levelId: l.id }))} testID={`dash.level.${l.code}`} />
        ))}
        <FilterLabel text="Owner" gap />
        <Chip label="All" on={!filter.owner} onPress={() => setFilter((f) => ({ ...f, owner: null }))} testID="dash.owner.all" />
        {vocab.OWNER.map((o) => (
          <Chip key={o} label={o} on={filter.owner === o} onPress={() => setFilter((f) => ({ ...f, owner: o }))} testID={`dash.owner.${o}`} />
        ))}
      </FilterRow>

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
              <CountLink text={`field additions ${found.fieldAdditions}`} on={drill?.table === 'asFound' && drill.key === 'fieldAdditions'} onPress={() => open({ table: 'asFound', key: 'fieldAdditions', status: null })} testID="dash.found.fieldAdditions" />
              <Text style={styles.muted}>·</Text>
              <CountLink text={`never found ${found.neverFound}`} on={drill?.table === 'asFound' && drill.key === 'neverFound'} onPress={() => open({ table: 'asFound', key: 'neverFound', status: null })} testID="dash.found.neverFound" />
              <Text style={styles.muted}>·</Text>
              <CountLink text={`Neuron IDs captured ${found.neuronCaptured}/${found.neuronDevices}`} on={drill?.table === 'asFound' && drill.key === 'neuronMissing'} onPress={() => open({ table: 'asFound', key: 'neuronMissing', status: null })} testID="dash.found.neuronMissing" />
              <Text style={styles.muted}>·</Text>
              <CountLink text={`IP addresses captured ${found.ipCaptured}/${found.ipDevices}`} on={drill?.table === 'asFound' && drill.key === 'ipMissing'} onPress={() => open({ table: 'asFound', key: 'ipMissing', status: null })} testID="dash.found.ipMissing" />
              <Text style={styles.muted}>·</Text>
              <CountLink text={`DMX addresses captured ${found.dmxCaptured}/${found.dmxDevices}`} on={drill?.table === 'asFound' && drill.key === 'dmxMissing'} onPress={() => open({ table: 'asFound', key: 'dmxMissing', status: null })} testID="dash.found.dmxMissing" />
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
                      } testID={`dash.ready.${r.code}`}>
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
              <Text style={styles.panelTitle} numberOfLines={2} testID="dash.panel.title">
                {panel.kind === 'drill' ? `${drillTitle(panel.drill)} (${rows.length})` : `Search “${query.trim()}” (${(results ?? []).reduce((n, g) => n + g.results.length, 0)})`}
              </Text>
              {panel.kind === 'drill' && rows.length ? (
                picked ? (
                  <>
                    <Btn label={`All ${rows.length}`} onPress={() => setPicked(new Set(rows.map((r) => r.id)))} testID="dash.select.all" />
                    <Btn label={`Apply as ruling… (${picked.size})`} disabled={!picked.size} onPress={applyAsRuling} testID="dash.select.apply" />
                    <Btn label="Cancel" plain onPress={() => setPicked(null)} testID="dash.select.cancel" />
                  </>
                ) : (
                  <Btn label="Select" plain onPress={() => setPicked(new Set())} testID="dash.select" />
                )
              ) : null}
              <Btn
                label="Close"
                plain
                testID="dash.close"
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
    <Pressable key={`${key}|${status}`} style={[styles.cell, isOn(key, status) && styles.cellOn]} onPress={() => onPress({ table: t.id, key, status })} testID={`dash.cell.${t.id}.${key ?? 'total'}.${status ?? 'total'}`}>
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
    <Pressable onPress={onPress} style={styles.listRow} testID="dash.row">
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
    <Pressable onPress={onPress} style={styles.listRow} disabled={!r.levelId} testID="dash.search.row">
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

function CountLink({ text, on, onPress, testID }: { text: string; on: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} style={[styles.countLink, on && styles.cellOn]} testID={testID}>
      <Text style={[styles.lineText, styles.linkText, on && styles.cellTextOn]}>{text}</Text>
    </Pressable>
  );
}

/** The screen's chips and buttons over the UI system's (T179): small chips; a `plain` button is secondary, the others primary. */
function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  return <UiChip small label={label} selected={on} onPress={onPress} testID={testID} />;
}

function Btn({ label, onPress, disabled, plain, testID }: { label: string; onPress: () => void; disabled?: boolean; plain?: boolean; testID?: string }) {
  return <UiBtn small title={label} onPress={onPress} disabled={disabled} kind={plain ? 'secondary' : 'primary'} testID={testID} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  search: { ...fieldStyles.input, ...font.callout, width: 380 },
  body: { flex: 1, flexDirection: 'row', marginTop: space.md, borderTopWidth: 1, borderTopColor: color.hairline },
  main: { flex: 1 },
  mainBody: { paddingHorizontal: PAGE_GUTTER, paddingVertical: space.lg, gap: space.lg },
  section: { gap: space.sm },
  sectionTitle: { ...font.headline, color: color.text },
  sectionRow: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' },
  grid: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.card, overflow: 'hidden', alignSelf: 'flex-start' },
  tr: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  th: { backgroundColor: color.surface2 },
  thText: { ...font.captionBold, fontSize: 12, color: color.text2 },
  thCell: { textAlign: 'center' },
  totalRow: { backgroundColor: color.bg },
  keyCell: { width: 72, paddingHorizontal: space.sm, paddingVertical: 7, ...font.callout, color: color.text },
  dateCell: { width: 86, paddingHorizontal: space.xs, ...font.caption, fontSize: 12, color: color.text2, textAlign: 'center' },
  cell: { width: 70, paddingVertical: 7, alignItems: 'center', justifyContent: 'center' },
  cellOn: { backgroundColor: color.primary, borderRadius: radius.swatch },
  cellText: { ...font.callout, ...tabular, color: color.primary, textAlign: 'center' },
  cellTextOn: { color: color.onPrimary },
  zero: { color: color.text3 },
  bold: { fontWeight: '700' },
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  lineLabel: { ...font.calloutBold, color: color.text },
  lineText: { ...font.callout, color: color.text },
  linkText: { color: color.primary },
  countLink: { paddingHorizontal: space.xs, paddingVertical: 2 },
  readiness: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  surveying: { color: color.success, fontWeight: '600' },
  ready: { color: color.primary, fontWeight: '600' },
  setup: { color: color.warning },
  muted: { ...font.caption, color: color.text3 },
  empty: { ...font.callout, color: color.text3, padding: space.lg },
  panel: { width: '40%', backgroundColor: color.surface, borderLeftWidth: 1, borderLeftColor: color.hairline },
  panelHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: 10, borderBottomWidth: 1, borderBottomColor: color.hairline, backgroundColor: color.surface2 },
  panelTitle: { flex: 1, minWidth: 160, ...font.calloutBold, color: color.text },
  groupTitle: { ...font.captionBold, color: color.text2, paddingVertical: space.sm, paddingHorizontal: space.md, backgroundColor: color.surface2 },
  groupCount: { fontWeight: '400', color: color.text3 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44, paddingVertical: 9, paddingHorizontal: space.md, borderBottomWidth: 1, borderBottomColor: color.hairline },
  tick: { width: 22, fontSize: 18, color: color.text },
  listLevel: { width: 40, ...font.caption, color: color.text2 },
  listLabel: { width: 84, ...font.calloutBold, ...tabular, color: color.text },
  listText: { flex: 1, ...font.caption, color: color.text2 },
  chev: { fontSize: 14, color: color.muted },
});
