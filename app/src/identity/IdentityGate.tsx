import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

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
import { SignInCancelled } from './microsoft';
import { mergeQuestion, type MergePending } from './session';
import { signInWithMicrosoft } from './signin';

type Signed = Identity & { user: TeamMember };

/**
 * The one production server (docs/ops.md): the Connect screen starts with it filled in, so
 * "Sign in with Microsoft" works with no typing. Still editable — the Mac rig types its local
 * e2e server over it (`app/maestro/_connect.yaml`).
 */
export const DEFAULT_SERVER_URL = 'https://survey.wpcom.cloud';

const Ctx = createContext<Signed | null>(null);
const SignOutCtx = createContext<(() => Promise<void>) | null>(null);
const MicrosoftCtx = createContext<(() => Promise<void>) | null>(null);

/** The user stamped on every op (`Store.apply`, T07+). Only valid under <IdentityGate>. */
export function useCurrentUser(): TeamMember {
  return useIdentity().user;
}

/** Server URL, token or Microsoft session, and user: what the sync engine's transport needs (T11, T04). */
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

/**
 * "Sign in with Microsoft" from inside the app (Sync screen, T04): on this iPad's server, offering
 * the merge of the picker name it was using. Resolves once signed in (the sync engine restarts with
 * the new session); rejects with the reason, or `SignInCancelled` when the sheet was closed.
 */
export function useMicrosoftSignIn(): () => Promise<void> {
  const fn = useContext(MicrosoftCtx);
  if (!fn) throw new Error('useMicrosoftSignIn outside IdentityGate');
  return fn;
}

/** The merge confirmation (D264): the person says whether the team-picker user is them. */
export function askMerge(p: MergePending): Promise<boolean> {
  const q = mergeQuestion(p);
  return new Promise((resolve) =>
    Alert.alert(
      q.title,
      q.message,
      [
        { text: q.no, onPress: () => resolve(false) },
        { text: q.yes, onPress: () => resolve(true) },
      ],
      { cancelable: false },
    ),
  );
}

/**
 * First-launch flow: server + token, then pick a name; or server + "Sign in with Microsoft" (T04).
 * Renders children once a user is set.
 * `testID`s (`connect.*`, `identity.*`) are what the Maestro flows tap (T149, `app/maestro/`).
 */
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
  const microsoft = async () => {
    setIdentity(await signInWithMicrosoft(identity.serverUrl, { interimName: identity.user?.name, confirmMerge: askMerge }));
  };
  return (
    <SignOutCtx.Provider value={signOut}>
      <MicrosoftCtx.Provider value={microsoft}>
        <Ctx.Provider value={identity as Signed}>{children}</Ctx.Provider>
      </MicrosoftCtx.Provider>
    </SignOutCtx.Provider>
  );
}

function ConnectForm({ onDone }: { onDone: (i: Identity) => void }) {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  async function microsoft() {
    setError('');
    setBusy(true);
    try {
      onDone(await signInWithMicrosoft(serverUrl, { confirmMerge: askMerge }));
    } catch (e) {
      if (!(e instanceof SignInCancelled)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
        keyboardType="url"
        selectTextOnFocus // a tap selects the whole URL, so typing replaces it (no leftover tail)
        placeholder="Server URL"
        placeholderTextColor="#888"
        testID="connect.serverUrl"
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
        testID="connect.token"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={submit} testID="connect.submit">
        <Text style={styles.buttonText}>Connect</Text>
      </Pressable>
      <Text style={styles.or}>or, on a server with Microsoft sign-in (no token needed)</Text>
      <Pressable style={[styles.button, styles.microsoft]} onPress={microsoft} disabled={busy} testID="connect.microsoft">
        <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in with Microsoft'}</Text>
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
        <Pressable key={m.id} style={styles.button} onPress={() => choose(m)} testID={`identity.user.${m.name}`}>
          <Text style={styles.buttonText}>{m.name}</Text>
        </Pressable>
      ))}
      <TextInput
        style={styles.input}
        value={newName}
        onChangeText={setNewName}
        placeholder="Not listed? Add your name"
        placeholderTextColor="#888"
        testID="identity.newName"
      />
      {newName.trim() ? (
        <Pressable
          style={styles.button}
          onPress={() => addTeamMember(identity, newName.trim()).then(choose, (e) => setError(String(e)))}
          testID="identity.add"
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
  or: { color: '#555', marginTop: 8 },
  microsoft: { backgroundColor: '#2f2f2f' },
});
