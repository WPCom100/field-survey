import type { Store } from '@field-survey/core';
import { draftFromSeed } from '@field-survey/rules';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DraftRow } from '../card/DeviceCard';
import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { SectionScreen } from '../home/SectionScreen';
import { useCurrentUser } from '../identity/IdentityGate';
import { detailTitle, loadLintView, seedSummary, type LintDraft, type LintGroup, type LintRow, type LintView } from '../lint/model';
import { logTo } from '../log';
import { bumpRulesVersion, engineFor, ruleDecider } from '../rules/engine';
import { useRulesVersion } from '../rules/useRulesVersion';
import { handRuling } from '../rulings/handoff';
import { projectDataKey } from '../sync/dataKey';
import { useReload } from '../sync/useReload';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Btn, Chip, FilterLabel, FilterRow, FormActions, PAGE_GUTTER, color, fieldStyles, font, radius, space } from '../ui';

/** Reasons offered as chips; any text is accepted. */
const REASON_CHIPS = ['Checked on site: correct as is', 'Known; handled outside the app', 'Master is right; rule does not apply'];

type Item = { type: 'group'; group: LintGroup; collapsed: boolean } | { type: 'row'; row: LintRow } | { type: 'seeds'; group: LintGroup };

/**
 * Lint (T36, Phase 3 §9): the rule engine's findings grouped by check (PLAN §6.3) or by level,
 * open by default, dismissed ones on a toggle. The panel shows the finding, what to do about it,
 * Open card, and Dismiss… (a reason is required; the finding comes back when its facts change,
 * D178) or Reopen. The vocabulary check offers "Fix all via ruling" per value, which opens the
 * ruling editor (T37) pre-filled with the records. "Drafts with no device" heads the open list:
 * the rule drafts no card shows (R3c's Neuron ID item, R2e's Unison pair, R4b's part on an item
 * with no device), decided in place through the card's `DraftRow` (T100, D209). "This iPad"
 * lists records the server has not numbered (local, never synced). `?project=` names the project.
 */
