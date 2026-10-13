import { Link, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { openAppStore } from '../db';
import {
  filterLevels,
  listProjects,
  loadProjectHome,
  type HomeLevel,
  type HomeProject,
  type ProjectHome,
} from '../home/data';
import { pickProject, rememberProject } from '../home/currentProject';
import { useCurrentUser } from '../identity/IdentityGate';
import { useSyncStatus } from '../sync/useSyncStatus';
import { syncDataKey } from '../sync/dataKey';

/** Sidebar targets (PLAN §5). Each lights up when its task lands; Levels is this screen. */
const SIDEBAR = [
  'Levels',
  'Cable / riser',
  'Needs review',
  'Dashboard',
  'Rulings',
  'Lint',
  'Export',
  'Setup',
  'Library',
  'Sync',
] as const;

const CACHE_LABEL: Record<HomeLevel['cache'], string> = {
  cached: 'Cached',
  downloading: 'Downloading…',
  'not cached': 'Not cached',
  'no sheet': 'No sheet',
};

export default function ProjectHomeScreen() {
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const { project: wanted } = useLocalSearchParams<{ project?: string }>();
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  // The Projects screen and project creation open the home on a given project (T41).
  useEffect(() => {
    if (typeof wanted === 'string' && wanted) setProjectId(wanted);
  }, [wanted]);
  const [home, setHome] = useState<ProjectHome | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

  // Reload after each sync: pulls change counts, reviews, assignments and the sheet cache.
  useEffect(() => {
    let live = true;
    (async () => {
      const store = await openAppStore();
      const list = await listProjects(store);
      if (!live) return;
      setProjects(list);
      const id = pickProject(
        list.map((p) => p.id),
        projectId,
      );
      if (id !== projectId) setProjectId(id);
      rememberProject(id);
      setHome(id ? await loadProjectHome(store, id, user.id) : null);
    })().catch((e: unknown) => console.warn('[home] load', e));
    return () => {
      live = false;
    };
  }, [projectId, user.id, dataKey, sync.pendingOps]);

  const rows = useMemo(() => (home ? filterLevels(home.levels, mineOnly) : []), [home, mineOnly]);

  return (
    <View style={styles.root}>
      <View style={styles.sidebar}>
        <Text style={styles.brand}>Field Survey</Text>
        <Link href="/projects" style={[styles.navItem, styles.navText]}>
          Projects
        </Link>
        {SIDEBAR.map((name) =>
          name === 'Sync' ? (
            <Link key={name} href="/sync" style={[styles.navItem, styles.navText]}>
              {name}
            </Link>
          ) : name === 'Needs review' && projectId ? (
            <Link key={name} href={{ pathname: '/review', params: { project: projectId } }} style={[styles.navItem, styles.navText]}>
              {name}
            </Link>
          ) : name === 'Export' && projectId ? (
            <Link key={name} href={{ pathname: '/export', params: { project: projectId } }} style={[styles.navItem, styles.navText]}>
              {name}
            </Link>
          ) : name === 'Setup' && projectId ? (
            <Link key={name} href={{ pathname: '/setup/[projectId]', params: { projectId } }} style={[styles.navItem, styles.navText]}>
              {name}
            </Link>
          ) : (
            <View key={name} style={[styles.navItem, name === 'Levels' && styles.navActive]}>
              <Text style={[styles.navText, name !== 'Levels' && styles.navDim]}>{name}</Text>
            </View>
          ),
        )}
        <View style={{ flex: 1 }} />
        <Link href="/demo-plan" style={styles.demo}>
          Demo plan (06M composite) →
        </Link>
        <Link href={{ pathname: '/demo-plan', params: { pins: '500' } }} style={styles.demo}>
          500 pins →
        </Link>
        <Text style={styles.user}>{user.name}</Text>
      </View>

      <ScrollView style={styles.main} contentContainerStyle={styles.mainContent}>
        {projects.length > 1 ? (
          <View style={styles.chips}>
            {projects.map((p) => (
              <Pressable key={p.id} onPress={() => setProjectId(p.id)} style={[styles.chip, p.id === projectId && styles.chipOn]}>
                <Text style={p.id === projectId ? styles.chipTextOn : styles.chipText}>{p.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {!home ? (
          <View>
            <Text style={styles.empty}>No project on this iPad yet.</Text>
            <Link href="/projects" style={styles.link}>
              Open Projects to download one from the server or create a new one →
            </Link>
          </View>
        ) : (
          <>
            <Text style={styles.title}>{home.project.name}</Text>
            {home.project.site ? <Text style={styles.sub}>{home.project.site}</Text> : null}
            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Assigned to me</Text>
              <Switch value={mineOnly} onValueChange={setMineOnly} />
            </View>

            <View style={[styles.tr, styles.th]}>
              <Text style={[styles.cLevel, styles.thText]}>Level</Text>
              <Text style={[styles.cState, styles.thText]}>State</Text>
              <Text style={[styles.cNum, styles.thText]}>Devices</Text>
              <Text style={[styles.cNum, styles.thText]}>Issue / NI</Text>
              <Text style={[styles.cNum, styles.thText]}>Open items</Text>
              <Text style={[styles.cNum, styles.thText]}>Review</Text>
              <Text style={[styles.cCache, styles.thText]}>Plan</Text>
            </View>
            {rows.map((l) => (
              <LevelRow key={l.id} level={l} />
            ))}
            {rows.length === 0 ? (
              <Text style={styles.empty}>{mineOnly ? 'No levels are assigned to you.' : 'This project has no levels yet.'}</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function LevelRow({ level: l }: { level: HomeLevel }) {
  const cells = (
    <View style={[styles.tr, !l.inScope && styles.outOfScope]}>
      <View style={styles.cLevel}>
        <Text style={styles.levelCode}>
          {l.code}
          {l.assignedToMe ? '  ●' : ''}
        </Text>
        {!l.inScope ? <Text style={styles.small}>out of scope</Text> : null}
      </View>
      <Text style={styles.cState}>{l.state === 'baseline_locked' ? 'Baseline locked' : 'Setup'}</Text>
      <Text style={styles.cNum}>{l.devices}</Text>
      <Text style={[styles.cNum, l.issueOrNi > 0 && styles.red]}>{l.issueOrNi}</Text>
      <Text style={styles.cNum}>{l.openItems}</Text>
      <Text style={[styles.cNum, l.reviews > 0 && styles.badge]}>{l.reviews > 0 ? `IN REVIEW ${l.reviews}` : '0'}</Text>
      <Text style={[styles.cCache, l.cache === 'not cached' && styles.red]}>{CACHE_LABEL[l.cache]}</Text>
    </View>
  );
  // Every level opens, sheet or not (T71): without a sheet the plan area says so and the lists still work.
  return (
    <Link href={{ pathname: '/plan/[levelId]', params: { levelId: l.id } }} asChild>
      <Pressable>{cells}</Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#fff' },
  sidebar: { width: 220, backgroundColor: '#f3f5f8', borderRightWidth: 1, borderRightColor: '#d5d9e0', padding: 12, gap: 2 },
  brand: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  navItem: { paddingVertical: 9, paddingHorizontal: 10, borderRadius: 6 },
  navActive: { backgroundColor: '#dce8fb' },
  navText: { fontSize: 15, color: '#111' },
  navDim: { color: '#9aa0a8' },
  demo: { fontSize: 13, color: '#1565c0', marginBottom: 10 },
  user: { fontSize: 13, color: '#555' },
  main: { flex: 1 },
  mainContent: { padding: 20, gap: 6 },
  title: { fontSize: 28, fontWeight: '600' },
  sub: { fontSize: 15, color: '#555' },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12 },
  filterLabel: { fontSize: 15 },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#e6e8ec' },
  th: { backgroundColor: '#f3f5f8', paddingVertical: 8 },
  thText: { fontSize: 12, fontWeight: '700', color: '#555', textTransform: 'uppercase' },
  outOfScope: { opacity: 0.55 },
  cLevel: { width: 110 },
  cState: { width: 140, fontSize: 14 },
  cNum: { width: 100, fontSize: 15, textAlign: 'right' },
  cCache: { flex: 1, fontSize: 14, paddingLeft: 20 },
  levelCode: { fontSize: 17, fontWeight: '600' },
  small: { fontSize: 11, color: '#777' },
  red: { color: '#c62828', fontWeight: '600' },
  badge: { color: '#1565c0', fontWeight: '700', fontSize: 12 },
  empty: { fontSize: 15, color: '#666', marginTop: 24 },
  link: { fontSize: 15, color: '#1565c0', marginTop: 8 },
});
