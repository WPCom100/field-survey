import { OpError, vocab, type Editor, type Store } from '@field-survey/core';
import {
  NO_STATUS,
  codeValue,
  decideRuleParam,
  describeValue,
  loadRuleParamRows,
  paramGroups,
  setRuleParam,
  withCode,
  type ParamGroup,
  type ParamItem,
  type ParamValue,
} from '@field-survey/rules';
import { Link } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Btn, ChipPicker, Notice, styles as w } from '../setup/widgets';

/**
 * The rules' owners, wordings and statuses (T102, D176 (4)): grouped by rule with the rule's
 * text, each value with "what this changes", its default and a Reset. `scope` is the project
 * (Setup → Rules: a change applies at once and the open drafts follow on the next rules run) or
 * null for the app-level defaults (Projects → Rule defaults: each change is a draft until
 * accepted; new projects copy the accepted ones). Every change is one op through `editor`.
 */
export function RuleParamsEditor({ store, editor, scope, dataKey }: { store: Store; editor: Editor; scope: string | null; dataKey: unknown }) {
  const app = scope == null;
  const [groups, setGroups] = useState<ParamGroup[] | null>(null);
  const [tick, setTick] = useState(0);
  const [onlySet, setOnlySet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadRuleParamRows(store, scope).then(
      (rows) => live && setGroups(paramGroups(rows, { app })),
      (e: unknown) => live && setError(`Could not read the rule settings: ${String(e)}`),
    );
    return () => {
      live = false;
    };
  }, [store, scope, app, tick, dataKey]);

  const run = useCallback(async (fn: () => Promise<number>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      const n = await fn();
      if (n) setNotice(done);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof OpError ? e.message : `Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const set = useCallback(
    (item: ParamItem, value: ParamValue | null) =>
      void run(
        () => setRuleParam(editor, item.spec.rule, item.spec.key, value),
        app
          ? `${item.spec.rule} · ${item.spec.label}: saved as a draft default. Accept it to have new projects copy it.`
          : `${item.spec.rule} · ${item.spec.label}: saved. Open drafts follow on the next rules run; accepted items keep their text.`,
      ),
    [run, editor, app],
  );
  const decide = useCallback(
    (item: ParamItem, state: 'accepted' | 'rejected') =>
      void run(() => decideRuleParam(editor, item.spec.rule, item.spec.key, state), `${item.spec.rule} · ${item.spec.label}: ${state}.`),
    [run, editor],
  );

  const shown = useMemo(
    () => (groups ?? []).map((g) => ({ ...g, items: onlySet ? g.items.filter((i) => i.set || (app && i.state === 'draft')) : g.items })).filter((g) => g.items.length),
    [groups, onlySet, app],
  );
  const changed = (groups ?? []).reduce((n, g) => n + g.items.filter((i) => i.set).length, 0);

  if (!groups) return <Text style={styles.hint}>Loading…</Text>;
  return (
    <View style={styles.root}>
      <Text style={styles.hint}>
        {app
          ? 'The defaults every new project starts with (copied at creation; an existing project keeps its own). A change is a draft until accepted.'
          : 'What the rules write on this project: owners, item wording, starting statuses. A change applies at once: open drafts follow on the next rules run and rejected ones are offered again; accepted items keep their text.'}
        {' '}
        {changed ? `${changed} set away from the built-in defaults.` : 'All on the built-in defaults.'}
      </Text>
      {!app ? (
        <Link href={{ pathname: '/rulings', params: { project: scope } }} style={styles.link}>
          Change accepted items with a ruling ▸
        </Link>
      ) : null}
      <View style={w.row}>
        <Pressable onPress={() => setOnlySet((v) => !v)} style={styles.toggle} accessibilityRole="switch" accessibilityState={{ checked: onlySet }}>
          <View pointerEvents="none">
            <Switch value={onlySet} />
          </View>
          <Text style={styles.toggleText}>Only what is changed{app ? ' or waiting' : ''}</Text>
        </Pressable>
      </View>
      <Notice text={error} error />
      <Notice text={notice} />
      {shown.length === 0 ? <Text style={styles.hint}>Nothing changed yet.</Text> : null}
      {shown.map((g) => (
        <View key={g.rule} style={styles.group}>
          <Text style={styles.groupTitle}>
            {g.rule.startsWith('E') || g.rule === 'not_found' || g.rule === 'R3' || g.rule === 'R5' ? g.title : `${g.rule} · ${g.title}`}
          </Text>
          {g.text ? <Text style={styles.ruleText}>{g.text}</Text> : null}
          {g.items.map((item) => (
            <ParamRow key={item.spec.key} item={item} app={app} onSet={set} onDecide={decide} />
          ))}
        </View>
      ))}
    </View>
  );
}

function ParamRow({
  item,
  app,
  onSet,
  onDecide,
}: {
  item: ParamItem;
  app: boolean;
  onSet: (item: ParamItem, value: ParamValue | null) => void;
  onDecide: (item: ParamItem, state: 'accepted' | 'rejected') => void;
}) {
  const { spec } = item;
  return (
    <View style={[styles.param, item.set && styles.paramSet]}>
      <View style={styles.paramHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.label}>
            {spec.label}
            {item.set ? <Text style={styles.badge}>  changed</Text> : null}
            {app && item.state ? <Text style={item.state === 'draft' ? styles.badgeDraft : styles.badge}>  {item.state}</Text> : null}
          </Text>
          <Text style={styles.changes}>{spec.changes}</Text>
          {spec.placeholders?.length ? <Text style={styles.small}>Fills in: {spec.placeholders.join(' · ')}</Text> : null}
        </View>
        {app && item.state === 'draft' ? (
          <View style={styles.actions}>
            <Btn title="Accept" small primary onPress={() => onDecide(item, 'accepted')} />
            <Btn title="Reject" small onPress={() => onDecide(item, 'rejected')} />
          </View>
        ) : null}
        {item.set ? <Btn title="Reset to default" small onPress={() => onSet(item, null)} /> : null}
      </View>
      <ParamControl item={item} onSet={onSet} />
      {item.set ? <Text style={styles.small}>Default: {describeValue(spec, spec.default)}</Text> : null}
    </View>
  );
}

const OWNERS = vocab.OWNER as readonly string[];
const STATUSES = vocab.CONNECTION_STATUS as readonly string[];

function ParamControl({ item, onSet }: { item: ParamItem; onSet: (item: ParamItem, value: ParamValue | null) => void }) {
  const { spec, value } = item;
  switch (spec.kind) {
    case 'owner':
      return <Chips options={OWNERS} value={value as string} onPick={(v) => onSet(item, v)} />;
    case 'side':
      return (
        <Chips
          options={['A', 'B']}
          labels={{ A: 'Start of the run (side A)', B: 'End of the run (side B)' }}
          value={value as string}
          onPick={(v) => onSet(item, v)}
        />
      );
    case 'bool':
      return (
        <Pressable onPress={() => onSet(item, !value)} style={styles.toggle} accessibilityRole="switch" accessibilityState={{ checked: value === true }}>
          <View pointerEvents="none">
            <Switch value={value === true} />
          </View>
          <Text style={styles.toggleText}>{value ? 'On' : 'Off'}</Text>
        </Pressable>
      );
    case 'status':
      return (
        <ChipPicker
          value={(value as string) || null}
          options={STATUSES.map((s) => ({ id: s, label: s }))}
          none="No status (Unsurveyed)"
          onPick={(v) => onSet(item, v ?? NO_STATUS)}
        />
      );
    case 'text':
      return <TextBox value={value as string} onCommit={(v) => onSet(item, v)} />;
    case 'owner_by_code':
    case 'text_by_code':
    case 'bool_by_code':
      return <CodeTable item={item} onSet={onSet} />;
  }
}

/** One row per cable code; `*` reads "Any other code". A row without its own entry shows `*`'s value, dimmed. */
function CodeTable({ item, onSet }: { item: ParamItem; onSet: (item: ParamItem, value: ParamValue | null) => void }) {
  const owner = item.spec.kind === 'owner_by_code';
  const flag = item.spec.kind === 'bool_by_code';
  const signal = item.spec.rule === 'R3';
  const [newCode, setNewCode] = useState('');
  const [newWord, setNewWord] = useState('');
  return (
    <View style={styles.table}>
      {item.codes.map((code) => {
        const { value, inherited } = codeValue(item, code);
        const own = !inherited && code !== '*';
        const def = (item.spec.default as Record<string, string | boolean>)[code];
        return (
          <View key={code} style={styles.codeRow}>
            <Text style={[styles.code, inherited && styles.dim]}>{code === '*' ? 'Any other code' : code}</Text>
            <View style={[{ flex: 1 }, inherited && styles.dim]}>
              {flag ? (
                <Pressable
                  onPress={() => onSet(item, withCode(item, code, value !== true))}
                  style={styles.toggle}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: value === true }}
                  accessibilityLabel={`${code === '*' ? 'Any other code' : code}: ${value === true ? 'on' : 'off'}`}
                >
                  <View pointerEvents="none">
                    <Switch value={value === true} />
                  </View>
                  <Text style={styles.toggleText}>{value === true ? 'On' : 'Off'}</Text>
                </Pressable>
              ) : owner ? (
                <Chips options={OWNERS} value={String(value)} onPick={(v) => onSet(item, withCode(item, code, v))} />
              ) : (
                <TextBox value={String(value)} onCommit={(v) => onSet(item, withCode(item, code, v))} />
              )}
            </View>
            {own && def !== value ? (
              <Pressable onPress={() => onSet(item, withCode(item, code, null))} hitSlop={8} accessibilityLabel={`${code}: back to the default`}>
                <Text style={styles.clear}>↺</Text>
              </Pressable>
            ) : (
              <View style={{ width: 22 }} />
            )}
          </View>
        );
      })}
      {signal ? (
        <View style={styles.codeRow}>
          <TextInput style={[w.input, { width: 90 }]} value={newCode} onChangeText={setNewCode} placeholder="New code" autoCapitalize="characters" autoCorrect={false} />
          <TextInput style={[w.input, { flex: 1 }]} value={newWord} onChangeText={setNewWord} placeholder="Word in item text" autoCorrect={false} />
          <Btn
            title="Add"
            small
            disabled={!newCode.trim() || !newWord.trim()}
            onPress={() => {
              onSet(item, withCode(item, newCode.trim(), newWord.trim()));
              setNewCode('');
              setNewWord('');
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function Chips({ options, value, onPick, labels }: { options: readonly string[]; value: string; onPick: (v: string) => void; labels?: Record<string, string> }) {
  return (
    <View style={styles.chips}>
      {options.map((o) => (
        <Pressable key={o} onPress={() => o !== value && onPick(o)} style={[styles.chip, o === value && styles.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: o === value }}>
          <Text style={[styles.chipText, o === value && styles.chipTextOn]}>{labels?.[o] ?? o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A text value that commits on blur / Return (D45: edits commit per field), not per keystroke. */
function TextBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() && text.trim() !== value) onCommit(text.trim());
    else setText(value);
  };
  return (
    <TextInput
      style={w.input}
      value={text}
      onChangeText={setText}
      onBlur={commit}
      onSubmitEditing={commit}
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="done"
    />
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  hint: { fontSize: 13, color: '#666', maxWidth: 820 },
  link: { color: '#1f6feb', fontSize: 14 },
  small: { fontSize: 12, color: '#777' },
  group: { gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#e6e8ec' },
  groupTitle: { fontSize: 17, fontWeight: '700' },
  ruleText: { fontSize: 13, color: '#555', maxWidth: 820 },
  param: { gap: 6, padding: 10, borderRadius: 8, backgroundColor: '#f7f8fa' },
  paramSet: { backgroundColor: '#eef4fd', borderLeftWidth: 3, borderLeftColor: '#1f6feb' },
  paramHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  badge: { fontSize: 12, fontWeight: '600', color: '#1f6feb' },
  badgeDraft: { fontSize: 12, fontWeight: '600', color: '#b26a00' },
  changes: { fontSize: 13, color: '#555' },
  actions: { flexDirection: 'row', gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { minHeight: 36, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 18, borderWidth: 1, borderColor: '#c9ced6', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#1f6feb', borderColor: '#1f6feb' },
  chipText: { fontSize: 14, color: '#222' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  table: { gap: 6 },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  code: { width: 110, fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.55 },
  clear: { fontSize: 20, color: '#1f6feb', width: 22, textAlign: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  toggleText: { fontSize: 14 },
});
