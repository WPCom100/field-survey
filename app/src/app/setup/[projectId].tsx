import { Link, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../../db';
import { useCurrentUser } from '../../identity/IdentityGate';
import { SetupActions, SetupError, loadProjectSetup, type ProjectSetup, type SetupLevel } from '../../setup/model';
import { Btn, ChipPicker, Field, HeadCell, LEVEL_HELP, Notice, ScopeSwitch, Section, styles as w } from '../../setup/widgets';
import { SourcesStep } from '../../setup/SourcesStep';
import { BaselineDialog } from '../../setup/BaselineDialog';
import { loadLockTable, lockWarnings, type LockLevel } from '../../setup/lock';
import { useSyncStatus } from '../../sync/useSyncStatus';
import { syncDataKey } from '../../sync/dataKey';

type Step = 'project' | 'levels' | 'sources' | 'lock';

/**
 * Setup of an existing project (Phase 3 §3.1 steps 1–2): the project's fields and the levels
 * table. Every change is an op (`SetupActions`), so this works offline; the later steps
 * (Review drafts, Place devices) light up with T44 and T46; Sources is the seed import (T28);
 * Lock baseline is the Phase 3 §3.5 table (T47), whose Lock / Unlock is also on each Levels row.
 */
export default function ProjectSetupScreen() {
  const { projectId, step: stepParam } = useLocalSearchParams<{ projectId: string; step?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const [step, setStep] = useState<Step>(stepParam === 'project' || stepParam === 'sources' || stepParam === 'lock' ? stepParam : 'levels');
  const [setup, setSetup] = useState<ProjectSetup | null>(null);
  const [actions, setActions] = useState<SetupActions | null>(null);
  const [locks, setLocks] = useState<Map<string, LockLevel>>(new Map());
  const [dialog, setDialog] = useState<LockLevel | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  /** Keep the Add level field in view above the keyboard (P-3); after the keyboard has animated in. */
  const toBottom = useCallback(() => setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 300), []);

  useEffect(() => {
    let live = true;
    (async () => {
      const store = await openAppStore();
      const s = await loadProjectSetup(store, projectId);
      const table = await loadLockTable(store, projectId);
      if (!live) return;
      setSetup(s);
      setLocks(new Map(table.map((l) => [l.id, l])));
      setActions((a) => a ?? new SetupActions(store, projectId, user.id));
    })().catch((e: unknown) => console.warn('[setup] load', e));
    return () => {
      live = false;
    };
  }, [projectId, user.id, reload, dataKey]);

  /** Run an action; errors show inline, success reloads the table. */
  const run = useCallback(
    (fn: (a: SetupActions) => Promise<unknown>, done?: string) => async () => {
      if (!actions) return;
      setError(null);
      setNotice(null);
      try {
        await fn(actions);
        if (done) setNotice(done);
        setReload((n) => n + 1);
      } catch (e) {
        setError(e instanceof SetupError ? e.message : `Could not save: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [actions],
  );

  if (!setup) {
    return (
      <View style={styles.root}>
        <Text style={styles.empty}>{setup === null ? 'Loading…' : 'Unknown project'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.side}>
        <Link href="/projects" style={styles.back}>
          ◀ Projects
        </Link>
        <Text style={styles.sideTitle} numberOfLines={2}>
          {setup.project.name}
        </Text>
        <Pressable onPress={() => setStep('project')} style={[styles.step, step === 'project' && styles.stepOn]}>
          <Text style={styles.stepText}>1 Project</Text>
        </Pressable>
        <Pressable onPress={() => setStep('levels')} style={[styles.step, step === 'levels' && styles.stepOn]}>
          <Text style={styles.stepText}>2 Levels</Text>
        </Pressable>
        <Pressable onPress={() => setStep('sources')} style={[styles.step, step === 'sources' && styles.stepOn]}>
          <Text style={styles.stepText}>3 Sources</Text>
        </Pressable>
        {['4 Review drafts', '5 Place devices'].map((s) => (
          <View key={s} style={styles.step}>
            <Text style={[styles.stepText, styles.stepDim]}>{s}</Text>
          </View>
        ))}
        <Pressable onPress={() => setStep('lock')} style={[styles.step, step === 'lock' && styles.stepOn]}>
          <Text style={styles.stepText}>6 Lock baseline</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.push({ pathname: '/', params: { project: projectId } })}>
          <Text style={styles.back}>Open the levels screen ▸</Text>
        </Pressable>
      </View>

      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={styles.main} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Notice text={error} error />
        <Notice text={notice} />
        {step === 'project' ? (
          <ProjectStep setup={setup} run={run} />
        ) : step === 'sources' ? (
          <SourcesStep projectId={projectId} />
        ) : step === 'lock' ? (
          <LockStep levels={setup.levels.map((l) => locks.get(l.id)).filter((l): l is LockLevel => !!l)} onLock={setDialog} />
        ) : (
          <LevelsStep setup={setup} locks={locks} run={run} toBottom={toBottom} onLock={setDialog} />
        )}
      </ScrollView>
      <BaselineDialog
        projectId={projectId}
        userId={user.id}
        level={dialog}
        onClose={(done) => {
          setDialog(null);
          if (done) {
            setError(null);
            setNotice(done);
            setReload((n) => n + 1);
          }
        }}
      />
    </View>
  );
}

type Run = (fn: (a: SetupActions) => Promise<unknown>, done?: string) => () => Promise<void>;

function ProjectStep({ setup, run }: { setup: ProjectSetup; run: Run }) {
  const p = setup.project;
  const [name, setName] = useState(p.name);
  const [site, setSite] = useState(p.site);
  const [ec, setEc] = useState(p.parties.ec);
  const [etc, setEtc] = useState(p.parties.etc);
  const [gc, setGc] = useState(p.parties.gc);
  const [title, setTitle] = useState(p.settings.export_title);
  const [disclaimer, setDisclaimer] = useState(p.settings.disclaimer);
  return (
    <Section title="Project">
      <Field label="Name" value={name} onChange={setName} onCommit={run((a) => a.setProject({ name }), 'Saved')} />
      <Field label="Site" value={site} onChange={setSite} onCommit={run((a) => a.setProject({ site }), 'Saved')} />
      <View style={w.row}>
        <Field label="EC" value={ec} onChange={setEc} onCommit={run((a) => a.setProject({ parties: { ec, etc, gc } }), 'Saved')} />
        <Field label="ETC" value={etc} onChange={setEtc} onCommit={run((a) => a.setProject({ parties: { ec, etc, gc } }), 'Saved')} />
        <Field label="GC" value={gc} onChange={setGc} onCommit={run((a) => a.setProject({ parties: { ec, etc, gc } }), 'Saved')} />
      </View>
      <Field label="Export title" value={title} onChange={setTitle} onCommit={run((a) => a.setProject({ settings: { export_title: title, disclaimer } }), 'Saved')} />
      <Field
        label="Disclaimer"
        value={disclaimer}
        onChange={setDisclaimer}
        onCommit={run((a) => a.setProject({ settings: { export_title: title, disclaimer } }), 'Saved')}
        multiline
      />
      {p.copiedFromId ? <Text style={styles.hint}>Vocabulary, library and rulings were copied from another project at creation.</Text> : null}
    </Section>
  );
}

/** Phase 3 §3.5: per level what a lock would leave open, and Lock / Unlock. Drafts and flags come with T44/T46. */
function LockStep({ levels, onLock }: { levels: LockLevel[]; onLock: (l: LockLevel) => void }) {
  return (
    <Section title="Lock baseline">
      <Text style={styles.hint}>
        Locking a level starts change logging: every later edit shows who, when, was → now and why in History. Lock is allowed with
        warnings; Unlock asks why.
      </Text>
      <View style={styles.head}>
        <Text style={[styles.cCode, w.label]}>Level</Text>
        <Text style={[styles.cLockNum, w.label]}>Placed</Text>
        <Text style={[styles.cLockNum, w.label]}>In review</Text>
        <Text style={[styles.cLockState, w.label]}>State</Text>
        <Text style={[styles.cActions, w.label]}> </Text>
      </View>
      {levels.map((l) => (
        <View key={l.id} style={[styles.row, !l.inScope && styles.rowDim]}>
          <Text style={[styles.cCode, styles.code]}>{l.code}</Text>
          {l.inScope ? (
            <>
              <Text style={styles.cLockNum}>
                {l.placed}/{l.devices}
                {l.devices > 0 && l.placed === l.devices ? ' ✓' : ''}
              </Text>
              <Text style={styles.cLockNum}>{l.inReview}</Text>
              <Text style={styles.cLockState}>{l.locked ? `🔒 Locked${l.lockedAt ? ` ${l.lockedAt.slice(0, 10)}` : ''}` : 'Setup'}</Text>
              <View style={[styles.cActions, styles.actions]}>
                <LockButton level={l} onLock={onLock} />
              </View>
            </>
          ) : (
            <Text style={styles.cFar}>out of scope — far-end only</Text>
          )}
        </View>
      ))}
      {levels.length === 0 ? <Text style={styles.empty}>No levels yet.</Text> : null}
    </Section>
  );
}

function LockButton({ level: l, onLock }: { level: LockLevel; onLock: (l: LockLevel) => void }) {
  if (!l.inScope) return null;
  if (l.locked) return <Btn title="Unlock…" small onPress={() => onLock(l)} />;
  return <Btn title={lockWarnings(l).length ? `Lock ${l.code} ⚠` : `Lock ${l.code}`} small primary onPress={() => onLock(l)} />;
}

function LevelsStep({
  setup,
  locks,
  run,
  toBottom,
  onLock,
}: {
  setup: ProjectSetup;
  locks: ReadonlyMap<string, LockLevel>;
  run: Run;
  toBottom: () => void;
  onLock: (l: LockLevel) => void;
}) {
  const [newCode, setNewCode] = useState('');
  const [newShare, setNewShare] = useState<string | null>(null);
  const [newSplit, setNewSplit] = useState<string | null>(null);
  const [range, setRange] = useState('');
  const options = setup.levels.map((l) => ({ id: l.id, label: l.code }));
  /** Enter adds the level and keeps the keyboard up for the next one (P-3). */
  const addLevel = () => {
    if (!newCode.trim()) return;
    void run(
      async (a) => {
        await a.addLevel({ code: newCode, shareWithLevelId: newShare, splitOfLevelId: newSplit });
        setNewCode('');
        setNewShare(null);
        setNewSplit(null);
        toBottom();
      },
      `Added level ${newCode.trim().toUpperCase()}`,
    )();
  };
  return (
    <Section title="Levels">
      <View style={styles.head}>
        <Text style={[styles.cN, w.label]}>#</Text>
        <Text style={[styles.cCode, w.label]}>Code</Text>
        <HeadCell style={styles.cScope} label="In scope" help={LEVEL_HELP.inScope} />
        <HeadCell style={styles.cGroup} label="Numbering group" help={`${LEVEL_HELP.numbering} Fixed once a level has records.`} />
        <HeadCell style={styles.cPick} label="Split of" help={LEVEL_HELP.splitOf} />
        <Text style={[styles.cSheet, w.label]}>Display sheet</Text>
        <Text style={[styles.cActions, w.label]}> </Text>
      </View>
      {setup.levels.map((l, i) => (
        <LevelRow key={l.id} level={l} lock={locks.get(l.id) ?? null} index={i} count={setup.levels.length} options={options} run={run} onLock={onLock} />
      ))}
      {setup.levels.length === 0 ? <Text style={styles.empty}>No levels yet.</Text> : null}

      <View style={[w.row, { marginTop: 12, flexWrap: 'wrap' }]}>
        <View style={{ width: 120 }}>
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
        <View style={{ gap: 4 }}>
          <Text style={w.label}>Shares numbering with</Text>
          <ChipPicker value={newShare} options={options} onPick={setNewShare} none="own group" />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={w.label}>Split of</Text>
          <ChipPicker value={newSplit} options={options} onPick={setNewSplit} />
        </View>
        <Btn title="+ Add level" onPress={addLevel} />
      </View>
      <View style={w.row}>
        <View style={{ width: 200 }}>
          <Text style={w.label}>Add range…</Text>
          <TextInput style={w.input} value={range} onChangeText={setRange} placeholder="09-28" autoCorrect={false} onFocus={toBottom} />
        </View>
        <Btn
          title="Add range (out of scope)"
          onPress={() =>
            void run(async (a) => {
              const ids = await a.addRange(range);
              setRange('');
              return ids;
            }, 'Range added')()
          }
        />
      </View>
    </Section>
  );
}

function LevelRow({
  level: l,
  lock,
  index,
  count,
  options,
  run,
  onLock,
}: {
  level: SetupLevel;
  lock: LockLevel | null;
  onLock: (l: LockLevel) => void;
  index: number;
  count: number;
  options: { id: string; label: string }[];
  run: Run;
}) {
  const [sharing, setSharing] = useState(false);
  const others = options.filter((o) => o.id !== l.id);
  const fixed = l.records > 0;
  return (
    <View style={[styles.row, !l.inScope && styles.rowDim]}>
      <Text style={styles.cN}>{l.floorOrder}</Text>
      <View style={styles.cCode}>
        <Text style={styles.code}>{l.code}</Text>
        {l.state === 'baseline_locked' ? <Text style={styles.small}>🔒 locked</Text> : null}
        {l.records ? <Text style={styles.small}>{l.records} records</Text> : null}
      </View>
      <View style={styles.cScope}>
        <ScopeSwitch value={l.inScope} onChange={(v) => void run((a) => a.setInScope(l.id, v))()} />
      </View>
      <View style={styles.cGroup}>
        <Text style={styles.groupText}>
          {l.groupLabel}
          {l.shared ? '  ◀ shared' : ''}
        </Text>
        {sharing ? (
          <ChipPicker
            value={null}
            options={others}
            none="cancel"
            onPick={(id) => {
              setSharing(false);
              if (id) void run((a) => a.shareNumbering(l.id, id), `${l.code} now shares numbering`)();
            }}
          />
        ) : (
          <View style={styles.groupBtns}>
            <Btn title="Share with…" small disabled={fixed || others.length === 0} onPress={() => setSharing(true)} />
            {l.shared ? <Btn title="Separate" small disabled={fixed} onPress={() => void run((a) => a.separateNumbering(l.id), `${l.code} numbers alone`)()} /> : null}
          </View>
        )}
      </View>
      <View style={styles.cPick}>
        <ChipPicker value={l.splitOfId} options={others} onPick={(id) => void run((a) => a.setSplitOf(l.id, id))()} />
      </View>
      <Text style={styles.cSheet}>{l.sheet ?? '(none yet)'}</Text>
      <View style={[styles.cActions, styles.actions]}>
        {lock ? <LockButton level={lock} onLock={onLock} /> : null}
        <Btn title="↑" small disabled={index === 0} onPress={() => void run((a) => a.move(l.id, -1))()} />
        <Btn title="↓" small disabled={index === count - 1} onPress={() => void run((a) => a.move(l.id, 1))()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#fff' },
  side: { width: 220, backgroundColor: '#f3f5f8', borderRightWidth: 1, borderRightColor: '#d5d9e0', padding: 12, gap: 4 },
  back: { fontSize: 15, color: '#1565c0', marginBottom: 8 },
  sideTitle: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  step: { paddingVertical: 9, paddingHorizontal: 10, borderRadius: 6 },
  stepOn: { backgroundColor: '#dce8fb' },
  stepText: { fontSize: 15 },
  stepDim: { color: '#9aa0a8' },
  hint: { fontSize: 13, color: '#666' },
  main: { padding: 20, gap: 8 },
  empty: { fontSize: 15, color: '#666', padding: 20 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e6e8ec' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  rowDim: { opacity: 0.6 },
  cN: { width: 28, fontSize: 14, color: '#555' },
  cCode: { width: 80 },
  code: { fontSize: 17, fontWeight: '600' },
  small: { fontSize: 11, color: '#777' },
  cScope: { width: 110 },
  cGroup: { width: 230, gap: 4 },
  groupText: { fontSize: 14 },
  groupBtns: { flexDirection: 'row', gap: 6 },
  cPick: { width: 130 },
  cSheet: { width: 140, fontSize: 13, color: '#555' },
  cActions: { flex: 1 },
  cLockNum: { width: 90, fontSize: 15 },
  cLockState: { width: 170, fontSize: 14 },
  cFar: { flex: 1, fontSize: 14, color: '#777' },
  actions: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end' },
});
