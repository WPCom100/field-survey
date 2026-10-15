import { Editor, type Store } from '@field-survey/core';
import { Link, useLocalSearchParams } from 'expo-router';
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

/** The project's device-type library (T48, Phase 3 §10). `?project=` names the project. */
export default function LibraryRoute() {
  const params = useLocalSearchParams<{ project?: string }>();
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
        setProjectId(pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setError(String(e)),
    );
  }, [params.project]);

  const editor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);

  return (
    <>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <LibraryScreen
        store={projectId ? store : null}
        editor={editor}
        scope={projectId}
        dataKey={syncDataKey(sync)}
        names={names}
        header={
          <Link href={{ pathname: '/', params: projectId ? { project: projectId } : {} }} style={styles.link}>
            ◀ Levels
          </Link>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  link: { color: '#1f6feb', fontSize: 16 },
  error: { padding: 12, color: '#b3261e', backgroundColor: '#fff' },
});
