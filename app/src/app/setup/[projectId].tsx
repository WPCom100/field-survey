import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../../db';
import { SectionScreen } from '../../home/SectionScreen';
import { useCurrentUser } from '../../identity/IdentityGate';
import { SetupActions, SetupError, loadProjectSetup, mezzanineParent, type ProjectSetup, type SetupLevel } from '../../setup/model';
import { Btn, ChipPicker, Field, HeadCell, Notice, ScopeSwitch, Section, styles as w } from '../../setup/widgets';
import { SourcesStep } from '../../setup/SourcesStep';
import { AssignmentsStep } from '../../setup/AssignmentsStep';
import { RulesStep } from '../../setup/RulesStep';
import { BaselineDialog } from '../../setup/BaselineDialog';
import { DraftReview } from '../../drafts/DraftReview';
import { loadLockTable, lockWarnings, type LockLevel } from '../../setup/lock';
import { loadPlacementProgress, type PlacementProgress } from '../../placement/model';
import { useSyncStatus } from '../../sync/useSyncStatus';
import { projectDataKey } from '../../sync/dataKey';
import { useReload } from '../../sync/useReload';
import { useRulesVersion } from '../../rules/useRulesVersion';
import { color, font, radius, space, tabular } from '../../ui';

type Step = 'project' | 'levels' | 'sources' | 'drafts' | 'place' | 'lock' | 'assignments' | 'rules';
const STEPS: readonly string[] = ['project', 'levels', 'sources', 'drafts', 'place', 'lock', 'assignments', 'rules'];

/**
 * Setup of an existing project (Phase 3 §3.1 steps 1–2): the project's fields and the levels
 * table. Every change is an op (`SetupActions`), so this works offline. Sources is the seed
 * import (T28), floor plans (T45) and the BOM / riser extraction (T44); Review drafts is the
 * Phase 3 §3.3 review (T44, `?step=drafts&draft=<id>` opens one draft); Place devices is the
 * progress per level with Place ▸ into the level's plan in placing mode (T46, Phase 3 §3.4); Lock
 * baseline is the Phase 3 §3.5 table (T47, T46's columns), whose Lock / Unlock is also on each
 * Levels row. Assignments (T97, D168) assigns levels to team names, and Rules (T102, D176) sets the
 * rules' owners, wordings and statuses; both sit below the numbered steps because they change all
 * through the survey, not once.
 */