export default function LintScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // this project's pulls and rules runs only (T185)
  const dataKey = projectDataKey(sync, projectId);
  const rulesKey = useRulesVersion(projectId);
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

  // T185: a pull or a rules run during a load no longer throws it away (useReload)
  useReload({
    name: 'lint',
    subject: store && projectId ? `${projectId}|${levelId ?? ''}|${groupBy}|${dismissed}` : null,
    reloadKey: `${tick}|${dataKey}|${rulesKey}`,
    load: () => loadLintView(store!, projectId!, { levelId, groupBy, dismissed }),
    apply: (v) => {
      setView(v);
      const ids = v.groups.flatMap((g) => g.rows.map((r) => r.id));
      setSelected((cur) => (cur && ids.includes(cur) ? cur : (ids[0] ?? null)));
    },
    fail: (e) => setNote(String(e)),
  });

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
  const decider = useMemo(() => (store && projectId ? ruleDecider(store, projectId, user.id) : null), [store, projectId, user.id]);

  const act = useCallback(
    (what: 'dismiss' | 'reopen', r: LintRow, reason?: string) => {
      if (!engine) return;
      const run = what === 'dismiss' ? engine.dismiss(r.id, reason ?? '') : engine.reopen(r.id);
      run.then(
        () => {
          logTo('rules', 'info', `lint_${what}`, { finding: r.id, lint: r.lintId });
          setNote(what === 'dismiss' ? `Dismissed: ${r.subject}.` : `Reopened: ${r.subject}.`);
          bumpRulesVersion();
          setTick((n) => n + 1);
        },
        (e: unknown) => setNote(`Not ${what === 'dismiss' ? 'dismissed' : 'reopened'}: ${String((e as Error)?.message ?? e)}`),
      );
    },
    [engine],
  );

  // "Fix all via ruling" (T37): the seed opens the ruling editor pre-filled; nothing changes
  // before its preview is applied.
  const fixAll = useCallback(
    (g: LintGroup, i: number) => {
      const s = g.seeds[i];
      if (!s || !projectId) return;
      const draft = draftFromSeed(s, s.levelIds.map((id) => codes.get(id)).filter((c): c is string => !!c));
      if (!draft) {
        setNote(`${seedSummary(s, codes)}: a ruling cannot change ${s.entity.replace(/_/g, ' ')} records.`);
        return;
      }
      handRuling(projectId, draft, 'Lint');
      router.push({ pathname: '/rulings', params: { project: projectId, from: 'handoff' } });
    },
    [codes, projectId],
  );

  const title = view ? `Lint (${view.open} open · ${view.dismissed} dismissed${view.drafts.length ? ` · ${view.drafts.length} draft${view.drafts.length === 1 ? '' : 's'}` : ''})` : 'Lint';

  return (
    <SectionScreen
      section="Lint"
      projectId={projectId}
      title={title}
      backTestID="lint.back"
    >
      <FilterRow style={styles.filters}>
        <FilterLabel text="Level" />
        <Chip small label="All" selected={!levelId} onPress={() => setLevelId(null)} testID="lint.level.all" />
        {view?.levels.map((l) => (
          <Chip small key={l.id} label={l.code} selected={levelId === l.id} onPress={() => setLevelId(l.id)} testID={`lint.level.${l.code}`} />
        ))}
        <FilterLabel text="Group by" gap />
        <Chip small label="Check" selected={groupBy === 'check'} onPress={() => setGroupBy('check')} testID="lint.groupBy.check" />
        <Chip small label="Level" selected={groupBy === 'level'} onPress={() => setGroupBy('level')} testID="lint.groupBy.level" />
        <FilterLabel text="Show" gap />
        <Chip small label="Open" selected={!dismissed} onPress={() => setDismissed(false)} testID="lint.show.open" />
        <Chip small label={`Dismissed ${view?.dismissed ?? 0}`} selected={dismissed} onPress={() => setDismissed(true)} testID="lint.show.dismissed" />
      </FilterRow>

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
                    <Pressable onPress={() => fixAll(item.group, i)} accessibilityRole="button" testID={`lint.fixAll.${s.from}`}>
                      <Text style={styles.link}>Fix all via ruling ▸</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : (
              <Pressable onPress={() => setSelected(item.row.id)} style={[styles.row, item.row.id === selected && styles.rowOn]} testID="lint.row">
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
          ListHeaderComponent={view?.drafts.length && decider ? <Drafts drafts={view.drafts} decider={decider} onDecided={() => setTick((n) => n + 1)} /> : null}
          ListEmptyComponent={<Text style={styles.empty}>{view ? (dismissed ? 'Nothing dismissed.' : 'No open findings.') : 'Loading…'}</Text>}
          ListFooterComponent={
            view?.local.length && !dismissed ? (
              <View>
                <Text style={styles.groupTitleLocal} testID="lint.local">This iPad: not numbered by the server ({view.local.length})</Text>
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
          {row ? <Detail row={row} canEdit={!!engine} onAct={act} /> : null}
          {note ? (
            <Text style={styles.note} testID="lint.note">
              {note}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </SectionScreen>
  );
}

/** Rule drafts on a numbering group, a level or an item with no device (T100): no card lists them. */
function Drafts({ drafts, decider, onDecided }: { drafts: LintDraft[]; decider: ReturnType<typeof ruleDecider>; onDecided: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <View>
      <Pressable style={[styles.groupHead, styles.groupHeadDraft]} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.groupTitle}>
          {open ? '▾' : '▸'} Drafts with no device ({drafts.length})
        </Text>
      </Pressable>
      {open
        ? drafts.map((d) => (
            <View key={d.id} style={styles.draftBox}>
              <View style={styles.seedRow}>
                <Text style={[styles.rowTitle, styles.grow]} numberOfLines={1}>
                  {d.subject}
                  {d.device ? ` · ${d.device}` : ''}
                </Text>
                {d.levelId ? (
                  <Pressable
                    onPress={() => router.push({ pathname: '/plan/[levelId]', params: { levelId: d.levelId!, ...(d.deviceId ? { device: d.deviceId } : {}) } })}
                    accessibilityRole="button"
                  >
                    <Text style={styles.link}>{d.deviceId ? 'Open card ▸' : 'Open level ▸'}</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.rowSub}>
                {d.levelCode ? `Level ${d.levelCode}` : 'No level'}
                {d.findingIds.length ? ' · a finding below names the same subject' : ''}
              </Text>
              <DraftRow draft={d} decider={decider} readOnly={false} onDecided={onDecided} />
            </View>
          ))
        : null}
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
        {r.levelId ? <Btn title={r.deviceId ? 'Open card ▸' : 'Open level ▸'} onPress={openCard} testID="lint.openCard" /> : null}
        {r.state === 'open' ? (
          <Btn title="Dismiss…" onPress={() => setDismissing(true)} disabled={!canEdit || dismissing} testID="lint.dismiss" />
        ) : (
          <Btn title="Reopen" onPress={() => onAct('reopen', r)} disabled={!canEdit} testID="lint.reopen" />
        )}
      </View>
      {dismissing ? (
        <View style={styles.dismiss}>
          <Text style={styles.sideTitle}>Why dismiss it?</Text>
          <View style={styles.btnRow}>
            {REASON_CHIPS.map((c) => (
              <Chip key={c} label={c} selected={reason === c} onPress={() => setReason(c)} />
            ))}
          </View>
          <TextInput style={styles.input} placeholderTextColor={color.text3} value={reason} onChangeText={setReason} placeholder="Reason (required)" multiline testID="lint.reason" />
          <FormActions>
            <Btn title="Cancel" onPress={() => setDismissing(false)} />
            <Btn kind="primary" title="Dismiss" disabled={!reason.trim()} onPress={() => onAct('dismiss', r, reason)} testID="lint.dismiss.ok" />
          </FormActions>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  link: { ...font.callout, color: color.primary },
  filters: { paddingBottom: space.md },
  body: {
    flex: 1,
    flexDirection: 'row',
    marginHorizontal: PAGE_GUTTER,
    marginBottom: space.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  list: { width: '46%', flexGrow: 0, borderRightWidth: 1, borderRightColor: color.hairline },
  groupHead: { minHeight: 44, justifyContent: 'center', paddingVertical: space.sm, paddingHorizontal: space.md, backgroundColor: color.surface2, borderBottomWidth: 1, borderBottomColor: color.hairline },
  groupTitle: { ...font.calloutBold, color: color.text2 },
  groupHeadDraft: { backgroundColor: color.primaryTint },
  draftBox: { paddingVertical: space.sm, paddingHorizontal: space.md, borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space.xs },
  groupTitleLocal: { ...font.calloutBold, color: color.warning, padding: space.md, backgroundColor: color.warningTint },
  seeds: { paddingHorizontal: space.lg, paddingVertical: 6, gap: 6, backgroundColor: color.bg },
  seedRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  seedText: { ...font.callout, color: color.text, flex: 1 },
  grow: { flex: 1 },
  row: { paddingVertical: 10, paddingHorizontal: space.lg, borderBottomWidth: 1, borderBottomColor: color.hairline, gap: 2 },
  rowOn: { backgroundColor: color.primaryTint },
  rowTitle: { ...font.calloutBold, color: color.text },
  rowSub: { ...font.caption, color: color.text3 },
  empty: { ...font.callout, color: color.text3, padding: space.lg },
  panel: { flex: 1 },
  panelBody: { padding: space.lg, gap: space.md },
  panelTitle: { ...font.headline, color: color.text },
  value: { ...font.body, color: color.text },
  sub: { ...font.caption, color: color.text3 },
  hint: { ...font.callout, color: color.primary },
  sideTitle: { ...font.calloutBold, color: color.text },
  dismiss: { gap: space.sm, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, padding: space.md },
  btnRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  input: fieldStyles.input,
  note: { ...font.callout, color: color.success },
});
