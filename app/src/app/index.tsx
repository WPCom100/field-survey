import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getSyncEngine } from '../sync/engine';
import { describeSync, useSyncStatus } from '../sync/useSyncStatus';

export default function Home() {
  const sync = useSyncStatus();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Field Survey</Text>
      <Pressable onPress={() => getSyncEngine().then((e) => e.requestSync())}>
        <Text style={styles.status}>{describeSync(sync)}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { fontSize: 32, fontWeight: '600' },
  status: { fontSize: 16, color: '#555' },
});