export default function ProjectSetupScreen() {
  const { projectId, step: stepParam, draft } = useLocalSearchParams<{ projectId: string; step?: string; draft?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  // this project's pulls and rules runs only (T185, T186)
  const dataKey = projectDataKey(sync, projectId);
  const rulesKey = useRulesVersion(projectId);
  const [step, setStep] = useState<Step>(stepParam && STEPS.includes(stepParam) ? (stepParam as Step) : 'levels');
  useEffect(() => {
    if (stepParam && STEPS.includes(stepParam)) setStep(stepParam as Step);
  }, [stepParam, draft]);
  const [setup, setSetup] = useState<ProjectSetup | null>(null);
  const [actions, setActions] = useState<SetupActions | null>(null);
  const [locks, setLocks] = useState<Map<string, LockLevel>>(new Map());
  const [placement, setPlacement] = useState<PlacementProgress | null>(null);
  const [dialog, setDialog] = useState<LockLevel | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  /** Keep the Add level field in view above the keyboard (P-3); after the keyboard has animated in. */
  const toBottom = useCallback(() => setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 300), []);

  // T186: a pull or a rules run during a load no longer throws it away (useReload)
  useReload({
    name: 'setup',
    subject: `${projectId}|${user.id}`,
    reloadKey: `${reload}|${dataKey}|${rulesKey}`,
    load: async () => {
      const store = await openAppStore();
      const s = await loadProjectSetup(store, projectId);
      const table = await loadLockTable(store, projectId);
      const progress = await loadPlacementProgress(store, projectId);
      return { store, s, table, progress };
    },
    apply: ({ store, s, table, progress }) => {
      setSetup(s);
      setPlacement(progress);
      setLocks(new Map(table.map((l) => [l.id, l])));
      setActions((a) => a ?? new SetupActions(store, projectId, user.id));
    },
    fail: (e) => console.warn('[setup] load', e),
  });

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

  // Setup is a section (D280): no back from the sidebar or the rail, else `‹ Projects` (or the screen
  // it was opened from); the rail's Levels replaced "Open the levels screen ▸" (T190)
  if (!setup) {
    return (
      <SectionScreen section="Setup" projectId={projectId} title="Setup" backTestID="setup.back">
        <Text style={styles.empty}>{setup === null ? 'Loading…' : 'Unknown project'}</Text>
      </SectionScreen>
    );
  }

  return (
    <SectionScreen section="Setup" projectId={projectId} title="Setup" caption={setup.project.name} backTestID="setup.back">
      <View style={styles.root}>
        <View style={styles.side}>
          <StepItem id="project" label="1 Project" step={step} onPick={setStep} />
          <StepItem id="levels" label="2 Levels" step={step} onPick={setStep} />
          <StepItem id="sources" label="3 Sources" step={step} onPick={setStep} />
          <StepItem id="drafts" label="4 Review drafts" step={step} onPick={setStep} />
          <StepItem id="place" label="5 Place devices" step={step} onPick={setStep} />
          <StepItem id="lock" label="6 Lock baseline" step={step} onPick={setStep} />
          <View style={styles.sideRule} />
          <StepItem id="assignments" label="Assignments" step={step} onPick={setStep} />
          <StepItem id="rules" label="Rules" step={step} onPick={setStep} />
        </View>

        {step === 'drafts' ? (
          <View style={{ flex: 1 }}>
            <DraftReview projectId={projectId} focus={draft ?? null} />
          </View>
        ) : (
          <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={styles.main} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <Notice text={error} error />
            <Notice text={notice} />
            {step === 'project' ? (
              <ProjectStep setup={setup} run={run} />
            ) : step === 'sources' ? (
              <SourcesStep projectId={projectId} />
            ) : step === 'place' ? (
              <PlaceStep progress={placement} />
            ) : step === 'assignments' ? (
              <AssignmentsStep projectId={projectId} dataKey={dataKey} />
            ) : step === 'rules' ? (
              <RulesStep projectId={projectId} dataKey={dataKey} />
            ) : step === 'lock' ? (
              <LockStep levels={setup.levels.map((l) => locks.get(l.id)).filter((l): l is LockLevel => !!l)} onLock={setDialog} />
            ) : (
              <LevelsStep setup={setup} locks={locks} run={run} toBottom={toBottom} onLock={setDialog} />
            )}
          </ScrollView>
        )}
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
    </SectionScreen>
  );
}

type Run = (fn: (a: SetupActions) => Promise<unknown>, done?: string) => () => Promise<void>;

