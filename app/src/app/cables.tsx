import { Editor, vocab, type BlobQueue, type Store } from '@field-survey/core';
import { draftFromSelection } from '@field-survey/rules';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
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
import { SectionScreen } from '../home/SectionScreen';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { logTo } from '../log';
import { pinStyleFor } from '../plan/pins';
import { handRuling } from '../rulings/handoff';
import { useRulesVersion } from '../rules/useRulesVersion';
import { projectDataKey } from '../sync/dataKey';
import { useReload } from '../sync/useReload';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Btn as UiBtn, Chip as UiChip, FilterLabel, FilterRow, PAGE_GUTTER, Swatch, color, font, hitSlopTo, radius, space, tabular } from '../ui';

type Item = { type: 'group'; key: string; title: string; count: number; collapsed: boolean } | { type: 'row'; key: string; row: CableRow };

const STATUSES: readonly string[] = [...vocab.CONNECTION_STATUS, UNSURVEYED];

/**
 * Cable / riser view (T39, Phase 3 §5): every cable of the project with both ends, grouped by
 * vertical, level or code, filtered by code, end status and checks; the project's consistency
 * check counts along the bottom (tap one to filter). Selecting a cable opens the connection end
 * editor (T22) in the side panel with the cable's checks, Confirm endpoint (D6, D180), its Needs
 * review item and the riser crop below it; the editor's ⋯ deletes the cable (T138). Select → Apply as ruling… hands the chosen cables' ends
 * to the ruling editor (T37). `?project=` names the project.
 */
export default function CablesScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const [blobs, setBlobs] = useState<BlobQueue | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // this project's pulls and rules runs only (T185, T186)
  const dataKey = projectDataKey(sync, projectId);
  const rulesKey = useRulesVersion(projectId);
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

  // T186: a pull or a rules run during a load no longer throws it away (useReload)
  useReload({
    name: 'cables',
    subject: store && projectId ? projectId : null,
    reloadKey: `${tick}|${dataKey}|${rulesKey}`,
    load: () => loadCables(store!, projectId!),
    apply: setData,
    fail: (e) => setNote(String(e)),
  });

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
    <SectionScreen
      section="Cable / riser"
      projectId={projectId}
      title={title}
      intro="Every cable of the project with both ends; the project's consistency checks along the bottom."
      backTestID="cables.back"
      actions={
          <>
            {picked ? (
              <>
                <Btn label={`All ${shown.length}`} onPress={() => setPicked(new Set(shown.map((r) => r.id)))} testID="cables.select.all" />
                <Btn label={`Apply as ruling… (${picked.size})`} disabled={!picked.size} onPress={applyAsRuling} testID="cables.select.apply" />
                <Btn label="Cancel" plain onPress={() => setPicked(null)} testID="cables.select.cancel" />
              </>
            ) : (
              <Btn label="Select" plain onPress={() => setPicked(new Set())} testID="cables.select" />
            )}
          </>
      }
    >
      <FilterRow style={styles.filters}>
        <FilterLabel text="Group by" />
        <Chip label="Vertical" on={groupBy === 'vertical'} onPress={() => setGroupBy('vertical')} testID="cables.groupBy.vertical" />
        <Chip label="Level" on={groupBy === 'level'} onPress={() => setGroupBy('level')} testID="cables.groupBy.level" />
        <Chip label="Code" on={groupBy === 'code'} onPress={() => setGroupBy('code')} testID="cables.groupBy.code" />
        <FilterLabel text="Level" gap />
        <Chip label="All" on={!filter.levelId} onPress={() => set({ levelId: null })} testID="cables.level.all" />
        {data?.levels.map((l) => (
          <Chip key={l.id} label={l.code} on={filter.levelId === l.id} onPress={() => set({ levelId: l.id })} testID={`cables.level.${l.code}`} />
        ))}
        <FilterLabel text="Code" gap />
        <Chip label="All" on={!filter.code} onPress={() => set({ code: null })} testID="cables.code.all" />
        {presentCodes.map((c) => (
          <Chip key={c} label={c} on={filter.code === c} onPress={() => set({ code: c })} testID={`cables.code.${c}`} />
        ))}
        <FilterLabel text="Status" gap />
        <Chip label="All" on={!filter.status} onPress={() => set({ status: null })} testID="cables.status.all" />
        {STATUSES.map((s) => (
          <Chip key={s} label={s} on={filter.status === s} onPress={() => set({ status: s })} testID={`cables.status.${s}`} />
        ))}
        <FilterLabel text="Checks" gap />
        <Chip label="☑ only" on={!!filter.check} onPress={() => set({ check: filter.check ? null : 'any' })} testID="cables.checkOnly" />
      </FilterRow>

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
              reloadKey={`${tick}|${dataKey}|${rulesKey}`}
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
            // a selected cable that left the list was deleted (T138): its devices' History restores it
            <Text style={styles.empty}>{selected && data ? 'This cable is deleted. Restore it from the History of a device at either end.' : 'Select a cable.'}</Text>
          )}
          {note ? (
            <Text style={styles.note} testID="cables.note">
              {note}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerLabel}>Consistency checks (project)</Text>
        {CABLE_CHECKS.map((k) => (
          <Pressable key={k.id} onPress={() => set({ check: filter.check === k.id ? null : k.id })} hitSlop={hitSlopTo(28)} style={[styles.count, filter.check === k.id && styles.countOn]} testID={`cables.check.${k.id}`}>
            <Text style={[styles.countText, filter.check === k.id && styles.countTextOn, !!data?.totals[k.id] && filter.check !== k.id && styles.countWarn]}>
              {k.title} {data?.totals[k.id] ?? '…'}
            </Text>
          </Pressable>
        ))}
      </View>
    </SectionScreen>
  );
}

