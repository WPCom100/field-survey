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
import { projectDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import { color, font, space } from '../ui';

/**
 * The device-type library (Phase 3 §10): one library for every project (T197, D287). The
 * sidebar's Library (`?project=`) and Projects' Library (`?scope=app`, no project needed) open the
 * same screen; every edit goes to the library's own op stream (`/library/ops`, D184). The project
 * only gives each type its device count in that project and lights the sidebar's entry.
 */
export default function LibraryRoute() {
  const params = useLocalSearchParams<{ project?: string; scope?: string }>();
  const app = params.scope === 'app';
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const names = useTeamNames(store);

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        setProjectId(app ? null : pickProject((await listProjects(s)).map((p) => p.id), params.project));
        setReady(true);
      },
      (e: unknown) => setError(String(e)),
    );
  }, [params.project, app]);

  const editor = useMemo(() => (store ? new Editor(store, { projectId: LIBRARY_STREAM, userId: user.id }) : null), [store, user.id]);

  return (
    <>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <LibraryScreen
        store={ready ? store : null}
        editor={editor}
        projectId={projectId}
        // the open project's pulls (its device counts) and the library's; from Projects the library's only
        dataKey={projectDataKey(sync, projectId ?? LIBRARY_STREAM)}
        names={names}
        onOpenReview={() => router.push({ pathname: '/review', params: { project: LIBRARY_STREAM } })}
        app={app}
      />
    </>
  );
}

const styles = StyleSheet.create({
  error: { ...font.callout, padding: space.md, color: color.danger, backgroundColor: color.dangerTint },
});
