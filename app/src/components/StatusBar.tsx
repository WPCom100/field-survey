import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeBlobs, useBlobStatus } from '../blobs/useBlobStatus';
import { getSyncEngine } from '../sync/engine';
import { describeSync, useSyncStatus } from '../sync/useSyncStatus';

/** Global status bar (T18): sync state, pending edits, photos waiting. Tap to sync now. */
export function GlobalStatusBar() {
  const sync = useSyncStatus();
  const blobs = describeBlobs(useBlobStatus());
  const bad = sync.state === 'error' || sync.state === 'offline' || sync.state === 'no_token';
  return (
    <Pressable
      onPress={() => getSyncEngine().then((e) => e.requestSync())}
      style={[styles.bar, bad && styles.warn]}
      accessibilityRole="button"
      accessibilityLabel="Sync status"
    >
      <View style={styles.row}>
        <Text style={styles.text}>{describeSync(sync)}</Text>
        {blobs ? <Text style={styles.text}>{blobs}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: '#eef1f5', paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#d5d9e0' },
  warn: { backgroundColor: '#fff4d6' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  text: { fontSize: 13, color: '#444' },
});