function CableLine({ row: r, on, picked, onPress }: { row: CableRow; on: boolean; picked: boolean | null; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tr, on && styles.rowOn]} testID="cables.row">
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
  // D64: the swatch with its glyph carries the colour, the word stays (a mismatch is a warning, no swatch).
  const warn = value.startsWith('⚠');
  const st = pinStyleFor(value === UNSURVEYED || warn ? null : value);
  return (
    <View style={styles.cStatus}>
      {warn ? null : <Swatch {...st} size={14} />}
      <Text style={[styles.cStatusText, warn && styles.warn]} numberOfLines={1}>
        {value}
      </Text>
    </View>
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
        {!r.endpointConfirmed ? <Btn label="Confirm endpoint" small disabled={!canEdit} onPress={onConfirm} testID="cables.confirm" /> : <Text style={styles.muted}>Endpoint confirmed{r.origin ? ` · origin ${r.origin}` : ''}</Text>}
        {r.reviewItemId && projectId ? <Btn label="Open Needs review item ▸" small plain onPress={() => router.push({ pathname: '/review', params: { project: projectId, item: r.reviewItemId! } })} testID="cables.openReview" /> : null}
      </View>
    </View>
  );
}

/** The screen's chips and buttons over the UI system's (T179): small chips; a `plain` button is secondary, the others primary. */
function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  return <UiChip small label={label} selected={on} onPress={onPress} testID={testID} />;
}

function Btn({ label, onPress, disabled, plain, small, testID }: { label: string; onPress: () => void; disabled?: boolean; plain?: boolean; small?: boolean; testID?: string }) {
  return <UiBtn small={small} title={label} onPress={onPress} disabled={disabled} kind={plain ? 'secondary' : 'primary'} testID={testID} />;
}

const styles = StyleSheet.create({
  filters: { paddingBottom: space.md },
  body: {
    flex: 1,
    flexDirection: 'row',
    marginHorizontal: PAGE_GUTTER,
    marginBottom: space.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  list: { width: '62%', borderRightWidth: 1, borderRightColor: color.hairline },
  panel: { flex: 1 },
  panelBody: { padding: space.sm, gap: space.sm },
  th: { backgroundColor: color.surface2, borderBottomWidth: 1, borderBottomColor: color.hairline },
  thText: { ...font.captionBold, color: color.text2 },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm, paddingHorizontal: space.md, gap: space.sm, borderBottomWidth: 1, borderBottomColor: color.hairline },
  rowOn: { backgroundColor: color.primaryTint },
  tick: { width: 22, fontSize: 18, color: color.text },
  cCode: { width: 56, ...font.calloutBold, fontSize: 14, lineHeight: 18, color: color.text },
  cEnd: { flex: 3, ...font.callout, fontSize: 14, lineHeight: 18, ...tabular, color: color.text },
  cStatus: { flex: 2, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  cStatusText: { ...font.caption, color: color.text2, flexShrink: 1 },
  cChecks: { width: 54, ...font.caption, textAlign: 'right' },
  warn: { color: color.warning, fontWeight: '700' },
  ok: { color: color.success },
  groupHead: { paddingVertical: 6, paddingHorizontal: space.md, backgroundColor: color.bg, borderBottomWidth: 1, borderBottomColor: color.hairline },
  groupTitle: { ...font.calloutBold, color: color.text2 },
  groupCount: { ...font.caption, color: color.text3 },
  empty: { ...font.callout, color: color.text3, padding: space.lg },
  section: { marginHorizontal: space.sm, marginTop: space.sm, padding: space.md, gap: 6, borderRadius: radius.control, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface },
  sectionTitle: { ...font.captionBold, color: color.text },
  finding: { ...font.caption, color: color.warning },
  okText: { ...font.captionBold, color: color.success },
  muted: { ...font.caption, fontSize: 12, color: color.text3 },
  btnRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  note: { ...font.callout, color: color.success, padding: space.sm },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    backgroundColor: color.surface,
  },
  footerLabel: { ...font.captionBold, color: color.text2, marginRight: 6 },
  count: { height: 28, justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  countOn: { backgroundColor: color.primaryTint, borderColor: color.primaryTint },
  countText: { ...font.caption, color: color.text },
  countTextOn: { color: color.primary, fontWeight: '600' },
  countWarn: { color: color.warning, fontWeight: '600' },
});
