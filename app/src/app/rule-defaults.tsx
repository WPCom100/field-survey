import { Editor, LIBRARY_STREAM, type Store } from '@field-survey/core';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { SectionScreen } from '../home/SectionScreen';
import { useCurrentUser } from '../identity/IdentityGate';
import { RuleParamsEditor } from '../rules/RuleParamsEditor';
import { projectDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Notice } from '../setup/widgets';
import { PAGE_GUTTER, color, font, space } from '../ui';

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
    <SectionScreen title="Rule defaults" intro="What a new project's Rules start from. A change is a draft until accepted." backTestID="ruleDefaults.back">
      {error ? (
        <View style={styles.notice}>
          <Notice text={error} error />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {store && editor ? <RuleParamsEditor store={store} editor={editor} scope={null} dataKey={projectDataKey(sync, LIBRARY_STREAM)} /> : <Text style={styles.loading}>Loading…</Text>}
      </ScrollView>
    </SectionScreen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: PAGE_GUTTER, paddingTop: space.lg, paddingBottom: 80 },
  loading: { ...font.callout, color: color.text3 },
  notice: { paddingHorizontal: PAGE_GUTTER },
});