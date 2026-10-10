import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeBlobs, useBlobStatus } from '../blobs/useBlobStatus';
import { openAppStore } from '../db';
import { levelsWithPlans } from '../plan/data';
import { getSyncEngine } from '../sync/engine';
import { describeSync, useSyncStatus } from '../sync/useSyncStatus';

export default function Home() {
  const sync = useSyncStatus();
  const blobs = describeBlobs(useBlobStatus());
  const [levels, setLevels] = useState<{ id: string; code: string }[]>([]);

  // Until the project home (T18): every level on this iPad that has a display sheet.
  useEffect(() => {
    openAppStore()
      .then(levelsWithPlans)
      .then(setLevels, (e: unknown) => console.warn('[home] levels', e));
  }, [sync.lastSyncAt]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Field Survey</Text>
      <Pressable onPress={() => getSyncEngine().then((e) => e.requestSync())}>
        <Text style={styles.status}>{describeSync(sync)}</Text>
      </Pressable>
      {blobs ? <Text style={styles.status}>{blobs}</Text> : null}
      <View style={styles.levels}>
        {levels.map((l) => (
          <Link key={l.id} href={{ pathname: '/plan/[levelId]', params: { levelId: l.id } }} style={styles.link}>
            Level {l.code} plan →
          </Link>
        ))}
      </View>
      <Link href="/demo-plan" style={styles.link}>
        Demo plan (06M composite) →
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { fontSize: 32, fontWeight: '600' },
  status: { fontSize: 16, color: '#555' },
  levels: { gap: 8, alignItems: 'center', marginTop: 16 },
  link: { fontSize: 16, color: '#1565c0' },
});
