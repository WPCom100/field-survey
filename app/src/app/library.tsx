import { Editor, LIBRARY_STREAM, type Store } from '@field-survey/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { LibraryScreen } from '../library/LibraryScreen';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Btn, color, font, space } from '../ui';

/**
 * The device-type library (Phase 3 §10): a project's (T48, `?project=`) or the app library
 * (T61, D65, `?scope=app`, opened from the Projects list, no project needed). App-library edits
 * go to the library's own op stream (`/library/ops`, D184).
 */
export default function LibraryRoute() {
  const params = useLocalSearchParams<{ project?: string; scope?: string }>();
  const app = params.scope === 'app';
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const names = useTeamNames(store);

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        if (!app) setProjectId(pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setError(String(e)),
    );
  }, [params.project, app]);

  const libraryEditor = useMemo(() => (store ? new Editor(store, { projectId: LIBRARY_STREAM, userId: user.id }) : null), [store, user.id]);
  const editor = useMemo(
    () => (app ? libraryEditor : store && projectId ? new Editor(store, { projectId, userId: user.id }) : null),
    [app, libraryEditor, store, projectId, user.id],
  );
  const reviewOf = app ? LIBRARY_STREAM : projectId;

  return (
    <>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <LibraryScreen
        store={app || projectId ? store : null}
        editor={editor}
        libraryEditor={app ? null : libraryEditor}
        scope={app ? null : projectId}
        dataKey={syncDataKey(sync)}
        names={names}
        onOpenReview={reviewOf ? () => router.push({ pathname: '/review', params: { project: reviewOf } }) : undefined}
        header={
          app ? (
            <Btn kind="tertiary" title="◀ Projects" onPress={() => router.dismissTo('/projects')} />
          ) : (
            <Btn kind="tertiary" title="◀ Levels" onPress={() => router.dismissTo({ pathname: '/', params: projectId ? { project: projectId } : {} })} />
          )
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  error: { ...font.callout, padding: space.md, color: color.danger, backgroundColor: color.dangerTint },
});
