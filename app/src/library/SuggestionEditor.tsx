import type { Editor, Store } from '@field-survey/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  TARGETS,
  acceptSuggestion,
  addSuggestion,
  loadStandardSuggestions,
  rejectSuggestion,
  removeSuggestion,
  reopenSuggestion,
  type Suggestion,
  type SuggestionScope,
  type SuggestionTarget,
} from '../suggestions/model';
import { CATEGORIES } from './model';
import { Chip, color, fieldStyles, font, radius, space } from '../ui';

type RunFn = (fn: (e: Editor, s: Store) => Promise<unknown>, done?: string | (() => string)) => Promise<boolean>;

/**
 * The suggestion chips of one type, category or cable code (T99, D174), by where they are
 * offered: each with its state and Accept / Reject / Remove, and "+ add" (a draft). Every chip is
 * the app library's and is edited here only (D292 (9)); `run`'s editor writes to the library stream.
 */
export function SuggestionList(props: {
  rows: readonly Suggestion[];
  scope: SuggestionScope;
  refKey: string;
  canEdit: boolean;
  run: RunFn;
  /** A network code whose kits are off in the app library's Rules: no Part chips (R4, D213). */
  noPart?: boolean;
}) {
  const { scope, refKey } = props;
  const targets = TARGETS.filter((t) => !(scope === 'code' && t.target === 'part' && props.noPart));
  const [target, setTarget] = useState<SuggestionTarget>(scope === 'code' ? 'connection_note' : 'device_note');
  const [text, setText] = useState('');
  const add = () =>
    void props
      .run((e, s) => addSuggestion(e, s, { scope, ref: refKey, target, text }), `Added "${text.trim()}" as a draft.`)
      .then((ok) => ok && setText(''));
  return (
    <View style={styles.box}>
      {targets.map(({ target: tg, label }) => {
        const rows = props.rows.filter((r) => r.target === tg);
        if (!rows.length) return null;
        return (
          <View key={tg} style={styles.group}>
            <Text style={styles.label}>{label}</Text>
            {rows.map((r) => (
              <ChipRow key={r.id} row={r} canEdit={props.canEdit} run={props.run} />
            ))}
          </View>
        );
      })}
      {!props.rows.length ? <Text style={styles.sub}>No chips yet.</Text> : null}
      {props.canEdit ? (
        <View style={styles.group}>
          <View style={styles.wrap}>
            {targets.map(({ target: tg, label }) => (
              <Chip key={tg} small onPress={() => setTarget(tg)} selected={target === tg} label={label} testID={`sugg.target.${tg}`} />
            ))}
          </View>
          <View style={styles.row}>
            <TextInput value={text} onChangeText={setText} placeholder="Phrase" placeholderTextColor={color.text3} style={[styles.input, styles.grow]} onSubmitEditing={add} testID="sugg.input" />
            <Pressable disabled={!text.trim()} onPress={add} hitSlop={space.md} style={!text.trim() && styles.off} testID="sugg.add">
              <Text style={styles.link}>+ add</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ChipRow(props: { row: Suggestion; canEdit: boolean; run: RunFn }) {
  const { row: r } = props;
  return (
    <View style={styles.row}>
      <Text style={[styles.value, styles.grow, r.state === 'rejected' && styles.dim]} testID={`sugg.row.${r.text}`}>
        {r.state === 'draft' ? <Text style={styles.draft}>DRAFT </Text> : null}
        {r.state === 'rejected' ? <Text style={styles.dim}>rejected </Text> : null}
        {r.text}
      </Text>
      {props.canEdit ? (
        <>
          {r.state === 'draft' ? (
            <>
              <Pressable onPress={() => void props.run((e) => acceptSuggestion(e, r.id), 'Accepted.')} hitSlop={space.md} testID={`sugg.accept.${r.text}`}>
                <Text style={styles.ok}>Accept</Text>
              </Pressable>
              <Pressable onPress={() => void props.run((e) => rejectSuggestion(e, r.id), 'Rejected: it leaves the chips.')} hitSlop={space.md} testID={`sugg.reject.${r.text}`}>
                <Text style={styles.danger}>Reject</Text>
              </Pressable>
            </>
          ) : r.state === 'rejected' ? (
            <Pressable onPress={() => void props.run((e) => reopenSuggestion(e, r.id), 'Back to draft.')} hitSlop={space.md} testID={`sugg.reopen.${r.text}`}>
              <Text style={styles.link}>Back to draft</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void props.run((e) => removeSuggestion(e, r.id), 'Removed.')} hitSlop={space.md} testID={`sugg.remove.${r.text}`}>
            <Text style={styles.danger}>Remove</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

/**
 * "Suggestions…" (T99): the chips of a category or a cable code, with "Load standard
 * suggestions" (the seed as drafts, D174 (3)).
 */
export function SuggestionsPane(props: { rows: readonly Suggestion[]; codes: readonly string[]; noPartCodes: readonly string[]; canEdit: boolean; run: RunFn }) {
  const [pick, setPick] = useState<{ scope: 'category' | 'code'; ref: string }>({ scope: 'category', ref: CATEGORIES[0]! });
  const count = (scope: SuggestionScope, ref: string) => props.rows.filter((r) => r.scope === scope && r.ref.toUpperCase() === ref.toUpperCase() && r.state !== 'rejected').length;
  const rows = props.rows.filter((r) => r.scope === pick.scope && r.ref.toUpperCase() === pick.ref.toUpperCase());
  const drafts = props.rows.filter((r) => r.scope !== 'type' && r.state === 'draft').length;
  return (
    <View style={styles.section}>
      <Text style={styles.title}>Suggestions by category and cable code</Text>
      {props.canEdit ? (
        <View style={styles.row}>
          <Pressable
            onPress={() => {
              let n = 0;
              void props.run(async (e, s) => {
                n = await loadStandardSuggestions(e, s);
              }, () => (n ? `Added ${n} standard suggestion${n === 1 ? '' : 's'} as drafts.` : 'The standard suggestions are all here already.'));
            }}
            hitSlop={space.md}
            testID="sugg.loadStandard">
            <Text style={styles.link}>Load standard suggestions</Text>
          </Pressable>
          {drafts ? <Text style={styles.sub}>{drafts} draft{drafts === 1 ? '' : 's'}</Text> : null}
        </View>
      ) : null}
      <Text style={styles.label}>Category</Text>
      <View style={styles.wrap}>
        {CATEGORIES.map((c) => (
          <Pick key={c} on={pick.scope === 'category' && pick.ref === c} label={c} n={count('category', c)} onPress={() => setPick({ scope: 'category', ref: c })} testID={`sugg.category.${c}`} />
        ))}
      </View>
      <Text style={styles.label}>Cable code</Text>
      <View style={styles.wrap}>
        {props.codes.map((c) => (
          <Pick key={c} on={pick.scope === 'code' && pick.ref === c} label={c} n={count('code', c)} onPress={() => setPick({ scope: 'code', ref: c })} testID={`sugg.code.${c}`} />
        ))}
      </View>
      <Text style={styles.heading}>{pick.scope === 'code' ? `Cable ${pick.ref}` : pick.ref}</Text>
      <SuggestionList key={`${pick.scope}:${pick.ref}`} rows={rows} scope={pick.scope} refKey={pick.ref} canEdit={props.canEdit} run={props.run} noPart={pick.scope === 'code' && props.noPartCodes.includes(pick.ref)} />
    </View>
  );
}

function Pick(props: { on: boolean; label: string; n: number; onPress: () => void; testID: string }) {
  return (
    <Chip small onPress={props.onPress} selected={props.on} label={`${props.label}${props.n ? ` (${props.n})` : ''}`} testID={props.testID} />
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  title: { ...font.title, color: color.text },
  heading: { ...font.headline, color: color.text, paddingTop: 6 },
  box: { gap: 10, padding: space.md, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, backgroundColor: color.surface },
  group: { gap: space.xs },
  label: { ...font.captionBold, color: color.text2 },
  sub: { ...font.caption, color: color.text3 },
  value: { ...font.body, color: color.text },
  dim: { color: color.text3 },
  draft: { ...font.badge, color: color.warning },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: space.xs, minHeight: 44 },
  grow: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  input: fieldStyles.input,
  link: { ...font.callout, color: color.primary },
  ok: { ...font.calloutBold, color: color.success },
  danger: { ...font.callout, color: color.danger },
  off: { opacity: 0.45 },
});