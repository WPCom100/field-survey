import { Store } from '@field-survey/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';

import { ExpoSqliteDriver } from '../db/expo-sqlite-driver';
import { ensureDemoLevel } from '../plan/demo';
import { PlanScreen } from '../plan/PlanScreen';

// Private golden fixture, served by Metro in development and bundled by EAS otherwise.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SHEET = Image.resolveAssetSource(require('../../../fixtures/Level_06M_-_Lighting_Composite_vector.pdf'));

/** The demo database. `demo-plan.db` was left half-seeded by the T17 transaction crash (D102). */
const DEMO_DB = 'demo-plan-2.db';
const STALE = ['demo-plan.db', 'probe-like.db', 'probe-fts.db', 'probe-c.db', 'probe-d.db', 'probe-e.db', 'probe-f.db', 'probe-g.db'];

/** Opened once: a separate database that no sync engine ever sees (never the app store). */
let demo: Promise<{ store: Store; levelId: string }> | null = null;
function openDemo() {
  if (!demo) {
    const log = (m: string) => console.log(`[plan] demo: ${m}`);
    demo = Promise.all(STALE.map(ExpoSqliteDriver.remove))
      .then(() => ExpoSqliteDriver.open(DEMO_DB))
      .then((driver) => Store.open(driver))
      .then(async (store) => ({ store, levelId: await ensureDemoLevel(store, log) }))
      .catch((e) => {
        demo = null;
        throw e;
      });
  }
  return demo;
}

/**
 * Demo level (T17): the 06M composite with seeded devices, for trying the plan view before setup
 * puts real sheets on the iPad, and the TP-6 bench that replaced the T16 spike.
 */
export default function DemoPlanRoute() {
  const [state, setState] = useState<{ store: Store; levelId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    openDemo().then(setState, (e: unknown) => setError(String(e)));
  }, []);

  if (!state) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        {error ? <Text>{error}</Text> : <ActivityIndicator />}
      </View>
    );
  }
  return (
    <PlanScreen
      store={state.store}
      levelId={state.levelId}
      resolveSheetUri={() => SHEET.uri}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      status="Demo data — not synced"
      bench
    />
  );
}
