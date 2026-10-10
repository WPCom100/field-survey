import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  type Identity,
  type TeamMember,
  addTeamMember,
  fetchTeam,
  loadIdentity,
  saveConnection,
  saveUser,
} from './api';

const Ctx = createContext<TeamMember | null>(null);

/** The user stamped on every op (`Store.apply`, T07+). Only valid under <IdentityGate>. */
export function useCurrentUser(): TeamMember {
  const u = useContext(Ctx);
  if (!u) throw new Error('useCurrentUser outside IdentityGate');
  return u;
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
  return <Ctx.Provider value={identity.user}>{children}</Ctx.Provider>;
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
      />
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="Team token"
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

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 28, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12, width: 360, fontSize: 18 },
  button: { backgroundColor: '#1f6feb', borderRadius: 8, padding: 14, width: 360, alignItems: 'center' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: '600' },
  error: { color: '#c00' },
});
