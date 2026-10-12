import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  type Identity,
  type TeamMember,
  addTeamMember,
  clearIdentity,
  fetchTeam,
  loadIdentity,
  saveConnection,
  saveUser,
} from './api';

type Signed = Identity & { user: TeamMember };

const Ctx = createContext<Signed | null>(null);
const SignOutCtx = createContext<(() => Promise<void>) | null>(null);

/** The user stamped on every op (`Store.apply`, T07+). Only valid under <IdentityGate>. */
export function useCurrentUser(): TeamMember {
  return useIdentity().user;
}

/** Server URL, token and user: what the sync engine's transport needs (T11). */
export function useIdentity(): Signed {
  const i = useContext(Ctx);
  if (!i) throw new Error('useIdentity outside IdentityGate');
  return i;
}

/** Re-sign-in (T25): forgets the connection and returns to the connect screen. Edits are kept. */
export function useSignOut(): () => Promise<void> {
  const out = useContext(SignOutCtx);
  if (!out) throw new Error('useSignOut outside IdentityGate');
  return out;
}

/** First-launch flow: server + token, then pick a name. Renders children once a user is set. */
export function IdentityGate({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined);

  useEffect(() => {
    loadIdentity().then(setIdentity, () => setIdentity(null));
  }, []);

  if (identity === undefined) return <ActivityIndicator style={styles.center} />;
  if (!identity) return <ConnectForm onDone={setIdentity} />;
  if (!identity.user) {
    return <Picker identity={identity} onDone={(user) => setIdentity({ ...identity, user })} />;
  }
  const signOut = async () => {
    await clearIdentity();
    setIdentity(null);
  };
  return (
    <SignOutCtx.Provider value={signOut}>
      <Ctx.Provider value={identity as Signed}>{children}</Ctx.Provider>
    </SignOutCtx.Provider>
  );
}

function ConnectForm({ onDone }: { onDone: (i: Identity) => void }) {
  const [serverUrl, setServerUrl] = useState('https://');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    const candidate = { serverUrl: serverUrl.replace(/\/+$/, ''), token };
    try {
      await fetchTeam(candidate);
      await saveConnection(candidate.serverUrl, candidate.token);
      onDone(candidate);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot reach server');
    }
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Connect to server</Text>
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Server URL"
        placeholderTextColor="#888"
      />
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="Team token"
        placeholderTextColor="#888"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>Connect</Text>
      </Pressable>
    </View>
  );
}

function Picker({ identity, onDone }: { identity: Identity; onDone: (u: TeamMember) => void }) {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetchTeam(identity).then(setTeam, (e) => setError(String(e.message ?? e)));
  }, [identity]);

  async function choose(u: TeamMember) {
    await saveUser(u);
    onDone(u);
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Who is surveying?</Text>
      {team.map((m) => (
        <Pressable key={m.id} style={styles.button} onPress={() => choose(m)}>
          <Text style={styles.buttonText}>{m.name}</Text>
        </Pressable>
      ))}
      <TextInput
        style={styles.input}
        value={newName}
        onChangeText={setNewName}
        placeholder="Not listed? Add your name"
        placeholderTextColor="#888"
      />
      {newName.trim() ? (
        <Pressable
          style={styles.button}
          onPress={() => addTeamMember(identity, newName.trim()).then(choose, (e) => setError(String(e)))}
        >
          <Text style={styles.buttonText}>Add and continue</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

// Explicit light colours: the app's screens are light-only, and with the iPad in dark mode the
// window behind this screen is black, so default text (black) vanished (T25-11, 2026-10-11).
const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: '#ffffff' },
  title: { fontSize: 28, fontWeight: '600', color: '#111' },
  input: {
    borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12, width: 360, fontSize: 18,
    color: '#111', backgroundColor: '#ffffff',
  },
  button: { backgroundColor: '#1f6feb', borderRadius: 8, padding: 14, width: 360, alignItems: 'center' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: '600' },
  error: { color: '#c00' },
});
