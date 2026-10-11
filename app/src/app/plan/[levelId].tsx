import type { Store } from '@field-survey/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { getBlobFiles } from '../../blobs/queue';
import { useCurrentUser } from '../../identity/IdentityGate';
import { useTeamNames } from '../../identity/useTeamNames';
import { openAppStore } from '../../db';
import type { PlanSheet } from '../../plan/data';
import { PlanScreen } from '../../plan/PlanScreen';
import { describeSync, useSyncStatus } from '../../sync/useSyncStatus';

/**
 * Plan view of one level from the app store; the sheet and photo thumbnails come from the blob
 * cache (T12). `?device=` selects and opens that device's card on arrival (a cross-level jump).
 */
export default function LevelPlanRoute() {
  const { levelId, device } = useLocalSearchParams<{ levelId: string; device?: string }>();
  const user = useCurrentUser();
  const [store, setStore] = useState<Store | null>(null);
  const sync = useSyncStatus();
  const names = useTeamNames(store);

  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => console.error('[plan] store', e));
  }, []);

  const resolveSheetUri = useCallback((sheet: PlanSheet) => {
    if (!sheet.blob) return null;
    const files = getBlobFiles();
    const file = files.file(files.pathFor(sheet.blob, 'sheet'));
    return file.exists ? file.uri : null;
  }, []);

  const resolveBlobUri = useCallback((sha: string, kind: 'thumb' | 'image') => {
    const files = getBlobFiles();
    const file = files.file(files.pathFor(sha, kind));
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
      userId={user.id}
      names={names}
      resolveBlobUri={resolveBlobUri}
      initialDeviceId={device}
      onOpenLevel={(other, deviceId) => router.push({ pathname: '/plan/[levelId]', params: { levelId: other, device: deviceId } })}
    />
  );
}