/** One step in the side list: the sidebar's look (active = the accent tint, the label in the accent). */
function StepItem({ id, label, step, onPick }: { id: Step; label: string; step: Step; onPick: (s: Step) => void }) {
  const on = step === id;
  return (
    <Pressable
      onPress={() => onPick(id)}
      testID={`setup.step.${id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [styles.step, on && styles.stepOn, pressed && !on && styles.stepPressed]}
    >
      <Text style={[styles.stepText, on && styles.stepTextOn]}>{label}</Text>
    </Pressable>
  );
}

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
    </Section>
  );
}

/**
 * Phase 3 §3.4 progress (T46): per in-scope level the devices on the plan, those not on it, the
 * draft units still to place and the flagged drafts; Place ▸ opens the level's plan with the
 * Place devices panel. The pool's units are placed from any level's plan.
 */
function PlaceStep({ progress }: { progress: PlacementProgress | null }) {
  if (!progress) return <Text style={styles.empty}>Loading…</Text>;
  const levels = progress.levels.filter((l) => l.inScope);
  return (
    <Section title="Place devices">
      <View style={styles.head}>
        <Text style={[styles.cCode, w.label]}>Level</Text>
        <Text style={[styles.cLockNum, w.label]}>Placed</Text>
        <Text style={[styles.cLockNum, w.label]}>Not on plan</Text>
        <Text style={[styles.cLockNum, w.label]}>From drafts</Text>
        <Text style={[styles.cLockNum, w.label]}>Flagged</Text>
        <Text style={[styles.cActions, w.label]}> </Text>
      </View>
      {levels.map((l) => {
        const done = l.unplacedDevices === 0 && l.draftUnits === 0;
        return (
          <View key={l.levelId} style={styles.row}>
            <Text style={[styles.cCode, styles.code]}>{l.code}</Text>
            <Text style={styles.cLockNum}>
              {l.placed}/{l.devices}
              {done && l.devices > 0 ? ' ✓' : ''}
            </Text>
            <Text style={styles.cLockNum}>{l.unplacedDevices}</Text>
            <Text style={styles.cLockNum}>{l.draftUnits}</Text>
            <Text style={styles.cLockNum}>{l.flagged}</Text>
            <View style={[styles.cActions, styles.actions]}>
              <Btn
                title={done ? 'Open plan ▸' : 'Place ▸'}
                small
                primary={!done}
                onPress={() => router.push({ pathname: '/plan/[levelId]', params: { levelId: l.levelId, place: '1' } })}
                testID={`setup.place.${l.code}`}
              />
            </View>
          </View>
        );
      })}
      {levels.length === 0 ? <Text style={styles.empty}>No levels in scope yet.</Text> : null}
      {progress.pool.draftUnits + progress.pool.flagged > 0 ? (
        <Text style={styles.hint}>
          Pool (drafts with no level): {progress.pool.draftUnits} unit{progress.pool.draftUnits === 1 ? '' : 's'} to place
          {progress.pool.flagged ? `, ${progress.pool.flagged} flagged` : ''}.
        </Text>
      ) : null}
    </Section>
  );
}

/** Phase 3 §3.5: per level what a lock would leave open, and Lock / Unlock; Drafts, Flagged and Cables ⚑ from T46. */
function LockStep({ levels, onLock }: { levels: LockLevel[]; onLock: (l: LockLevel) => void }) {
  return (
    <Section title="Lock baseline">
      <View style={styles.head}>
        <Text style={[styles.cCode, w.label]}>Level</Text>
        <Text style={[styles.cLockNum, w.label]}>Placed</Text>
        <Text style={[styles.cLockNum, w.label]}>Drafts</Text>
        <Text style={[styles.cLockNum, w.label]}>Flagged</Text>
        <Text style={[styles.cLockNum, w.label]}>Cables ⚑</Text>
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
                {l.devices > 0 && l.placed === l.devices && l.toPlace === 0 ? ' ✓' : ''}
                {l.toPlace ? ` +${l.toPlace}` : ''}
              </Text>
              <Text style={styles.cLockNum}>{l.drafts}</Text>
              <Text style={styles.cLockNum}>{l.flagged}</Text>
              <Text style={styles.cLockNum}>{l.cablesUnconfirmed}</Text>
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
  /** True once the user picked either Add level picker: typing no longer resets them. */
  const [picked, setPicked] = useState(false);
  const options = setup.levels.map((l) => ({ id: l.id, label: l.code }));
  /** A typed `<code>M` defaults both pickers to `<code>` until the user picks (T172, D263). */
  const typeCode = (text: string) => {
    setNewCode(text);
    if (picked) return;
    const parent = mezzanineParent(text, setup.levels);
    setNewShare(parent?.id ?? null);
    setNewSplit(parent?.id ?? null);
  };
  const pickShare = (id: string | null) => {
    setPicked(true);
    setNewShare(id);
  };
  const pickSplit = (id: string | null) => {
    setPicked(true);
    setNewSplit(id);
  };
  /** Enter adds the level and keeps the keyboard up for the next one (P-3). */
  const addLevel = () => {
    if (!newCode.trim()) return;
    void run(
      async (a) => {
        await a.addLevel({ code: newCode, shareWithLevelId: newShare, splitOfLevelId: newSplit });
        setNewCode('');
        setNewShare(null);
        setNewSplit(null);
        setPicked(false);
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
        <HeadCell style={styles.cScope} label="In scope" />
        <HeadCell style={styles.cGroup} label="Numbering group" />
        <HeadCell style={styles.cPick} label="Split of" />
        <Text style={[styles.cDate, w.label]}>Surveyed</Text>
        <Text style={[styles.cDate, w.label]}>Updated</Text>
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
            placeholderTextColor={color.text3}
            value={newCode}
            onChangeText={typeCode}
            placeholder="06M"
            autoCapitalize="characters"
            autoCorrect={false}
            onFocus={toBottom}
            onSubmitEditing={addLevel}
            submitBehavior="submit"
            returnKeyType="next"
            testID="setup.levelCode"
          />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={w.label}>Shares numbering with</Text>
          <ChipPicker value={newShare} options={options} onPick={pickShare} none="own group" testID="setup.newShare" />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={w.label}>Split of</Text>
          <ChipPicker value={newSplit} options={options} onPick={pickSplit} testID="setup.newSplit" />
        </View>
        <Btn title="+ Add level" onPress={addLevel} />
      </View>
      <View style={w.row}>
        <View style={{ width: 200 }}>
          <Text style={w.label}>Add range…</Text>
          <TextInput style={w.input} placeholderTextColor={color.text3} value={range} onChangeText={setRange} placeholder="09-28" autoCorrect={false} onFocus={toBottom} />
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

/** One `YYYY-MM-DD` input, saved on blur; an invalid date is refused and the saved value comes back. */
function DateCell({ value, onSave, testID }: { value: string | null; onSave: (text: string) => () => Promise<void>; testID?: string }) {
  const [text, setText] = useState(value ?? '');
  const [bad, setBad] = useState(false);
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    if (text.trim() === (value ?? '')) return;
    void onSave(text)();
  };
  return (
    <TextInput
      style={[w.input, styles.cDate, bad && styles.bad]}
      value={text}
      onChangeText={(t) => {
        setText(t);
        setBad(t.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(t.trim()));
      }}
      onBlur={commit}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={color.text3}
      autoCorrect={false}
      autoCapitalize="none"
      keyboardType="numbers-and-punctuation"
      testID={testID}
    />
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
      <DateCell value={l.surveyed} onSave={(t) => run((a) => a.setLevelDate(l.id, 'surveyed', t))} testID={`setup.level.${l.code}.surveyed`} />
      <DateCell value={l.updated} onSave={(t) => run((a) => a.setLevelDate(l.id, 'updated', t))} testID={`setup.level.${l.code}.updated`} />
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
  root: { flex: 1, flexDirection: 'row', backgroundColor: color.bg },
  // 168 (was 220): beside the 72-pt rail the step's tables keep their room in portrait (T190)
  side: { width: 168, backgroundColor: color.surface2, borderRightWidth: 1, borderRightColor: color.hairline, padding: space.sm, gap: 2 },
  step: { minHeight: 44, justifyContent: 'center', paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.control },
  stepOn: { backgroundColor: color.primaryTint },
  stepPressed: { backgroundColor: color.border },
  stepText: { ...font.callout, color: color.text },
  stepTextOn: { color: color.primary, fontWeight: '600' },
  sideRule: { height: 1, backgroundColor: color.hairline, marginVertical: 6 },
  hint: { ...font.caption, color: color.text3 },
  main: { paddingHorizontal: space.xl, paddingVertical: space.lg, gap: space.sm },
  empty: { ...font.callout, color: color.text3, padding: 20 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingVertical: 6, paddingHorizontal: space.sm, marginHorizontal: -space.sm, backgroundColor: color.surface2, borderRadius: radius.control },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.hairline },
  rowDim: { opacity: 0.6 },
  cN: { width: 28, ...font.callout, ...tabular, color: color.text3 },
  cCode: { width: 80 },
  code: { ...font.headline, color: color.text },
  small: { ...font.caption, color: color.text3 },
  cScope: { width: 110 },
  cGroup: { width: 230, gap: space.xs },
  groupText: { ...font.callout, color: color.text },
  groupBtns: { flexDirection: 'row', gap: 6 },
  cPick: { width: 130 },
  cDate: { width: 112 },
  bad: { borderColor: color.danger, borderWidth: 2 },
  cSheet: { width: 140, ...font.caption, color: color.text2 },
  cActions: { flex: 1 },
  cLockNum: { width: 82, ...font.callout, ...tabular, color: color.text },
  cLockState: { width: 170, ...font.callout, ...tabular, color: color.text },
  cFar: { flex: 1, ...font.callout, color: color.text3 },
  actions: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end' },
});
