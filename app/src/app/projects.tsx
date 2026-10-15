import { Link, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { listProjects, type HomeProject } from '../home/data';
import { useIdentity } from '../identity/IdentityGate';
import { fetchProjects, type ServerProject } from '../setup/api';
import { Btn, Notice } from '../setup/widgets';
import { getSyncEngine } from '../sync/engine';
import { useSyncStatus } from '../sync/useSyncStatus';
import { syncDataKey } from '../sync/dataKey';

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

  useEffect(() => {
    let live = true;
    (async () => {
      const store = await openAppStore();
      const list = await listProjects(store);
      const counts = new Map<string, number>();
      for (const r of await store.db.query<{ project_id: string; n: number }>(
        `SELECT project_id, count(*) AS n FROM level WHERE deleted_at IS NULL GROUP BY project_id`,
        [],
      )) {
        counts.set(r.project_id, r.n);
      }
      if (!live) return;
      setLocal(list);
      setLevels(counts);
    })().catch((e: unknown) => console.warn('[projects] load', e));
    return () => {
      live = false;
    };
  }, [dataKey, sync.pendingOps]);

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
      <View style={styles.top}>
        <Link href="/" style={styles.back}>
          ◀ Levels
        </Link>
        <Text style={styles.title}>Projects</Text>
        <View style={{ flex: 1 }} />
        <Btn title="Device-type library" onPress={() => router.push({ pathname: '/library', params: { scope: 'app' } })} />
        <Btn title={busy ? 'Refreshing…' : 'Refresh from server'} onPress={() => void refresh()} disabled={busy} />
        <Btn title="+ New project" primary onPress={() => router.push('/new-project')} />
      </View>
      <Notice text={error} error />
      <Notice text={notice} />
      <ScrollView contentContainerStyle={styles.list}>
        {local.length === 0 ? (
          <Text style={styles.empty}>No project on this iPad yet. Refresh from the server, or create one.</Text>
        ) : null}
        {local.map((p) => (
          <View key={p.id} style={styles.card}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.sub}>
                {p.site ? `${p.site} · ` : ''}
                {levels.get(p.id) ?? 0} level{levels.get(p.id) === 1 ? '' : 's'}
              </Text>
            </View>
            <Pressable onPress={() => router.push({ pathname: '/setup/[projectId]', params: { projectId: p.id } })} style={styles.action}>
              <Text style={styles.actionText}>Setup ▸</Text>
            </Pressable>
            <Pressable onPress={() => router.push({ pathname: '/', params: { project: p.id } })} style={[styles.action, styles.actionPrimary]}>
              <Text style={[styles.actionText, styles.actionTextPrimary]}>Open</Text>
            </Pressable>
          </View>
        ))}
        {pending.map((p) => (
          <View key={p.id} style={[styles.card, styles.cardPending]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.sub}>
                {p.site ? `${p.site} · ` : ''}
                {p.levels.length} level{p.levels.length === 1 ? '' : 's'} · downloading from the server…
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: '#e6e8ec' },
  back: { fontSize: 15, color: '#1565c0' },
  title: { fontSize: 24, fontWeight: '600' },
  list: { padding: 16, gap: 10 },
  empty: { fontSize: 15, color: '#666' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderColor: '#d5d9e0', borderRadius: 8 },
  cardPending: { opacity: 0.6, borderStyle: 'dashed' },
  name: { fontSize: 18, fontWeight: '600' },
  sub: { fontSize: 14, color: '#555', marginTop: 2 },
  action: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0' },
  actionPrimary: { backgroundColor: '#1565c0' },
  actionText: { color: '#1565c0', fontWeight: '600' },
  actionTextPrimary: { color: '#fff' },
});
