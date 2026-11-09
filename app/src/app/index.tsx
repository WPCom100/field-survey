import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { openAppStore } from '../db';
import {
  filterLevels,
  homeSummary,
  homeTiles,
  levelSubline,
  listProjects,
  loadProjectHome,
  type HomeLevel,
  type HomeProject,
  type ProjectHome,
} from '../home/data';
import { awaitingProject, pickProject, rememberProject } from '../home/currentProject';
import { useCurrentUser } from '../identity/IdentityGate';
import { useRulesVersion } from '../rules/useRulesVersion';
import { BaselineDialog } from '../setup/BaselineDialog';
import { loadLockTable, type LockLevel } from '../setup/lock';
import { homeIdentityLine, installName, loadInstallLabels } from '../sync/install';
import { useSyncStatus } from '../sync/useSyncStatus';
import { syncDataKey } from '../sync/dataKey';
import { Banner, Btn, Empty, Icon, Sidebar, color, font, radius, space, tabular, type IconName } from '../ui';

/** The Plan column (the board): the display sheet on this iPad, on its way, not yet, or none. */
const PLAN_CELL: Record<HomeLevel['cache'], { label: string; icon: IconName | null; fg: string; bold?: boolean }> = {
  cached: { label: 'On iPad', icon: 'check', fg: color.text2 },
  downloading: { label: 'Downloading…', icon: 'download', fg: color.text2 },
  'not cached': { label: 'Download', icon: 'download', fg: color.primary, bold: true },
  'no sheet': { label: 'No sheet yet', icon: null, fg: color.text3 },
};

