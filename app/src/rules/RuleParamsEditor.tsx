import { OpError, ROLE_LABEL, isRole, vocab, type Editor, type Store } from '@field-survey/core';
import {
  NO_STATUS,
  codeValue,
  decideRuleParam,
  describeRetrofit,
  describeValue,
  loadRuleParamRows,
  paramGroups,
  retrofitDraft,
  retrofitReason,
  setRuleParam,
  withCode,
  type ParamGroup,
  type ParamItem,
  type ParamValue,
  type RetrofitGroup,
  type RuleParamRow,
} from '@field-survey/rules';
import { Link, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { handRuling } from '../rulings/handoff';
import { useReload } from '../sync/useReload';
import { Btn, ChipPicker, Notice, styles as w } from '../setup/widgets';
import { Chip, color, font, hit, radius, space } from '../ui';
import { engineFor } from './engine';

/**
 * The rules' owners, wordings and statuses (T102, D176 (4)): grouped by rule with the rule's
 * text, each value with "what this changes", its default and a Reset. `scope` is the project
 * (Setup → Rules: a change applies at once and the open drafts follow on the next rules run) or
 * null for the app-level defaults (Projects → Rule defaults: each change is a draft until
 * accepted; new projects copy the accepted ones). Every change is one op through `editor`.
 * On a project, a change that words accepted items differently offers **Review accepted items ▸**:
 * one pre-filled `reword` ruling per field over those items (T116, T120, `retrofitGroups`): each
 * record gets what its rule now words, so a template with `<far end>` in it is one ruling.
 */
export function RuleParamsEditor({ store, editor, scope, dataKey }: { store: Store; editor: Editor; scope: string | null; dataKey: unknown }) {
  const app = scope == null;
  const [groups, setGroups] = useState<ParamGroup[] | null>(null);
  const [tick, setTick] = useState(0);
  const [onlySet, setOnlySet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrofit, setRetrofit] = useState<{ reason: string; before: RuleParamRow[]; groups: RetrofitGroup[] } | null>(null);
  // The last change's rows as they were before it: back from a ruling, the offer lists what is left.
  const lastChange = useRef<{ reason: string; before: RuleParamRow[] } | null>(null);
  const findRetrofit = useCallback(async () => {
    const c = lastChange.current;
    if (app || !scope || !c) return;
    try {
      const groups = await engineFor(store, scope, editor.userId).retrofit(c.before);
      setRetrofit(groups.length ? { reason: c.reason, before: c.before, groups } : null);
    } catch (e) {
      console.warn('[rules] retrofit', e); // only the offer is lost
    }
  }, [app, scope, store, editor]);
  useFocusEffect(
    useCallback(() => {
      void findRetrofit();
    }, [findRetrofit]),
  );

  // T186: a pull during a load no longer throws it away (useReload)
  useReload({
    name: 'rule_params',
    subject: scope ?? 'app',
    reloadKey: `${tick}|${String(dataKey)}`,
    load: () => loadRuleParamRows(store, scope),
    apply: (rows) => setGroups(paramGroups(rows, { app })),
    fail: (e) => setError(`Could not read the rule settings: ${String(e)}`),
  });

  const run = useCallback(async (fn: () => Promise<number>, done: string, after?: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setRetrofit(null);
    lastChange.current = null;
    try {
      const n = await fn();
      if (n) setNotice(done);
      setTick((t) => t + 1);
      if (n && after) await after();
    } catch (e) {
      setError(e instanceof OpError ? e.message : `Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const set = useCallback(
    (item: ParamItem, value: ParamValue | null) => {
      let before: RuleParamRow[] = [];
      void run(
        async () => {
          if (!app) before = await loadRuleParamRows(store, scope);
          return setRuleParam(editor, item.spec.rule, item.spec.key, value);
        },
        app
          ? `${item.spec.rule} · ${item.spec.label}: saved as a draft default.`
          : `${item.spec.rule} · ${item.spec.label}: saved.`,
        app
          ? undefined
          : async () => {
              // The accepted items the new value words differently (T116).
              lastChange.current = { reason: retrofitReason(item.spec.rule, item.spec.label, value), before };
              await findRetrofit();
            },
      );
    },
    [run, editor, app, store, scope, findRetrofit],
  );
  const review = useCallback(
    (g: RetrofitGroup, reason: string, before: readonly RuleParamRow[]) => {
      if (!scope) return;
      handRuling(scope, retrofitDraft(g, reason, before), `Rules: ${describeRetrofit(g)}`);
      router.push({ pathname: '/rulings', params: { project: scope, from: 'handoff' } });
    },
    [scope],
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
      <Text style={styles.hint}>{changed ? `${changed} set away from the built-in defaults.` : 'All on the built-in defaults.'}</Text>
      {!app ? (
        <Link href={{ pathname: '/rulings', params: { project: scope } }} style={styles.link}>
          Change accepted items with a ruling ▸
        </Link>
      ) : null}
      <View style={w.row}>
        <Pressable onPress={() => setOnlySet((v) => !v)} style={styles.toggle} accessibilityRole="switch" accessibilityState={{ checked: onlySet }} testID="rules.only">
          <View pointerEvents="none">
            <Switch value={onlySet} />
          </View>
          <Text style={styles.toggleText}>Only what is changed{app ? ' or waiting' : ''}</Text>
        </Pressable>
      </View>
      <Notice text={error} error />
      <Notice text={notice} />
      {retrofit ? (
        <View style={styles.retrofit}>
          <Text style={styles.changes}>Accepted items still read the old wording.</Text>
          {retrofit.groups.slice(0, RETROFIT_SHOWN).map((g) => (
            <Btn key={`${g.entity}|${g.field}`} title={`Review accepted items ▸  ${describeRetrofit(g)}`} small testID="rules.review" onPress={() => review(g, retrofit.reason, retrofit.before)} />
          ))}
          {retrofit.groups.length > RETROFIT_SHOWN ? (
            <Text style={styles.small}>
              +{retrofit.groups.length - RETROFIT_SHOWN} more fields.
            </Text>
          ) : null}
        </View>
      ) : null}
      {shown.length === 0 ? <Text style={styles.hint}>Nothing changed yet.</Text> : null}
      {shown.map((g) => (
        <View key={g.rule} style={styles.group}>
          <Text style={styles.groupTitle}>
            {g.rule.startsWith('E') || g.rule === 'not_found' || g.rule === 'R3' || g.rule === 'R5' ? g.title : `${g.rule} · ${g.title}`}
          </Text>
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
    <View style={[styles.param, item.set && styles.paramSet]} testID={tid(spec)}>
      <View style={styles.paramHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.label}>
            {spec.label}
            {item.set ? <Text style={styles.badge}>  changed</Text> : null}
            {app && item.state ? <Text style={item.state === 'draft' ? styles.badgeDraft : styles.badge}>  {item.state}</Text> : null}
          </Text>
          {spec.placeholders?.length ? <Text style={styles.small}>Fills in: {spec.placeholders.join(' · ')}</Text> : null}
        </View>
        {app && item.state === 'draft' ? (
          <View style={styles.actions}>
            <Btn title="Accept" small primary onPress={() => onDecide(item, 'accepted')} />
            <Btn title="Reject" small onPress={() => onDecide(item, 'rejected')} />
          </View>
        ) : null}
        {item.set ? <Btn title="Reset to default" small testID={`${tid(spec)}.reset`} onPress={() => onSet(item, null)} /> : null}
      </View>
      <ParamControl item={item} onSet={onSet} />
      {item.set ? <Text style={styles.small}>Default: {describeValue(spec, spec.default)}</Text> : null}
    </View>
  );
}

/** A parameter's testID prefix (T158): `rules.<rule>.<key>`, e.g. `rules.R3a.run.owner`. */
const tid = (spec: { rule: string; key: string }): string => `rules.${spec.rule}.${spec.key}`;

/** Groups offered at once; a wording with the far end in it makes one group per item. */
const RETROFIT_SHOWN = 8;

const OWNERS = vocab.OWNER as readonly string[];
const STATUSES = vocab.CONNECTION_STATUS as readonly string[];

function ParamControl({ item, onSet }: { item: ParamItem; onSet: (item: ParamItem, value: ParamValue | null) => void }) {
  const { spec, value } = item;
  const id = tid(spec);
  switch (spec.kind) {
    case 'owner':
      return <Chips options={OWNERS} value={value as string} onPick={(v) => onSet(item, v)} testID={id} />;
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
        <Pressable onPress={() => onSet(item, !value)} style={styles.toggle} accessibilityRole="switch" accessibilityState={{ checked: value === true }} testID={id}>
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
      return <TextBox value={value as string} onCommit={(v) => onSet(item, v)} testID={id} />;
    case 'owner_by_code':
    case 'text_by_code':
    case 'bool_by_code':
    case 'status_by_code':
    case 'text_by_role':
      return <CodeTable item={item} onSet={onSet} />;
  }
}

/**
 * One row per cable code (a `text_by_role` map: per device role); `*` reads "Any other code". A
 * row without its own entry shows `*`'s value, dimmed — or, in a sparse map (T199), nothing.
 */
function CodeTable({ item, onSet }: { item: ParamItem; onSet: (item: ParamItem, value: ParamValue | null) => void }) {
  const owner = item.spec.kind === 'owner_by_code';
  const flag = item.spec.kind === 'bool_by_code';
  const status = item.spec.kind === 'status_by_code';
  const name = (code: string) => (code === '*' ? 'Any other code' : item.spec.kind === 'text_by_role' && isRole(code) ? ROLE_LABEL[code] : code);
  const signal = item.spec.rule === 'R3';
  const id = tid(item.spec);
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
            <Text style={[styles.code, inherited && styles.dim]}>{name(code)}</Text>
            <View style={[{ flex: 1 }, inherited && styles.dim]}>
              {flag ? (
                <Pressable
                  onPress={() => onSet(item, withCode(item, code, value !== true))}
                  style={styles.toggle}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: value === true }}
                  accessibilityLabel={`${name(code)}: ${value === true ? 'on' : 'off'}`}
                  testID={`${id}.${code}`}
                >
                  <View pointerEvents="none">
                    <Switch value={value === true} />
                  </View>
                  <Text style={styles.toggleText}>{value === true ? 'On' : 'Off'}</Text>
                </Pressable>
              ) : owner ? (
                <Chips options={OWNERS} value={String(value)} onPick={(v) => onSet(item, withCode(item, code, v))} testID={`${id}.${code}`} />
              ) : status ? (
                <ChipPicker
                  value={String(value) || null}
                  options={STATUSES.map((s) => ({ id: s, label: s }))}
                  none="No status (Unsurveyed)"
                  onPick={(v) => onSet(item, withCode(item, code, v ?? NO_STATUS))}
                />
              ) : (
                <TextBox value={String(value)} onCommit={(v) => onSet(item, withCode(item, code, v))} testID={`${id}.${code}`} />
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
          <TextInput style={[w.input, { width: 90 }]} value={newCode} onChangeText={setNewCode} placeholder="New code" autoCapitalize="characters" autoCorrect={false} testID={`${id}.newCode`} />
          <TextInput style={[w.input, { flex: 1 }]} value={newWord} onChangeText={setNewWord} placeholder="Word in item text" autoCorrect={false} testID={`${id}.newWord`} />
          <Btn
            title="Add"
            small
            testID={`${id}.add`}
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

function Chips({ options, value, onPick, labels, testID }: { options: readonly string[]; value: string; onPick: (v: string) => void; labels?: Record<string, string>; testID?: string }) {
  return (
    <View style={styles.chips}>
      {options.map((o) => (
        <Chip key={o} label={labels?.[o] ?? o} small selected={o === value} onPress={() => o !== value && onPick(o)} testID={testID ? `${testID}.${o}` : undefined} />
      ))}
    </View>
  );
}

/** A text value that commits on blur / Return (D45: edits commit per field), not per keystroke. */
function TextBox({ value, onCommit, testID }: { value: string; onCommit: (v: string) => void; testID?: string }) {
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
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  hint: { ...font.caption, color: color.text3, maxWidth: 820 },
  link: { ...font.callout, color: color.primary },
  retrofit: { gap: 6, padding: 10, borderRadius: radius.control, backgroundColor: color.warningTint, alignItems: 'flex-start' },
  small: { ...font.caption, color: color.text3 },
  group: { gap: space.sm, paddingVertical: 10, borderTopWidth: 1, borderTopColor: color.hairline },
  groupTitle: { ...font.headline, color: color.text },
  param: { gap: 6, padding: 10, borderRadius: radius.control, backgroundColor: color.bg },
  paramSet: { backgroundColor: color.primaryTint, borderLeftWidth: 3, borderLeftColor: color.primary },
  paramHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  label: { ...font.calloutBold, color: color.text },
  badge: { ...font.captionBold, color: color.primary },
  badgeDraft: { ...font.captionBold, color: color.warning },
  changes: { ...font.caption, color: color.text2 },
  actions: { flexDirection: 'row', gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  table: { gap: 6 },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  code: { width: 110, ...font.calloutBold, color: color.text },
  dim: { opacity: 0.55 },
  clear: { fontSize: 20, color: color.primary, width: 22, textAlign: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: hit.target },
  toggleText: { ...font.callout, color: color.text },
});
