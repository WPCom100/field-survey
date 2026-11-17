import type { BlobQueue, Store } from '@field-survey/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { getBlobFiles, getBlobQueue } from '../../blobs/queue';
import { useShell } from '../../home/useShell';
import { useCurrentUser } from '../../identity/IdentityGate';
import { useTeamNames } from '../../identity/useTeamNames';
import { openAppStore } from '../../db';
import type { PlanSheet } from '../../plan/data';
import { PlanScreen } from '../../plan/PlanScreen';
import { handRuling } from '../../rulings/handoff';
import { projectDataKey } from '../../sync/dataKey';
import { useSyncStatus } from '../../sync/useSyncStatus';
import { goBack, useBack } from '../../ui/useNav';

/**
 * Plan view of one level from the app store; the sheet and photo thumbnails come from the blob
 * cache (T12). `?device=` selects and opens that device's card on arrival (a cross-level jump).
 * Photos taken here go to the app's blob queue (T21); the status strip over every screen shows
 * "n photos waiting". The rail (T177) gets the project's name and count pills from `useShell`;
 * the back button names the screen under the plan in the Stack (`useBack`, D280, T188).
 * `?review=` draws that pin-position conflict on the plan with Choose A / Choose B (T26).
 * Select in the side lists → "Apply as ruling…" opens the ruling editor over the chosen records (T37).
 * `?place=1` opens with the Place devices panel (T46: Setup → 5 Place devices, Needs review).
 */
export default function LevelPlanRoute() {
  const { levelId, device, review, place } = useLocalSearchParams<{ levelId: string; device?: string; review?: string; place?: string }>();
  const user = useCurrentUser();
  const [store, setStore] = useState<Store | null>(null);
  const [blobs, setBlobs] = useState<BlobQueue | null>(null);
  const sync = useSyncStatus();
  const names = useTeamNames(store);
  // the level's project, so the plan reloads on its own project's pulls only (T185)
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (!store || !levelId) return;
    store.get<{ project_id?: unknown }>('level', levelId).then(
      (l) => setProjectId(typeof l?.project_id === 'string' ? l.project_id : null),
      () => setProjectId(null),
    );
  }, [store, levelId]);
  const dataKey = projectDataKey(sync, projectId);
  const shell = useShell(store, levelId, projectId, user, dataKey);
  // The back button returns to the screen under the plan in the Stack and says which (T177, T188).
  const back = useBack();

  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => console.error('[plan] store', e));
    getBlobQueue().then(setBlobs, (e: unknown) => console.error('[blobs] queue', e));
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
      onBack={back?.onPress ?? goBack}
      backLabel={back?.label}
      shell={shell}
      reloadKey={dataKey}
      userId={user.id}
      names={names}
      resolveBlobUri={resolveBlobUri}
      initialDeviceId={device}
      reviewItemId={review}
      initialPlacing={place === '1'}
      onReviewResolved={() => (router.canGoBack() ? router.back() : router.replace('/review'))}
      blobs={blobs}
      onOpenLevel={(other, deviceId) => router.push({ pathname: '/plan/[levelId]', params: { levelId: other, device: deviceId } })}
      onApplyAsRuling={(projectId, draft, source) => {
        handRuling(projectId, draft, source);
        router.push({ pathname: '/rulings', params: { project: projectId, from: 'handoff' } });
      }}
    />
  );
}
