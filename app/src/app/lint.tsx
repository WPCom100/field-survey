import type { Store } from '@field-survey/core';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { detailTitle, loadLintView, seedSummary, type LintGroup, type LintRow, type LintView } from '../lint/model';
import { logTo } from '../log';
import { bumpRulesVersion, engineFor } from '../rules/engine';
import { useRulesVersion } from '../rules/useRulesVersion';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

/** Reasons offered as chips; any text is accepted. */
const REASON_CHIPS = ['Checked on site: correct as is', 'Known; handled outside the app', 'Master is right; rule does not apply'];

type Item = { type: 'group'; group: LintGroup; collapsed: boolean } | { type: 'row'; row: LintRow } | { type: 'seeds'; group: LintGroup };

/**
 * Lint (T36, Phase 3 §9): the rule engine's findings grouped by check (PLAN §6.3) or by level,
 * open by default, dismissed ones on a toggle. The panel shows the finding, what to do about it,
 * Open card, and Dismiss… (a reason is required; the finding comes back when its facts change,
 * D178) or Reopen. The vocabulary check offers "Fix all via ruling" per value: the ruling editor
 * is T37, so for now it says what the ruling will do. "This iPad" lists records the server has
 * not numbered (local, never synced). `?project=` names the project.
 */
export default function LintScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const rulesKey = useRulesVersion();
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [levelId, setLevelId] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<'check' | 'level'>('check');
  const [dismissed, setDismissed] = useState(false);
  const [view, setView] = useState<LintView | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
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
    let active = true;
    loadLintView(store, projectId, { levelId, groupBy, dismissed }).then(
      (v) => {
        if (!active) return;
        setView(v);
        const ids = v.groups.flatMap((g) => g.rows.map((r) => r.id));
        setSelected((cur) => (cur && ids.includes(cur) ? cur : (ids[0] ?? null)));
      },
      (e: unknown) => active && setNote(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, projectId, levelId, groupBy, dismissed, tick, dataKey, rulesKey]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const g of view?.groups ?? []) {
      const c = collapsed.has(g.key);
      out.push({ type: 'group', group: g, collapsed: c });
      if (c) continue;
      if (g.seeds.length) out.push({ type: 'seeds', group: g });
      for (const r of g.rows) out.push({ type: 'row', row: r });
    }
    return out;
  }, [view, collapsed]);

  const row = useMemo(() => view?.groups.flatMap((g) => g.rows).find((r) => r.id === selected) ?? null, [view, selected]);
  const codes = useMemo(() => new Map((view?.levels ?? []).map((l) => [l.id, l.code] as const)), [view]);

  const engine = useMemo(() => (store && projectId ? engineFor(store, projectId, user.id) : null), [store, projectId, user.id]);

  const act = useCallback(
    (what: 'dismiss' | 'reopen', r: LintRow, reason?: string) => {
      if (!engine) return;
      const run = what === 'dismiss' ? engine.dismiss(r.id, reason ?? '') : engine.reopen(r.id);
      run.then(
        () => {
          logTo('rules', 'info', `lint_${what}`, { finding: r.id, lint: r.lintId });
          setNote(what === 'dismiss' ? `Dismissed: ${r.subject}. It comes back if its facts change.` : `Reopened: ${r.subject}.`);
          bumpRulesVersion();
          setTick((n) => n + 1);
        },
        (e: unknown) => setNote(`Not ${what === 'dismiss' ? 'dismissed' : 'reopened'}: ${String((e as Error)?.message ?? e)}`),
      );
    },
    [engine],
  );

  const fixAll = useCallback(
    (g: LintGroup, i: number) => {
      const s = g.seeds[i];
      if (!s) return;
      Alert.alert(
        'Fix all via ruling',
        `${seedSummary(s, codes)}.\n\nRulings arrive with T37: this selection will open the ruling editor pre-filled, with a preview to untick rows before anything changes. Until then, fix the records one by one.`,
      );
    },
    [codes],
  );

  const title = view ? `Lint (${view.open} open · ${view.dismissed} dismissed)` : 'Lint';

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <Link href={projectId ? { pathname: '/', params: { project: projectId } } : '/'} style={styles.link}>
          ← Levels
        </Link>
      </View>
      <View style={styles.filters}>
        <Text style={styles.filterLabel}>Level</Text>
        <Chip label="All" on={!levelId} onPress={() => setLevelId(null)} />
        {view?.levels.map((l) => (
          <Chip key={l.id} label={l.code} on={levelId === l.id} onPress={() => setLevelId(l.id)} />
        ))}
        <Text style={[styles.filterLabel, styles.gap]}>Group by</Text>
        <Chip label="Check" on={groupBy === 'check'} onPress={() => setGroupBy('check')} />
        <Chip label="Level" on={groupBy === 'level'} onPress={() => setGroupBy('level')} />
        <Text style={[styles.filterLabel, styles.gap]}>Show</Text>
        <Chip label="Open" on={!dismissed} onPress={() => setDismissed(false)} />
        <Chip label={`Dismissed ${view?.dismissed ?? 0}`} on={dismissed} onPress={() => setDismissed(true)} />
      </View>

      <View style={styles.body}>
        <FlatList
          style={styles.list}
          data={items}
          keyExtractor={(it) => (it.type === 'row' ? it.row.id : `${it.type}:${it.group.key}`)}
          renderItem={({ item }) =>
            item.type === 'group' ? (
              <Pressable
                style={styles.groupHead}
                onPress={() =>
                  setCollapsed((cur) => {
                    const next = new Set(cur);
                    if (next.has(item.group.key)) next.delete(item.group.key);
                    else next.add(item.group.key);
                    return next;
                  })
                }
              >
                <Text style={styles.groupTitle}>
                  {item.collapsed ? '▸' : '▾'} {item.group.title} ({item.group.rows.length})
                </Text>
              </Pressable>
            ) : item.type === 'seeds' ? (
              <View style={styles.seeds}>
                {item.group.seeds.map((s, i) => (
                  <View key={`${s.field}|${s.from}`} style={styles.seedRow}>
                    <Text style={styles.seedText} numberOfLines={1}>
                      &quot;{s.from}&quot; ×{s.recordIds.length}
                      {s.to ? ` → "${s.to}"` : ''}
                    </Text>
                    <Pressable onPress={() => fixAll(item.group, i)} accessibilityRole="button">
                      <Text style={styles.link}>Fix all via ruling ▸</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : (
              <Pressable onPress={() => setSelected(item.row.id)} style={[styles.row, item.row.id === selected && styles.rowOn]}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.row.subject}
                </Text>
                <Text style={styles.rowSub} numberOfLines={2}>
                  {item.row.levelCode ?? 'no level'} · {groupBy === 'level' ? `${item.row.checkTitle} · ` : ''}
                  {item.row.message}
                </Text>
              </Pressable>
            )
          }
          ListEmptyComponent={<Text style={styles.empty}>{view ? (dismissed ? 'Nothing dismissed.' : 'No open findings.') : 'Loading…'}</Text>}
          ListFooterComponent={
            view?.local.length && !dismissed ? (
              <View>
                <Text style={styles.groupTitleLocal}>This iPad: not numbered by the server ({view.local.length})</Text>
                {view.local.map((l) => (
                  <View key={l.id} style={styles.row}>
                    <Text style={styles.rowTitle}>
                      NEW {l.kind} · {l.levelCode ?? 'no level'} · {l.reason}
                    </Text>
                    <Text style={styles.rowSub}>{l.text}</Text>
                  </View>
                ))}
              </View>
            ) : null
          }
        />
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelBody}>
          {row ? <Detail row={row} canEdit={!!engine} onAct={act} /> : <Text style={styles.empty}>Select a finding.</Text>}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </ScrollView>
      </View>
    </View>
  );
}

