import type { Store } from '@field-survey/core';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { AssignmentActions, assigneeColumns, loadAssignments, type AssignmentLevel } from './assignments';
import { SetupError } from './model';
import { Btn, Notice, Section, styles as w } from './widgets';

/**
 * Setup → Assignments (T97, D168): levels down, team names across; tap a cell to assign or
 * unassign. Each tap is one `assignment` op, saved offline and synced like any edit. The other
 * iPads' Levels home (● and "Assigned to me") and Download assigned levels follow after a sync.
 */
export function AssignmentsStep({ projectId, dataKey }: { projectId: string; dataKey: unknown }) {
  const user = useCurrentUser();
  const [store, setStore] = useState<Store | null>(null);
  const names = useTeamNames(store);
  const [levels, setLevels] = useState<AssignmentLevel[] | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const s = await openAppStore();
      const l = await loadAssignments(s, projectId);
      if (!live) return;
      setStore(s);
      setLevels(l);
    })().catch((e: unknown) => console.warn('[setup] assignments', e));
    return () => {
      live = false;
    };
  }, [projectId, reload, dataKey]);

  const run = useCallback(
    async (fn: (a: AssignmentActions) => Promise<number | void>, done?: (n: number) => string) => {
      if (!store) return;
      setError(null);
      setNotice(null);
      try {
        const n = await fn(new AssignmentActions(store, projectId, user.id));
        if (done) setNotice(done(n ?? 0));
        setReload((k) => k + 1);
      } catch (e) {
        setError(e instanceof SetupError ? e.message : `Could not save: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [store, projectId, user.id],
  );

  if (!levels) return <Text style={styles.hint}>Loading…</Text>;
  const people = assigneeColumns(
    [...names].map(([id, name]) => ({ id, name: id === user.id ? `${name} (you)` : name })),
    levels,
  );
  const plural = (n: number) => `${n} level${n === 1 ? '' : 's'}`;

  return (
    <Section title="Assignments">
      <Text style={styles.hint}>
        Tap a cell to assign a level to a person; a level can have several people, and anyone can change this. Each
        person&apos;s Levels screen marks their levels with ● and filters on &quot;Assigned to me&quot;, and Download
        assigned levels caches those plans. Someone with no assignment at all gets every in-scope level. Other iPads see
        changes after a sync.
      </Text>
      <Notice text={error} error />
      <Notice text={notice} />
      {levels.length === 0 ? <Text style={styles.hint}>No levels yet: add them under 2 Levels.</Text> : null}
      <ScrollView horizontal contentContainerStyle={{ flexDirection: 'column' }}>
        <View style={styles.head}>
          <Text style={[styles.cLevel, w.label]}>Level</Text>
          {people.map((p) => (
            <Text key={p.id} style={[styles.cPerson, w.label]} numberOfLines={2}>
              {p.name}
            </Text>
          ))}
        </View>
        {levels.map((l) => (
          <View key={l.id} style={[styles.row, !l.inScope && styles.rowDim]}>
            <View style={styles.cLevel}>
              <Text style={styles.code}>{l.code}</Text>
              {!l.inScope ? <Text style={styles.small}>out of scope</Text> : null}
              {l.inScope && l.userIds.length === 0 ? <Text style={styles.small}>nobody</Text> : null}
            </View>
            {people.map((p) => {
              const on = l.userIds.includes(p.id);
              return (
                <Pressable
                  key={p.id}
                  style={[styles.cPerson, styles.cell, on && styles.cellOn]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${l.code}: ${p.name}`}
                  onPress={() => void run((a) => a.set(l.id, p.id, !on))}
                >
                  <Text style={styles.box}>{on ? '☑' : '☐'}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
        {levels.length ? (
          <View style={styles.row}>
            <Text style={[styles.cLevel, styles.small]}>Each person</Text>
            {people.map((p) => (
              <View key={p.id} style={[styles.cPerson, styles.bulk]}>
                <Btn title="All in scope" small onPress={() => void run((a) => a.setAll(p.id, true), (n) => `${p.name}: ${plural(n)} added`)} />
                <Btn title="None" small onPress={() => void run((a) => a.setAll(p.id, false), (n) => `${p.name}: ${plural(n)} removed`)} />
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Section>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: '#666', maxWidth: 760 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e6e8ec' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  rowDim: { opacity: 0.6 },
  cLevel: { width: 100 },
  cPerson: { width: 120 },
  code: { fontSize: 17, fontWeight: '600' },
  small: { fontSize: 11, color: '#777' },
  cell: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  cellOn: { backgroundColor: '#dce8fb' },
  box: { fontSize: 22 },
  bulk: { gap: 4, alignItems: 'center' },
});
