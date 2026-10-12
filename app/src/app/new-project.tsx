import { Link, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { listProjects, type HomeProject } from '../home/data';
import { useIdentity } from '../identity/IdentityGate';
import { createProject, fetchProjects, type NewLevel, type NewProjectBody } from '../setup/api';
import { DEFAULT_EXPORT_TITLE, SetupError, normLevelCode, parseLevelRange } from '../setup/model';
import { Btn, Check, ChipPicker, Field, HeadCell, LEVEL_HELP, Notice, ScopeSwitch, Section, styles as w } from '../setup/widgets';
import { getSyncEngine } from '../sync/engine';

type DraftLevel = { code: string; inScope: boolean; shareWith: string | null; splitOf: string | null };

/**
 * New project (Phase 3 §3.1): name, site, parties, copy-from with its four switches, export
 * title and disclaimer, then the levels table with Add level / Add range, numbering sharing,
 * split-of and in-scope. One `POST /projects` creates it all server-side (numbering groups
 * must exist before any op, D127); the iPad then pulls it. Needs a connection.
 */
export default function NewProjectScreen() {
  const identity = useIdentity();
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [ec, setEc] = useState('');
  const [etc, setEtc] = useState('ETC Field Service');
  const [gc, setGc] = useState('');
  const [exportTitle, setExportTitle] = useState(DEFAULT_EXPORT_TITLE);
  const [disclaimer, setDisclaimer] = useState('');
  const [sources, setSources] = useState<HomeProject[]>([]);
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [flags, setFlags] = useState({ vocabulary: true, library: true, rulings: true, placeholders: false });
  const [levels, setLevels] = useState<DraftLevel[]>([]);
  const [newCode, setNewCode] = useState('');
  const [range, setRange] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);
  /** Keep the Add level field in view above the keyboard (P-3); after the keyboard has animated in. */
  const toBottom = () => setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 300);

  // Copy-from candidates: projects on this iPad plus whatever the server lists.
  useEffect(() => {
    let live = true;
    (async () => {
      const store = await openAppStore();
      const local = await listProjects(store);
      if (live) setSources(local);
      try {
        const remote = await fetchProjects(identity, store);
        const seen = new Set(local.map((p) => p.id));
        if (live) setSources([...local, ...remote.filter((p) => !seen.has(p.id)).map((p) => ({ id: p.id, name: p.name, site: p.site }))]);
      } catch {
        /* offline: local only */
      }
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [identity]);

  const codes = useMemo(() => levels.map((l) => ({ id: l.code, label: l.code })), [levels]);

  const addLevel = () => {
    setError(null);
    const code = normLevelCode(newCode);
    if (!code) return;
    if (levels.some((l) => l.code === code)) return setError(`Level ${code} is already in the list`);
    setLevels([...levels, { code, inScope: true, shareWith: null, splitOf: null }]);
    setNewCode('');
    toBottom();
  };

  const addRange = () => {
    setError(null);
    try {
      const have = new Set(levels.map((l) => l.code));
      const fresh = parseLevelRange(range).filter((c) => !have.has(c));
      setLevels([...levels, ...fresh.map((code) => ({ code, inScope: false, shareWith: null, splitOf: null }))]);
      setRange('');
    } catch (e) {
      setError(e instanceof SetupError ? e.message : String(e));
    }
  };

  const update = (i: number, patch: Partial<DraftLevel>) => setLevels(levels.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => {
    const gone = levels[i]!.code;
    setLevels(levels.filter((_, k) => k !== i).map((l) => ({ ...l, shareWith: l.shareWith === gone ? null : l.shareWith, splitOf: l.splitOf === gone ? null : l.splitOf })));
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= levels.length) return;
    const next = [...levels];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setLevels(next);
  };

  const create = async () => {
    setError(null);
    if (!name.trim()) return setError('The project needs a name');
    setBusy(true);
    try {
      const body: NewProjectBody = {
        name: name.trim(),
        site: site.trim(),
        parties: { ec: ec.trim(), etc: etc.trim(), gc: gc.trim() },
        settings: { export_title: exportTitle.trim() || DEFAULT_EXPORT_TITLE, disclaimer: disclaimer.trim() },
        levels: levels.map(
          (l): NewLevel => ({
            level: l.code,
            in_scope: l.inScope,
            ...(l.shareWith ? { share_with: l.shareWith } : {}),
            ...(l.splitOf ? { split_of: l.splitOf } : {}),
          }),
        ),
      };
      if (copyFrom) body.copy_from = { project_id: copyFrom, ...flags };
      const store = await openAppStore();
      const created = await createProject(identity, store, body);
      const engine = await getSyncEngine();
      await engine.requestSync(); // pulls the new project, its levels and copies
      router.replace({ pathname: '/', params: { project: created.id } });
    } catch (e) {
      setError(`Could not create the project: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.side}>
        <Link href="/projects" style={styles.back}>
          ◀ Projects
        </Link>
        <Text style={styles.sideTitle}>New project</Text>
        {['1 Project', '2 Levels', '3 Sources', '4 Review drafts', '5 Place devices', '6 Lock baseline'].map((s, i) => (
          <Text key={s} style={[styles.step, i > 1 && styles.stepDim]}>
            {s}
            {i < 2 ? '  ●' : ''}
          </Text>
        ))}
        <Text style={styles.hint}>Sources, review, placing and locking come after the project exists (T28, T44–T47).</Text>
      </View>

      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={styles.main} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Section title="Project">
          <Field label="Name" value={name} onChange={setName} placeholder="Houston Methodist Centennial Tower" />
          <Field label="Site" value={site} onChange={setSite} placeholder="Houston, TX" />
          <View style={w.row}>
            <Field label="EC" value={ec} onChange={setEc} placeholder="Electrical contractor" />
            <Field label="ETC" value={etc} onChange={setEtc} placeholder="ETC field service" />
            <Field label="GC" value={gc} onChange={setGc} placeholder="General contractor" />
          </View>
          <View style={w.row}>
            <View style={{ gap: 4 }}>
              <Text style={w.label}>Copy from</Text>
              <ChipPicker value={copyFrom} options={sources.map((p) => ({ id: p.id, label: p.name }))} onPick={setCopyFrom} none="Nothing (app library only)" />
            </View>
          </View>
          {copyFrom ? (
            <View style={styles.flags}>
              <Check label="Vocabulary" value={flags.vocabulary} onChange={(v) => setFlags({ ...flags, vocabulary: v })} />
              <Check label="Device-type library" value={flags.library} onChange={(v) => setFlags({ ...flags, library: v })} />
              <Check label="Standing rulings" value={flags.rulings} onChange={(v) => setFlags({ ...flags, rulings: v })} />
              <Check label="Placeholders" value={flags.placeholders} onChange={(v) => setFlags({ ...flags, placeholders: v })} />
            </View>
          ) : (
            <Text style={styles.hint}>The app library's accepted device types are copied in either way (D65).</Text>
          )}
          <Field label="Export title" value={exportTitle} onChange={setExportTitle} />
          <Field label="Disclaimer" value={disclaimer} onChange={setDisclaimer} placeholder="Based on submittal drawings rev F …" multiline />
        </Section>

        <Section title="Levels">
          <View style={styles.levelsHead}>
            <Text style={[styles.cN, w.label]}>#</Text>
            <Text style={[styles.cCode, w.label]}>Code</Text>
            <HeadCell style={styles.cScope} label="In scope" help={LEVEL_HELP.inScope} />
            <HeadCell style={styles.cPick} label="Shares numbering with" help={LEVEL_HELP.numbering} />
            <HeadCell style={styles.cPick} label="Split of" help={LEVEL_HELP.splitOf} />
            <Text style={[styles.cActions, w.label]}> </Text>
          </View>
          {levels.map((l, i) => (
            <View key={l.code} style={styles.levelRow}>
              <Text style={styles.cN}>{i + 1}</Text>
              <Text style={[styles.cCode, styles.code]}>{l.code}</Text>
              <View style={styles.cScope}>
                <ScopeSwitch value={l.inScope} onChange={(v) => update(i, { inScope: v })} />
              </View>
              <View style={styles.cPick}>
                <ChipPicker value={l.shareWith} options={codes.filter((c) => c.id !== l.code)} onPick={(v) => update(i, { shareWith: v })} none="own group" />
              </View>
              <View style={styles.cPick}>
                <ChipPicker value={l.splitOf} options={codes.filter((c) => c.id !== l.code)} onPick={(v) => update(i, { splitOf: v })} />
              </View>
              <View style={[styles.cActions, styles.actions]}>
                <Btn title="↑" small onPress={() => move(i, -1)} disabled={i === 0} />
                <Btn title="↓" small onPress={() => move(i, 1)} disabled={i === levels.length - 1} />
                <Btn title="✕" small onPress={() => remove(i)} />
              </View>
            </View>
          ))}
          <View style={w.row}>
            <View style={{ width: 160 }}>
              <Text style={w.label}>Add level</Text>
              <TextInput
                style={w.input}
                value={newCode}
                onChangeText={setNewCode}
                placeholder="06M"
                autoCapitalize="characters"
                autoCorrect={false}
                onFocus={toBottom}
                onSubmitEditing={addLevel}
                submitBehavior="submit"
                returnKeyType="next"
              />
            </View>
            <Btn title="+ Add level" onPress={addLevel} />
            <View style={{ width: 200 }}>
              <Text style={w.label}>Add range…</Text>
              <TextInput style={w.input} value={range} onChangeText={setRange} placeholder="09-28" autoCorrect={false} onFocus={toBottom} onSubmitEditing={addRange} />
            </View>
            <Btn title="Add range" onPress={addRange} />
          </View>
        </Section>

        <Notice text={error} error />
        <View style={[w.row, { justifyContent: 'flex-end' }]}>
          <Pressable onPress={() => router.back()} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Btn title={busy ? 'Creating…' : 'Create project'} primary onPress={() => void create()} disabled={busy} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#fff' },
  side: { width: 220, backgroundColor: '#f3f5f8', borderRightWidth: 1, borderRightColor: '#d5d9e0', padding: 12, gap: 6 },
  back: { fontSize: 15, color: '#1565c0', marginBottom: 8 },
  sideTitle: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  step: { fontSize: 15, paddingVertical: 6 },
  stepDim: { color: '#9aa0a8' },
  hint: { fontSize: 13, color: '#666' },
  main: { padding: 20, gap: 8 },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  levelsHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e6e8ec' },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  cN: { width: 28, fontSize: 14, color: '#555' },
  cCode: { width: 70 },
  code: { fontSize: 17, fontWeight: '600' },
  cScope: { width: 80 },
  cPick: { width: 190 },
  cActions: { flex: 1 },
  actions: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end' },
  cancel: { paddingHorizontal: 14, paddingVertical: 9 },
  cancelText: { color: '#555', fontSize: 15 },
});
