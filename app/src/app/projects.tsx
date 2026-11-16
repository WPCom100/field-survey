import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { listProjects, type HomeProject } from '../home/data';
import { useIdentity } from '../identity/IdentityGate';
import { fetchProjects, type ServerProject } from '../setup/api';
import { Notice } from '../setup/widgets';
import { getSyncEngine } from '../sync/engine';
import { useSyncStatus } from '../sync/useSyncStatus';
import { syncDataKey } from '../sync/dataKey';
import { useReload } from '../sync/useReload';
import { Btn, Card, PageHeader, PAGE_GUTTER, color, font, space, tabular } from '../ui';

/**
 * Projects (Phase 3 §2.1 "Projects"): what is on this iPad plus what the server lists. A
 * project the server knows but the iPad does not yet is remembered on refresh and arrives
 * with the next sync (T41, D127). Creating one is server-side (`/new-project`).
 */
export default function ProjectsScreen() {
  const identity = useIdentity();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [local, setLocal] = useState<HomeProject[]>([]);
  const [remote, setRemote] = useState<ServerProject[] | null>(null);
  const [levels, setLevels] = useState<Map<string, number>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // every project's pulls (the list shows them all); T186: a pull during a load no longer throws it away
  useReload({
    name: 'projects',
    subject: 'projects',
    reloadKey: `${dataKey}|${sync.pendingOps}`,
    load: async () => {
      const store = await openAppStore();
      const list = await listProjects(store);
      const counts = new Map<string, number>();
      for (const r of await store.db.query<{ project_id: string; n: number }>(
        `SELECT project_id, count(*) AS n FROM level WHERE deleted_at IS NULL GROUP BY project_id`,
        [],
      )) {
        counts.set(r.project_id, r.n);
      }
      return { list, counts };
    },
    apply: ({ list, counts }) => {
      setLocal(list);
      setLevels(counts);
    },
    fail: (e) => console.warn('[projects] load', e),
  });

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const store = await openAppStore();
      const list = await fetchProjects(identity, store);
      setRemote(list);
      const known = new Set(local.map((p) => p.id));
      const fresh = list.filter((p) => !known.has(p.id));
      const engine = await getSyncEngine();
      void engine.requestSync();
      setNotice(
        fresh.length
          ? `${fresh.length} project${fresh.length === 1 ? '' : 's'} not yet on this iPad: downloading now.`
          : `Server lists ${list.length} project${list.length === 1 ? '' : 's'}; all are on this iPad.`,
      );
    } catch (e) {
      setError(`Could not reach the server: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [identity, local]);

  const onDevice = new Set(local.map((p) => p.id));
  const pending = (remote ?? []).filter((p) => !onDevice.has(p.id));

  return (
    <View style={styles.root}>
      <PageHeader
        title="Projects"
        caption="The projects on this iPad, and any the server lists that are still downloading."
        actions={
          <>
            <Btn kind="tertiary" title="◀ Levels" onPress={() => router.dismissTo('/')} />
            <Btn title="Device-type library" onPress={() => router.push({ pathname: '/library', params: { scope: 'app' } })} testID="projects.library" />
            <Btn title="Rule defaults" onPress={() => router.push('/rule-defaults')} />
            <Btn title={busy ? 'Refreshing…' : 'Refresh from server'} onPress={() => void refresh()} disabled={busy} testID="projects.refresh" />
            <Btn title="+ New project" kind="primary" onPress={() => router.push('/new-project')} testID="projects.new" />
          </>
        }
      />
      <View style={styles.notices}>
        <Notice text={error} error />
        <Notice text={notice} />
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {local.length === 0 ? <Text style={styles.empty}>No project on this iPad yet. Refresh from the server, or create one.</Text> : null}
        {local.map((p) => (
          <Card key={p.id} style={styles.card}>
            <View style={styles.grow}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.sub}>
                {p.site ? `${p.site} · ` : ''}
                {levels.get(p.id) ?? 0} level{levels.get(p.id) === 1 ? '' : 's'}
              </Text>
            </View>
            <Btn title="Setup ▸" onPress={() => router.push({ pathname: '/setup/[projectId]', params: { projectId: p.id } })} />
            <Btn title="Open" kind="primary" onPress={() => router.dismissTo({ pathname: '/', params: { project: p.id } })} testID={`projects.open.${p.name}`} />
          </Card>
        ))}
        {pending.map((p) => (
          <Card key={p.id} style={[styles.card, styles.cardPending]}>
            <View style={styles.grow}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.sub}>
                {p.site ? `${p.site} · ` : ''}
                {p.levels.length} level{p.levels.length === 1 ? '' : 's'} · downloading from the server…
              </Text>
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  notices: { paddingHorizontal: PAGE_GUTTER, paddingTop: space.sm, gap: space.xs },
  list: { paddingHorizontal: PAGE_GUTTER, paddingVertical: space.lg, gap: space.md },
  empty: { ...font.callout, color: color.text3 },
  card: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cardPending: { borderStyle: 'dashed', borderColor: color.border, backgroundColor: color.bg },
  grow: { flex: 1 },
  name: { ...font.headline, color: color.text },
  sub: { ...font.callout, ...tabular, color: color.text3, marginTop: 2 },
});