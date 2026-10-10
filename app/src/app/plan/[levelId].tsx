import type { Store } from '@field-survey/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { getBlobFiles } from '../../blobs/queue';
import { openAppStore } from '../../db';
import type { PlanSheet } from '../../plan/data';
import { PlanScreen } from '../../plan/PlanScreen';
import { describeSync, useSyncStatus } from '../../sync/useSyncStatus';

/** Plan view of one level from the app store; the sheet comes from the blob cache (T12). */
export default function LevelPlanRoute() {
  const { levelId } = useLocalSearchParams<{ levelId: string }>();
  const [store, setStore] = useState<Store | null>(null);
  const sync = useSyncStatus();

  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => console.error('[plan] store', e));
  }, []);

  const resolveSheetUri = useCallback((sheet: PlanSheet) => {
    if (!sheet.blob) return null;
    const files = getBlobFiles();
    const file = files.file(files.pathFor(sheet.blob, 'sheet'));
    return file.exists ? file.uri : null;
  }, []);

  if (!store || !levelId) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <PlanScreen
      store={store}
      levelId={levelId}
      resolveSheetUri={resolveSheetUri}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      status={describeSync(sync)}
      reloadKey={sync.lastSyncAt}
    />
  );
}
