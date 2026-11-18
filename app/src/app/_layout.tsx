import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { LogBox, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlobalStatusBar } from '../components/StatusBar';
import { openAppStore } from '../db';
import { IdentityGate } from '../identity/IdentityGate';
import { TypeSetupHost } from '../library/TypeSetupSheet';
import { logTo } from '../log';
import { RulesRunner } from '../rules/RulesRunner';
import { SyncRunner } from '../sync/SyncRunner';
import { useUpdateLog } from '../sync/useAppUpdates';
import { transitionFor, type NavState } from '../ui/navStack';

// The Mac test rig (T156): `rig.sh metro` starts Metro with EXPO_PUBLIC_RIG=1, and the dev client's
// error toasts stay off the screen — T161's toast took Maestro's taps over and over. The errors
// still reach the log file (`rig.sh log`). Builds from EAS never set it.
if (__DEV__ && process.env.EXPO_PUBLIC_RIG === '1') LogBox.ignoreAllLogs(true);

export default function RootLayout() {
  // OTA updates (T84): launch line (embedded vs update id, runtime version) and every check result.
  useUpdateLog();

  useEffect(() => {
    // Migrate the local store at launch; a failure is logged, never blocks the UI.
    openAppStore().then(
      (store) => logTo('store', 'info', 'open', { search: store.searchMode, install: store.installId }),
      (e: unknown) => logTo('store', 'error', 'open_failed', { error: String(e) }),
    );
  }, []);

  return (
    <IdentityGate>
      <SyncRunner />
      <RulesRunner />
      {/* first use of a draft type (T200): the one sheet every screen hands its questions to */}
      <TypeSetupHost />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <GlobalStatusBar />
        <View style={{ flex: 1 }}>
          {/* a section opened from the sidebar or the rail neither slides nor takes the edge swipe (D280, T188) */}
          <Stack screenOptions={({ route, navigation }) => ({ headerShown: false, ...transitionFor(navigation.getState() as NavState | undefined, route.key) })} />
        </View>
      </SafeAreaView>
    </IdentityGate>
  );
}
