import type { Editor, Store } from '@field-survey/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  NO_PART_CODES,
  TARGETS,
  acceptSuggestion,
  addSuggestion,
  copyAppSuggestions,
  loadStandardSuggestions,
  promoteSuggestion,
  rejectSuggestion,
  removeSuggestion,
  reopenSuggestion,
  type Suggestion,
  type SuggestionScope,
  type SuggestionTarget,
} from '../suggestions/model';
import { CABLE_CODES, CATEGORIES } from './model';

type RunFn = (fn: (e: Editor, s: Store) => Promise<unknown>, done?: string | (() => string)) => Promise<boolean>;

/**
 * The suggestion chips of one type, category or cable code (T99, D174), by where they are
 * offered: each with its state and Accept / Reject / Remove / Promote, and "+ add" (a draft).
 * `library` is the project id, null for the app library.
 */
export function SuggestionList(props: {
  rows: readonly Suggestion[];
  scope: SuggestionScope;
  refKey: string;
  library: string | null;
  canEdit: boolean;
  run: RunFn;
  libraryEditor: Editor | null;
}) {
  const { scope, refKey } = props;
  const targets = TARGETS.filter((t) => !(scope === 'code' && t.target === 'part' && NO_PART_CODES.includes(refKey.toUpperCase())));
  const [target, setTarget] = useState<SuggestionTarget>(scope === 'code' ? 'connection_note' : 'device_note');
  const [text, setText] = useState('');
  const add = () =>
    void props
      .run((e, s) => addSuggestion(e, s, props.library, { scope, ref: refKey, target, text }), `Added "${text.trim()}" as a draft.`)
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
              <ChipRow key={r.id} row={r} canEdit={props.canEdit} run={props.run} libraryEditor={props.libraryEditor} />
            ))}
          </View>
        );
      })}
      {!props.rows.length ? <Text style={styles.sub}>No chips yet.</Text> : null}
      {props.canEdit ? (
        <View style={styles.group}>
          <View style={styles.wrap}>
            {targets.map(({ target: tg, label }) => (
              <Pressable key={tg} onPress={() => setTarget(tg)} style={[styles.chip, target === tg && styles.chipOn]}>
                <Text style={target === tg ? styles.chipTextOn : styles.chipText}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            <TextInput value={text} onChangeText={setText} placeholder="Phrase, as the surveyor would type it" placeholderTextColor="#888" style={[styles.input, styles.grow]} onSubmitEditing={add} />
            <Pressable disabled={!text.trim()} onPress={add} style={!text.trim() && styles.off}>
              <Text style={styles.link}>+ add</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ChipRow(props: { row: Suggestion; canEdit: boolean; run: RunFn; libraryEditor: Editor | null }) {
  const { row: r } = props;
  const lib = props.libraryEditor;
  return (
    <View style={styles.row}>
      <Text style={[styles.value, styles.grow, r.state === 'rejected' && styles.dim]}>
        {r.state === 'draft' ? <Text style={styles.draft}>DRAFT </Text> : null}
        {r.state === 'rejected' ? <Text style={styles.dim}>rejected </Text> : null}
        {r.text}
      </Text>
      {props.canEdit ? (
        <>
          {r.state === 'draft' ? (
            <>
              <Pressable onPress={() => void props.run((e) => acceptSuggestion(e, r.id), 'Accepted.')} hitSlop={6}>
                <Text style={styles.ok}>Accept</Text>
              </Pressable>
              <Pressable onPress={() => void props.run((e) => rejectSuggestion(e, r.id), 'Rejected: it leaves the chips.')} hitSlop={6}>
                <Text style={styles.danger}>Reject</Text>
              </Pressable>
            </>
          ) : r.state === 'rejected' ? (
            <Pressable onPress={() => void props.run((e) => reopenSuggestion(e, r.id), 'Back to draft.')} hitSlop={6}>
              <Text style={styles.link}>Back to draft</Text>
            </Pressable>
          ) : null}
          {r.projectId && r.state === 'accepted' && lib ? (
            <Pressable onPress={() => void props.run((_e, s) => promoteSuggestion(lib, s, r.id), `Promoted: the app library offers "${r.text}".`)} hitSlop={6}>
              <Text style={styles.link}>Promote</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void props.run((e) => removeSuggestion(e, r.id), 'Removed.')} hitSlop={6}>
            <Text style={styles.danger}>Remove</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

/**
 * "Suggestions…" (T99): the chips of a category or a cable code. The app library offers "Load
 * standard suggestions" (the seed as drafts, D174 (3)); a project "Copy from app library".
 */
export function SuggestionsPane(props: { rows: readonly Suggestion[]; library: string | null; canEdit: boolean; run: RunFn; libraryEditor: Editor | null }) {
  const [pick, setPick] = useState<{ scope: 'category' | 'code'; ref: string }>({ scope: 'category', ref: CATEGORIES[0]! });
  const count = (scope: SuggestionScope, ref: string) => props.rows.filter((r) => r.scope === scope && r.ref.toUpperCase() === ref.toUpperCase() && r.state !== 'rejected').length;
  const rows = props.rows.filter((r) => r.scope === pick.scope && r.ref.toUpperCase() === pick.ref.toUpperCase());
  const drafts = props.rows.filter((r) => r.scope !== 'type' && r.state === 'draft').length;
  return (
    <View style={styles.section}>
      <Text style={styles.title}>Suggestions by category and cable code</Text>
      <Text style={styles.sub}>
        Chips offered on the device card and the end editor: a device's type first, then its category, then the project's vocabulary; an end shows its cable code's. Anything can still be typed. A type's own chips are on the type.
        {props.library ? ' This project reads its own chips; the app library reaches it by copying.' : ' New projects copy the accepted ones.'}
      </Text>
      {props.canEdit ? (
        <View style={styles.row}>
          {props.library === null ? (
            <Pressable
              onPress={() => {
                let n = 0;
                void props.run(async (e, s) => {
                  n = await loadStandardSuggestions(e, s);
                }, () => (n ? `Added ${n} standard suggestion${n === 1 ? '' : 's'} as drafts.` : 'The standard suggestions are all here already.'));
              }}>
              <Text style={styles.link}>Load standard suggestions</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                let n = 0;
                void props.run(async (e, s) => {
                  n = await copyAppSuggestions(e, s, props.library!);
                }, () => (n ? `Copied ${n} chip${n === 1 ? '' : 's'} from the app library.` : 'Nothing new in the app library (accepted category and code chips only).'));
              }}>
              <Text style={styles.link}>Copy from app library</Text>
            </Pressable>
          )}
          {drafts ? <Text style={styles.sub}>{drafts} draft{drafts === 1 ? '' : 's'}</Text> : null}
        </View>
      ) : null}
      <Text style={styles.label}>Category</Text>
      <View style={styles.wrap}>
        {CATEGORIES.map((c) => (
          <Pick key={c} on={pick.scope === 'category' && pick.ref === c} label={c} n={count('category', c)} onPress={() => setPick({ scope: 'category', ref: c })} />
        ))}
      </View>
      <Text style={styles.label}>Cable code</Text>
      <View style={styles.wrap}>
        {CABLE_CODES.map((c) => (
          <Pick key={c} on={pick.scope === 'code' && pick.ref === c} label={c} n={count('code', c)} onPress={() => setPick({ scope: 'code', ref: c })} />
        ))}
      </View>
      <Text style={styles.heading}>{pick.scope === 'code' ? `Cable ${pick.ref}` : pick.ref}</Text>
      <SuggestionList key={`${pick.scope}:${pick.ref}`} rows={rows} scope={pick.scope} refKey={pick.ref} library={props.library} canEdit={props.canEdit} run={props.run} libraryEditor={props.libraryEditor} />
    </View>
  );
}

function Pick(props: { on: boolean; label: string; n: number; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={[styles.chip, props.on && styles.chipOn]}>
      <Text style={props.on ? styles.chipTextOn : styles.chipText}>
        {props.label}
        {props.n ? ` (${props.n})` : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  title: { fontSize: 19, fontWeight: '600' },
  heading: { fontSize: 17, fontWeight: '600', paddingTop: 6 },
  box: { gap: 10, padding: 10, borderWidth: 1, borderColor: '#e1e4e8', borderRadius: 8 },
  group: { gap: 4 },
  label: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 13, color: '#666' },
  value: { fontSize: 16 },
  dim: { color: '#999' },
  draft: { fontSize: 12, color: '#9a6700', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 4 },
  grow: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  link: { color: '#1f6feb', fontSize: 16 },
  ok: { color: '#1a7f37', fontSize: 16, fontWeight: '600' },
  danger: { color: '#b3261e', fontSize: 16 },
  off: { opacity: 0.4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
});
