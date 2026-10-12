import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlobalStatusBar } from '../components/StatusBar';
import { openAppStore } from '../db';
import { IdentityGate } from '../identity/IdentityGate';
import { logTo } from '../log';
import { SyncRunner } from '../sync/SyncRunner';

export default function RootLayout() {
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
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <GlobalStatusBar />
        <View style={{ flex: 1 }}>
          <Stack screenOptions={{ headerShown: false }} />
        </View>
      </SafeAreaView>
    </IdentityGate>
  );
}
