import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { openAppStore } from '../db';
import { IdentityGate } from '../identity/IdentityGate';

export default function RootLayout() {
  useEffect(() => {
    // Migrate the local store at launch; a failure is logged, never blocks the UI.
    openAppStore().then(
      (store) => console.log(`[store] open: search=${store.searchMode} install=${store.installId}`),
      (e: unknown) => console.error('[store] open failed', e),
    );
  }, []);

  return (
    <IdentityGate>
      <Stack screenOptions={{ headerShown: false }} />
    </IdentityGate>
  );
}
