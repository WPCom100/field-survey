import { Editor, LIBRARY_STREAM, type Store } from '@field-survey/core';
import { Link } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { useCurrentUser } from '../identity/IdentityGate';
import { RuleParamsEditor } from '../rules/RuleParamsEditor';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

/**
 * App-level rule defaults (T102, D176 (2), (4)), opened from the Projects list beside the
 * device-type library: what a new project's Rules start from. Edits go to the app library's op
 * stream (`/library/ops`, D184) as drafts until accepted; project creation copies the accepted ones.
 */
export default function RuleDefaultsRoute() {
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => setError(String(e)));
  }, []);
  const editor = useMemo(() => (store ? new Editor(store, { projectId: LIBRARY_STREAM, userId: user.id }) : null), [store, user.id]);
  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <Link href="/projects" style={styles.link}>
          ◀ Projects
        </Link>
        <Text style={styles.title}>Rule defaults</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {store && editor ? <RuleParamsEditor store={store} editor={editor} scope={null} dataKey={syncDataKey(sync)} /> : <Text>Loading…</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 16, borderBottomWidth: 1, borderBottomColor: '#e6e8ec' },
  title: { fontSize: 22, fontWeight: '700' },
  link: { color: '#1f6feb', fontSize: 16 },
  body: { padding: 16, paddingBottom: 80 },
  error: { padding: 12, color: '#b3261e' },
});
