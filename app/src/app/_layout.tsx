import { Stack } from 'expo-router';

import { IdentityGate } from '../identity/IdentityGate';

export default function RootLayout() {
  return (
    <IdentityGate>
      <Stack screenOptions={{ headerShown: false }} />
    </IdentityGate>
  );
}