function Detail({ row: r, canEdit, onAct }: { row: LintRow; canEdit: boolean; onAct: (what: 'dismiss' | 'reopen', r: LintRow, reason?: string) => void }) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setDismissing(false);
    setReason('');
  }, [r.id]);
  const openCard = () => {
    if (!r.levelId) return;
    router.push({ pathname: '/plan/[levelId]', params: { levelId: r.levelId, ...(r.deviceId ? { device: r.deviceId } : {}) } });
  };
  return (
    <>
      <Text style={styles.panelTitle}>{detailTitle(r)}</Text>
      <Text style={styles.value}>{r.message}</Text>
      <Text style={styles.sub}>
        {r.levelCode ? `Level ${r.levelCode}` : 'No level'} · {r.lintId}
      </Text>
      {r.hint ? <Text style={styles.hint}>Suggested: {r.hint}</Text> : null}
      {r.state === 'dismissed' ? <Text style={styles.sub}>Dismissed: {r.dismissedReason ?? '(no reason)'}</Text> : null}
      <View style={styles.btnRow}>
        {r.levelId ? <Btn label={r.deviceId ? 'Open card ▸' : 'Open level ▸'} onPress={openCard} /> : null}
        {r.state === 'open' ? (
          <Btn label="Dismiss…" onPress={() => setDismissing(true)} disabled={!canEdit || dismissing} />
        ) : (
          <Btn label="Reopen" onPress={() => onAct('reopen', r)} disabled={!canEdit} />
        )}
      </View>
      {dismissing ? (
        <View style={styles.dismiss}>
          <Text style={styles.sideTitle}>Why dismiss it?</Text>
          <View style={styles.btnRow}>
            {REASON_CHIPS.map((c) => (
              <Chip key={c} label={c} on={reason === c} onPress={() => setReason(c)} />
            ))}
          </View>
          <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="Reason (required)" multiline />
          <Text style={styles.sub}>Dismissed findings come back if their facts change (D178).</Text>
          <View style={styles.btnRow}>
            <Btn label="Dismiss" disabled={!reason.trim()} onPress={() => onAct('dismiss', r, reason)} />
            <Btn label="Cancel" onPress={() => setDismissing(false)} />
          </View>
        </View>
      ) : null}
    </>
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
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, disabled && styles.off]} accessibilityRole="button">
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 16 },
  title: { fontSize: 24, fontWeight: '600' },
  link: { color: '#1f6feb', fontSize: 16 },
  filters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingVertical: 10 },
  filterLabel: { fontSize: 14, color: '#555' },
  gap: { marginLeft: 16 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
  body: { flex: 1, flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e1e4e8' },
  list: { width: '46%', flexGrow: 0, borderRightWidth: 1, borderRightColor: '#e1e4e8' },
  groupHead: { paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#f4f5f7', borderBottomWidth: 1, borderBottomColor: '#e1e4e8' },
  groupTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  groupTitleLocal: { fontSize: 15, fontWeight: '700', color: '#333', padding: 12, backgroundColor: '#fff4e5' },
  seeds: { paddingHorizontal: 16, paddingVertical: 6, gap: 6, backgroundColor: '#fafbfc' },
  seedRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  seedText: { fontSize: 14, flex: 1 },
  row: { paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  rowOn: { backgroundColor: '#dce8fb' },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 13, color: '#666', marginTop: 2 },
  empty: { fontSize: 15, color: '#666', padding: 16 },
  panel: { flex: 1 },
  panelBody: { padding: 16, gap: 12 },
  panelTitle: { fontSize: 18, fontWeight: '600' },
  value: { fontSize: 16 },
  sub: { fontSize: 13, color: '#666' },
  hint: { fontSize: 14, color: '#0b5394' },
  sideTitle: { fontSize: 15, fontWeight: '700' },
  dismiss: { gap: 8, borderWidth: 1, borderColor: '#e1e4e8', borderRadius: 8, padding: 12 },
  btnRow: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  btn: { alignSelf: 'flex-start', backgroundColor: '#1f6feb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  off: { opacity: 0.4 },
  btnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  note: { color: '#0a5', fontSize: 14 },
});
