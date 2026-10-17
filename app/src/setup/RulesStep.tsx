import { Editor, type Store } from '@field-survey/core';
import { useEffect, useMemo, useState } from 'react';
import { Text } from 'react-native';

import { openAppStore } from '../db';
import { useCurrentUser } from '../identity/IdentityGate';
import { RuleParamsEditor } from '../rules/RuleParamsEditor';
import { Section } from './widgets';

/**
 * Setup → Rules (T102, D176 (4)): this project's rule parameters, beside Assignments because
 * they change all through the survey, not once. Edits are `Master edit` ops on the project.
 */
export function RulesStep({ projectId, dataKey }: { projectId: string; dataKey: unknown }) {
  const user = useCurrentUser();
  const [store, setStore] = useState<Store | null>(null);
  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => console.warn('[setup] rules', e));
  }, []);
  const editor = useMemo(() => (store ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);
  return (
    <Section title="Rules">
      {store && editor ? <RuleParamsEditor store={store} editor={editor} scope={projectId} dataKey={dataKey} /> : <Text>Loading…</Text>}
    </Section>
  );
}