export default function ProjectHomeScreen() {
  const user = useCurrentUser();
  const router = useRouter();
  const sync = useSyncStatus();
  const rules = useRulesVersion();
  const dataKey = syncDataKey(sync);
  const { project: wanted } = useLocalSearchParams<{ project?: string }>();
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(typeof wanted === 'string' && wanted ? wanted : null);

  // The Projects screen and project creation open the home on a given project (T41).
  useEffect(() => {
    if (typeof wanted === 'string' && wanted) setProjectId(wanted);
  }, [wanted]);
  const [home, setHome] = useState<ProjectHome | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [who, setWho] = useState({ label: `Signed in as ${user.name}`, sub: '' });
  const [locks, setLocks] = useState<Map<string, LockLevel>>(new Map());
  const [dialog, setDialog] = useState<LockLevel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Four tiles across when they fit at 160 pt each, else two by two (portrait beside the sidebar).
  const [tileCols, setTileCols] = useState(4);

  // Reload after each sync: pulls change counts, reviews, assignments and the sheet cache; after
  // each rules run: the Lint pill.
  useEffect(() => {
    let live = true;
    (async () => {
      const store = await openAppStore();
      const list = await listProjects(store);
      if (!live) return;
      setProjects(list);
      const labels = await loadInstallLabels(store);
      setWho({
        label: homeIdentityLine(user.name, store.installId, labels),
        sub: `This iPad: ${installName(store.installId, labels)}${labels.has(store.installId) ? '' : ' (name it on the Sync screen)'}`,
      });
      const known = list.map((p) => p.id);
      if (awaitingProject(known, typeof wanted === 'string' ? wanted : null, projectId)) {
        // just created: it arrives with the next sync, which re-runs this effect (dataKey)
        setHome(null);
        return;
      }
      const id = pickProject(known, projectId);
      if (id !== projectId) setProjectId(id);
      rememberProject(id);
      const next = id ? await loadProjectHome(store, id, user.id) : null;
      const table = id ? await loadLockTable(store, id) : [];
      if (!live) return;
      setHome(next);
      setLocks(new Map(table.map((l) => [l.id, l])));
    })().catch((e: unknown) => console.warn('[home] load', e));
    return () => {
      live = false;
    };
  }, [projectId, wanted, user.id, user.name, dataKey, sync.pendingOps, reload, rules]);
  const waiting = awaitingProject(
    projects.map((p) => p.id),
    typeof wanted === 'string' ? wanted : null,
    projectId,
  );

  const rows = useMemo(() => (home ? filterLevels(home.levels, mineOnly) : []), [home, mineOnly]);
  const tiles = useMemo(() => (home ? homeTiles(home) : []), [home]);
  const projectName = home?.project.name ?? projects.find((p) => p.id === projectId)?.name ?? null;

  return (
    <View style={styles.root}>
      <Sidebar
        active="Levels"
        projectId={projectId}
        projectName={projectName}
        counts={{ review: home?.reviewOpen, lint: home?.lintOpen }}
        user={{ name: user.name, sub: who.sub, label: who.label }}
        extra={
          __DEV__ ? (
            <View style={styles.demo}>
              <Link href="/demo-plan" style={styles.demoLink}>
                Demo plan (06M composite) →
              </Link>
              <Link href={{ pathname: '/demo-plan', params: { pins: '500' } }} style={styles.demoLink}>
                500 pins →
              </Link>
            </View>
          ) : null
        }
      />

      <ScrollView style={styles.main} contentContainerStyle={styles.mainContent}>
        {waiting ? (
          <Empty text="Downloading the project from the server…" icon="download" testID="home.waiting" />
        ) : !home ? (
          <Empty
            text="No project on this iPad yet."
            icon="levels"
            action={{ label: 'Open Projects to download one from the server or create a new one', onPress: () => router.push('/projects'), testID: 'home.openProjects' }}
          />
        ) : (
          <>
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.title} accessibilityRole="header">
                  {home.project.name}
                </Text>
                <Text style={styles.caption}>{[home.project.site, homeSummary(home.levels)].filter(Boolean).join(' · ')}</Text>
              </View>
              <View style={styles.mine}>
                <Text style={styles.mineLabel}>Assigned to me</Text>
                <Switch value={mineOnly} onValueChange={setMineOnly} trackColor={{ true: color.primary, false: color.border }} testID="home.mine" />
              </View>
            </View>
            {notice ? <Banner tone="success" text={notice} /> : null}

            <View style={styles.tiles} onLayout={(e) => setTileCols(e.nativeEvent.layout.width >= 4 * 160 + 3 * space.lg ? 4 : 2)}>
              {tiles.map((t) => (
                <View key={t.key} style={[styles.tile, { width: tileCols === 4 ? '21%' : '46%', flexGrow: 1 }]} testID={`home.tile.${t.key}`}>
                  <Text style={styles.tileLabel}>{t.label}</Text>
                  <Text style={[styles.tileValue, t.tone === 'danger' && { color: color.danger }, t.tone === 'warning' && { color: color.warning }]}>{t.value}</Text>
                  <Text style={styles.tileSub}>{t.sub}</Text>
                </View>
              ))}
            </View>

            <View style={styles.table}>
              <View style={[styles.tr, styles.th]}>
                <Text style={[styles.cLevel, styles.thText]}>Level</Text>
                <Text style={[styles.cState, styles.thText]}>State</Text>
                <Text style={[styles.cDevices, styles.thText, styles.right]}>Devices</Text>
                <Text style={[styles.cIssue, styles.thText, styles.right]}>Issue / not installed</Text>
                <Text style={[styles.cOpen, styles.thText, styles.right]}>Open items</Text>
                <Text style={[styles.cReview, styles.thText, styles.right]}>Review</Text>
                <Text style={[styles.cPlan, styles.thText]}>Plan</Text>
              </View>
              {rows.map((l, i) => (
                <LevelRow key={l.id} level={l} first={i === 0} lock={locks.get(l.id) ?? null} onLock={setDialog} />
              ))}
              {rows.length === 0 ? (
                <Text style={styles.none}>{mineOnly ? 'No levels are assigned to you.' : 'This project has no levels yet.'}</Text>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
      {projectId ? (
        <BaselineDialog
          projectId={projectId}
          userId={user.id}
          level={dialog}
          onClose={(done) => {
            setDialog(null);
            if (done) {
              setNotice(done);
              setReload((n) => n + 1);
            }
          }}
        />
      ) : null}
    </View>
  );
}

/** A count cell: red Issue, amber Review; a Setup level's zero reads "–" (nothing surveyed yet). */
function Num({ n, style, tone, setup }: { n: number; style: StyleProp<TextStyle>; tone?: 'danger' | 'warning'; setup: boolean }) {
  if (n === 0 && setup) return <Text style={[style, styles.num, styles.right, { color: color.muted }]}>–</Text>;
  const fg = n === 0 ? color.text3 : tone === 'danger' ? color.danger : tone === 'warning' ? color.warning : color.text;
  return <Text style={[style, styles.num, styles.right, { color: fg }, n > 0 && tone ? styles.bold : null]}>{n}</Text>;
}

function LevelRow({ level: l, first, lock, onLock }: { level: HomeLevel; first: boolean; lock: LockLevel | null; onLock: (l: LockLevel) => void }) {
  const router = useRouter();
  const setup = l.state !== 'baseline_locked';
  const plan = PLAN_CELL[l.cache];
  const sub = levelSubline(l);
  // Every level opens, sheet or not (T71): without a sheet the plan area says so and the lists still work.
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/plan/[levelId]', params: { levelId: l.id } })}
      testID={`level.${l.code}`}
      style={({ pressed }) => [styles.tr, styles.row, !first && styles.rowLine, pressed && styles.rowPressed, !l.inScope && styles.outOfScope]}
    >
      <View style={styles.cLevel}>
        {/* One Text: the row reads "06  ●, …" to VoiceOver and the flows (T158). */}
        <Text style={styles.code}>
          {l.code}
          {l.assignedToMe ? <Text style={styles.mineDot}>{'  ●'}</Text> : null}
        </Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
      <View style={[styles.cState, styles.state]}>
        {setup ? null : <Icon name="lock" size={16} color={color.text2} />}
        <Text style={[styles.stateText, setup && { color: color.text3 }]}>{setup ? 'Setup' : 'Locked'}</Text>
        {/* Lock / Unlock (T47): its own touch target inside the row, which opens the plan. */}
        {lock && l.inScope ? <Btn small title={lock.locked ? 'Unlock…' : 'Lock…'} onPress={() => onLock(lock)} testID={`home.lock.${l.code}`} /> : null}
      </View>
      <Num n={l.devices} style={styles.cDevices} setup={false} />
      <Num n={l.issueOrNi} style={styles.cIssue} tone="danger" setup={setup} />
      <Num n={l.openItems} style={styles.cOpen} setup={setup} />
      <Num n={l.reviews} style={styles.cReview} tone="warning" setup={setup} />
      <View style={[styles.cPlan, styles.state]}>
        {plan.icon ? <Icon name={plan.icon} size={16} color={plan.fg} strokeWidth={plan.icon === 'check' ? 2.2 : 2} /> : null}
        <Text style={[styles.stateText, { color: plan.fg }, plan.bold && styles.bold]}>{plan.label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: color.bg },
  demo: { paddingHorizontal: space.md, paddingTop: space.lg, gap: space.sm },
  demoLink: { ...font.caption, color: color.primary },
  main: { flex: 1 },
  mainContent: { paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.xxl, gap: 20 },
  header: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.lg, flexWrap: 'wrap' },
  headerText: { flex: 1, minWidth: 240 },
  title: { ...font.display, color: color.text },
  caption: { ...font.caption, color: color.text3, marginTop: space.xs },
  mine: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  mineLabel: { ...font.callout, color: color.text2 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  tile: {
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingVertical: space.lg,
    paddingHorizontal: 20,
    gap: 2,
  },
  tileLabel: { ...font.caption, color: color.text2 },
  tileValue: { ...font.display, ...tabular, color: color.text },
  tileSub: { ...font.caption, color: color.text3 },
  table: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline, borderRadius: radius.card, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, gap: space.sm },
  th: { minHeight: 40, paddingVertical: space.sm, backgroundColor: color.surface2 },
  thText: { ...font.caption, color: color.text2 },
  row: { minHeight: 52, paddingVertical: space.sm },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  rowPressed: { backgroundColor: color.bg },
  outOfScope: { opacity: 0.55 },
  cLevel: { flex: 2 },
  cState: { flex: 1.9 },
  cDevices: { flex: 1 },
  cIssue: { flex: 1.3 },
  cOpen: { flex: 1.1 },
  cReview: { flex: 0.9 },
  cPlan: { flex: 1.8, paddingLeft: space.md },
  right: { textAlign: 'right' },
  code: { ...font.headline, color: color.text },
  mineDot: { color: color.primary },
  sub: { ...font.caption, color: color.text3 },
  state: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  stateText: { ...font.callout, color: color.text2 },
  num: { ...font.body, ...tabular },
  bold: { fontWeight: '600' },
  none: { ...font.callout, color: color.text3, padding: space.lg },
});
