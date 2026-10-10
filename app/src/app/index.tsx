import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeBlobs, useBlobStatus } from '../blobs/useBlobStatus';
import { getSyncEngine } from '../sync/engine';
import { describeSync, useSyncStatus } from '../sync/useSyncStatus';

export default function Home() {
  const sync = useSyncStatus();
  const blobs = describeBlobs(useBlobStatus());
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Field Survey</Text>
      <Pressable onPress={() => getSyncEngine().then((e) => e.requestSync())}>
        <Text style={styles.status}>{describeSync(sync)}</Text>
      </Pressable>
      {blobs ? <Text style={styles.status}>{blobs}</Text> : null}
      <Link href="/spike" style={styles.link}>
        TP-6 plan viewer spike →
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { fontSize: 32, fontWeight: '600' },
  status: { fontSize: 16, color: '#555' },
  link: { fontSize: 16, color: '#1565c0', marginTop: 24 },
});
