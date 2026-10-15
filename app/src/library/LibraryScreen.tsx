import { OpError, type Editor, type Store } from '@field-survey/core';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  CABLE_CODES,
  CATEGORIES,
  NSPS_POWER_SUPPLY,
  acceptType,
  blankCable,
  copySources,
  copyTypes,
  createType,
  promoteType,
  describeCable,
  loadLibrary,
  parseAliases,
  rejectType,
  reopenType,
  updateType,
  type CopySource,
  type IdScheme,
  type LibraryAccessory,
  type LibraryCable,
  type LibraryType,
  type LibraryView,
} from './model';

type Pane = { kind: 'type'; id: string } | { kind: 'new' } | { kind: 'copy' } | null;
/** Run an edit; `done` is the line shown after it (a function to word it from what the edit did). */
type RunFn = (fn: (e: Editor, s: Store) => Promise<unknown>, done?: string | (() => string)) => Promise<boolean>;

/**
 * Device-type library (T48, Phase 3 §10): the type list on the left (by category, drafts
 * flagged), the selected type's editor on the right — model, category, aliases, ID scheme,
 * default cables (the rules offer them to every device of an accepted type, R2g), optional
 * cables and accessories, Accept / Reject — plus "+ New type" and "Copy from…". `scope` is the
 * project id, or null for the app library (T61, D65): then `editor` writes to the library stream
 * (`/library/ops`, D184). A project's accepted types can be promoted with `libraryEditor`.
 */
export function LibraryScreen(props: {
  store: Store | null;
  editor: Editor | null;
  /** Writes to the app library's stream (Promote); null where promotion is not offered. */
  libraryEditor: Editor | null;
  scope: string | null;
  /** Opens Needs review for this library's conflicts. */
  onOpenReview?: () => void;
  /** Changes when a pull brought new ops (reload). */
  dataKey: string;
  names: ReadonlyMap<string, string>;
  header: React.ReactNode;
}) {
  const { store, editor, scope } = props;
  const [view, setView] = useState<LibraryView | null>(null);
  const [pane, setPane] = useState<Pane>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!store) return;
    let live = true;
    loadLibrary(store, scope).then(
      (v) => live && setView(v),
      (e: unknown) => live && setNote({ text: String(e), error: true }),
    );
    return () => {
      live = false;
    };
  }, [store, scope, tick, props.dataKey]);

  const run: RunFn = useCallback(
    async (fn, done) => {
      if (!editor || !store) return false;
      try {
        await fn(editor, store);
        const text = typeof done === 'function' ? done() : done;
        setNote(text ? { text, error: false } : null);
        setTick((n) => n + 1);
        return true;
      } catch (e) {
        setNote({ text: e instanceof OpError ? e.message : String(e), error: true });
        return false;
      }
    },
    [editor, store],
  );

  const types = view?.types ?? [];
  const selected = pane?.kind === 'type' ? (types.find((t) => t.id === pane.id) ?? null) : null;
  const groups = groupByCategory(types);

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        {props.header}
        <Text style={styles.title}>
          {scope ? 'Device-type library' : 'App device-type library'} <Text style={styles.sub}>({types.filter((t) => t.state !== 'rejected').length} types{view?.drafts ? ` · ${view.drafts} draft${view.drafts === 1 ? '' : 's'}` : ''})</Text>
        </Text>
        {view?.inReview && props.onOpenReview ? (
          <Pressable onPress={props.onOpenReview}>
            <Text style={styles.review}>{view.inReview} in review ▸</Text>
          </Pressable>
        ) : null}
        <Pressable disabled={!editor} onPress={() => setPane({ kind: 'new' })} style={[styles.btn, !editor && styles.off]}>
          <Text style={styles.btnText}>+ New type</Text>
        </Pressable>
        <Pressable disabled={!editor} onPress={() => setPane({ kind: 'copy' })} style={[styles.btnGhost, !editor && styles.off]}>
          <Text style={styles.link}>Copy from…</Text>
        </Pressable>
      </View>
      {note ? <Text style={[styles.note, !note.error && styles.noteOk]}>{note.text}</Text> : null}
      <View style={styles.split}>
        <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
          {groups.map(([cat, rows]) => (
            <View key={cat} style={styles.group}>
              <Text style={styles.groupTitle}>{cat}</Text>
              {rows.map((t) => (
                <Pressable key={t.id} onPress={() => setPane({ kind: 'type', id: t.id })} style={[styles.typeRow, selected?.id === t.id && styles.typeRowOn]}>
                  <Text style={[styles.typeModel, t.state === 'rejected' && styles.dim]} numberOfLines={1}>
                    {t.state === 'draft' ? <Text style={styles.draft}>DRAFT </Text> : null}
                    {t.state === 'rejected' ? <Text style={styles.dim}>rejected </Text> : null}
                    {t.model}
                    {t.aliases.length ? <Text style={styles.sub}> · {t.aliases.join(' · ')}</Text> : null}
                  </Text>
                  <Text style={styles.sub}>
                    {t.devices} device{t.devices === 1 ? '' : 's'}
                    {t.state === 'draft' ? ` · added by ${nameOf(props.names, t.createdById)}${t.createdAt ? ` ${shortDate(t.createdAt)}` : ''} ⚑` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          ))}
          {view && !types.length ? (
            <Text style={styles.sub}>
              {scope
                ? 'No device types yet. Add one, or copy them from another project or the app library.'
                : 'The app library is empty. New projects copy its accepted types; add one, copy from a project, or promote a project\'s type.'}
            </Text>
          ) : null}
        </ScrollView>
        <ScrollView style={styles.pane} contentContainerStyle={styles.paneBody} keyboardShouldPersistTaps="handled">
          {pane?.kind === 'new' ? (
            <NewType scope={scope} run={run} onCreated={(id) => setPane({ kind: 'type', id })} />
          ) : pane?.kind === 'copy' && store ? (
            <CopyFrom store={store} scope={scope} run={run} onDone={() => setPane(null)} />
          ) : selected ? (
            <TypeEditor key={`${selected.id}:${tick}`} type={selected} canEdit={!!editor} run={run} libraryEditor={props.libraryEditor} />
          ) : (
            <Text style={styles.sub}>Pick a type to see and edit it.</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function groupByCategory(types: readonly LibraryType[]): [string, LibraryType[]][] {
  const out = new Map<string, LibraryType[]>();
  for (const t of types) {
    const k = t.state === 'rejected' ? 'Rejected' : (t.category ?? 'No category');
    out.set(k, [...(out.get(k) ?? []), t]);
  }
  return [...out.entries()];
}

function nameOf(names: ReadonlyMap<string, string>, id: string | null): string {
  if (!id) return 'someone';
  return names.get(id) ?? `user …${id.slice(-4)}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
}

function NewType(props: { scope: string | null; run: RunFn; onCreated: (id: string) => void }) {
  const [model, setModel] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>New device type</Text>
      <Text style={styles.sub}>It starts as a draft: usable on the plan at once, flagged until someone accepts it.</Text>
      <TextInput value={model} onChangeText={setModel} placeholder="Model (as the BOM spells it)" placeholderTextColor="#888" style={styles.input} autoFocus />
      <Chips options={CATEGORIES} value={category} onPick={setCategory} />
      <Pressable
        disabled={!model.trim()}
        onPress={() => {
          let id = '';
          void props
            .run(async (e, s) => {
              id = await createType(e, s, props.scope, { model, category });
            }, `Added ${model.trim()} as a draft.`)
            .then((ok) => ok && props.onCreated(id));
        }}
        style={[styles.btn, styles.self, !model.trim() && styles.off]}>
        <Text style={styles.btnText}>Add draft</Text>
      </Pressable>
    </View>
  );
}

function CopyFrom(props: { store: Store; scope: string | null; run: RunFn; onDone: () => void }) {
  const [sources, setSources] = useState<CopySource[] | null>(null);
  const [from, setFrom] = useState<string | null | undefined>(undefined);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    copySources(props.store, props.scope).then((s) => {
      setSources(s);
      if (s.length) setFrom(s[0]!.id);
    }, () => setSources([]));
  }, [props.store, props.scope]);
  const source = sources?.find((s) => s.id === from) ?? null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Copy from…</Text>
      <Text style={styles.sub}>Accepted types of another project on this iPad, or of the app library. A model this library already has is skipped.</Text>
      {sources && !sources.length ? <Text style={styles.sub}>Nothing to copy: no other library on this iPad has accepted types.</Text> : null}
      <View style={styles.wrap}>
        {(sources ?? []).map((s) => (
          <Pressable key={s.id ?? 'app'} onPress={() => { setFrom(s.id); setPicked(new Set()); }} style={[styles.chip, from === s.id && styles.chipOn]}>
            <Text style={from === s.id ? styles.chipTextOn : styles.chipText}>{s.name} ({s.types.length})</Text>
          </Pressable>
        ))}
      </View>
      {source ? (
        <>
          <Pressable onPress={() => setPicked(picked.size === source.types.length ? new Set() : new Set(source.types.map((t) => t.id)))}>
            <Text style={styles.link}>{picked.size === source.types.length ? 'Untick all' : `Tick all ${source.types.length}`}</Text>
          </Pressable>
          {source.types.map((t) => (
            <Pressable key={t.id} onPress={() => setPicked(toggle(picked, t.id))} style={styles.row}>
              <Text style={styles.check}>{picked.has(t.id) ? '☑' : '☐'}</Text>
              <Text style={[styles.value, styles.grow]}>
                {t.model} <Text style={styles.sub}>{t.category ?? ''}{t.defaultCables.length ? ` · ${t.defaultCables.map((c) => c.code).join(', ')}` : ''}</Text>
              </Text>
            </Pressable>
          ))}
          <Pressable
            disabled={!picked.size}
            onPress={() => {
              let msg = '';
              void props.run(async (e, s) => {
                const out = await copyTypes(e, s, props.scope, [...picked]);
                msg = `Copied ${out.copied} type${out.copied === 1 ? '' : 's'}${out.skipped.length ? `; already here: ${out.skipped.join(', ')}` : ''}.`;
              }, () => msg).then((ok) => ok && props.onDone());
            }}
            style={[styles.btn, styles.self, !picked.size && styles.off]}>
            <Text style={styles.btnText}>Copy {picked.size || ''}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selected type: a form edited locally, saved as one group. */
function TypeEditor(props: { type: LibraryType; canEdit: boolean; run: RunFn; libraryEditor: Editor | null }) {
  const t = props.type;
  const [model, setModel] = useState(t.model);
  const [category, setCategory] = useState<string | null>(t.category);
  const [aliases, setAliases] = useState(t.aliases.join(', '));
  const [scheme, setScheme] = useState<IdScheme | null>(t.idScheme);
  const [defaults, setDefaults] = useState<LibraryCable[]>(t.defaultCables);
  const [optional, setOptional] = useState<LibraryCable[]>(t.optionalCables);
  const [accessories, setAccessories] = useState<LibraryAccessory[]>(t.optionalAccessories);
  const dirty =
    model !== t.model ||
    category !== t.category ||
    aliases !== t.aliases.join(', ') ||
    scheme !== t.idScheme ||
    JSON.stringify(defaults) !== JSON.stringify(t.defaultCables) ||
    JSON.stringify(optional) !== JSON.stringify(t.optionalCables) ||
    JSON.stringify(accessories) !== JSON.stringify(t.optionalAccessories);
  const save = () =>
    props.run(
      (e, s) => updateType(e, s, t.id, { model, category, aliases: parseAliases(aliases), idScheme: scheme, defaultCables: defaults, optionalCables: optional, optionalAccessories: accessories }),
      'Saved.',
    );
  const ro = !props.canEdit;
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={[styles.sectionTitle, styles.grow]}>
          {t.state === 'draft' ? <Text style={styles.draft}>DRAFT </Text> : null}
          {t.model}
        </Text>
        <Text style={styles.sub}>
          {t.devices} device{t.devices === 1 ? '' : 's'} · {t.state}
        </Text>
      </View>
      <Field label="Model">
        <TextInput value={model} onChangeText={setModel} editable={!ro} style={styles.input} />
      </Field>
      <Field label="Category">
        <Chips options={CATEGORIES} value={category} onPick={ro ? undefined : setCategory} />
      </Field>
      <Field label="Aliases (BOM)" hint="Comma-separated. A device whose Device text is the model or an alias is of this type.">
        <TextInput value={aliases} onChangeText={setAliases} editable={!ro} placeholder="P-NSPS-D, P-NSPS-D-KIT" placeholderTextColor="#888" style={styles.input} />
      </Field>
      <Field label="ID scheme" hint="Level-number: 06M-04. Level-tag: 06M-S16 for stations, 06M-D3 for sensors. The server assigns the ID either way.">
        <View style={styles.wrap}>
          {([null, 'level_number', 'level_tag'] as const).map((v) => (
            <Pressable key={v ?? 'default'} disabled={ro} onPress={() => setScheme(v)} style={[styles.chip, scheme === v && styles.chipOn]}>
              <Text style={scheme === v ? styles.chipTextOn : styles.chipText}>{v === null ? 'Category default' : v === 'level_number' ? 'Level-number' : 'Level-tag (S/D)'}</Text>
            </Pressable>
          ))}
        </View>
      </Field>
      <Field
        label="Default cables (always generated)"
        hint="Once the type is accepted, the rules offer each run as a draft to every device of this type that lacks it, instead of the category's (R2c / R2d). Unison (U) stays one bus per level (R2e).">
        <CableList list={defaults} onChange={ro ? undefined : setDefaults} />
      </Field>
      <Field label="Optional cables" hint="Kept with the type; not generated.">
        <CableList list={optional} onChange={ro ? undefined : setOptional} />
      </Field>
      <Field label="Optional accessories">
        {accessories.map((a, i) => (
          <View key={i} style={styles.row}>
            <TextInput value={a.model} editable={!ro} onChangeText={(v) => setAccessories(replace(accessories, i, { ...a, model: v }))} placeholder="Model" placeholderTextColor="#888" style={[styles.input, styles.grow]} />
            <Text style={styles.sub}>expected</Text>
            <TextInput value={a.expected_qty == null ? '' : String(a.expected_qty)} editable={!ro} onChangeText={(v) => setAccessories(replace(accessories, i, { ...a, expected_qty: toQty(v) }))} keyboardType="number-pad" style={[styles.input, styles.qty]} />
            {!ro ? (
              <Pressable onPress={() => setAccessories(accessories.filter((_, j) => j !== i))}>
                <Text style={styles.danger}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {!ro ? (
          <View style={styles.wrap}>
            <Pressable onPress={() => setAccessories([...accessories, { model: '', expected_qty: 1 }])}>
              <Text style={styles.link}>+ add</Text>
            </Pressable>
            {category === 'NSPS' && !accessories.some((a) => a.model === NSPS_POWER_SUPPLY.model) ? (
              <Pressable onPress={() => setAccessories([...accessories, NSPS_POWER_SUPPLY])}>
                <Text style={styles.link}>+ {NSPS_POWER_SUPPLY.model} (expected 1, D52)</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Field>
      <Text style={styles.sub}>Rules that reference this type: {t.rules.length ? t.rules.join(', ') : 'none'}</Text>
      {props.canEdit ? (
        <View style={styles.actions}>
          <Pressable disabled={!dirty} onPress={() => void save()} style={[styles.btn, !dirty && styles.off]}>
            <Text style={styles.btnText}>Save</Text>
          </Pressable>
          {t.state === 'draft' ? (
            <>
              <Pressable
                disabled={dirty}
                onPress={() =>
                  void props.run(
                    (e) => acceptType(e, t.id),
                    t.defaultCables.length ? `Accepted. The rules will offer its default cables to ${t.devices} device${t.devices === 1 ? '' : 's'} as drafts.` : 'Accepted.',
                  )
                }
                style={[styles.btnOk, dirty && styles.off]}>
                <Text style={styles.btnText}>Accept draft</Text>
              </Pressable>
              <Pressable onPress={() => void props.run((e) => rejectType(e, t.id), 'Rejected: the type leaves the pickers; its devices keep it.')}>
                <Text style={styles.danger}>Reject</Text>
              </Pressable>
            </>
          ) : (
            <Pressable onPress={() => void props.run((e) => reopenType(e, t.id), 'Back to draft.')}>
              <Text style={styles.link}>Back to draft</Text>
            </Pressable>
          )}
          {t.projectId && t.state === 'accepted' && props.libraryEditor ? (
            t.promotedAs ? (
              <Text style={styles.sub}>In the app library ✓</Text>
            ) : (
              <Pressable
                disabled={dirty}
                onPress={() => {
                  const lib = props.libraryEditor!;
                  void props.run((_e, s) => promoteType(lib, s, t.id), `Promoted: ${t.model} is in the app library; new projects copy it.`);
                }}
                style={dirty && styles.off}>
                <Text style={styles.link}>Promote to app library</Text>
              </Pressable>
            )
          ) : null}
          {dirty && t.state === 'draft' ? <Text style={styles.sub}>Save before accepting.</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function CableList(props: { list: LibraryCable[]; onChange?: (list: LibraryCable[]) => void }) {
  const { list, onChange } = props;
  if (!onChange) return list.length ? <>{list.map((c, i) => <Text key={i} style={styles.value}>{describeCable(c)}</Text>)}</> : <Text style={styles.sub}>None.</Text>;
  return (
    <View style={styles.cables}>
      {list.map((c, i) => {
        const set = (patch: Partial<LibraryCable>) => onChange(replace(list, i, { ...c, ...patch }));
        return (
          <View key={i} style={styles.cable}>
            <View style={styles.wrap}>
              {CABLE_CODES.map((code) => (
                <Pressable key={code} onPress={() => set({ code })} style={[styles.chipSmall, c.code === code && styles.chipOn]}>
                  <Text style={c.code === code ? styles.chipTextOn : styles.chipText}>{code}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.row}>
              <TextInput value={c.from ?? ''} onChangeText={(v) => set({ from: v })} placeholder="From (empty = panel name)" placeholderTextColor="#888" style={[styles.input, styles.grow]} />
              <TextInput value={c.to ?? ''} onChangeText={(v) => set({ to: v })} placeholder="To" placeholderTextColor="#888" style={[styles.input, styles.grow]} />
              <TextInput value={c.far ?? ''} onChangeText={(v) => set({ far: v })} placeholder="Far end (placeholder)" placeholderTextColor="#888" style={[styles.input, styles.grow]} />
            </View>
            <View style={styles.row}>
              <Text style={styles.sub}>Single row</Text>
              <Switch value={c.single_row} onValueChange={(v) => set({ single_row: v })} />
              <Text style={styles.sub}>Qty</Text>
              <TextInput value={c.qty == null ? '' : String(c.qty)} onChangeText={(v) => set({ qty: toQty(v) })} placeholder="—" placeholderTextColor="#888" keyboardType="number-pad" style={[styles.input, styles.qty]} />
              <View style={styles.grow} />
              <Pressable onPress={() => onChange(list.filter((_, j) => j !== i))}>
                <Text style={styles.danger}>Remove</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      <Pressable onPress={() => onChange([...list, blankCable()])}>
        <Text style={styles.link}>+ add cable</Text>
      </Pressable>
    </View>
  );
}

function replace<T>(list: readonly T[], i: number, v: T): T[] {
  return list.map((x, j) => (j === i ? v : x));
}

function toQty(v: string): number | null {
  const n = Number.parseInt(v.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      {props.hint ? <Text style={styles.sub}>{props.hint}</Text> : null}
      {props.children}
    </View>
  );
}

function Chips(props: { options: readonly string[]; value: string | null; onPick?: (v: string | null) => void }) {
  return (
    <View style={styles.wrap}>
      {props.options.map((o) => (
        <Pressable key={o} disabled={!props.onPick} onPress={() => props.onPick?.(props.value === o ? null : o)} style={[styles.chip, props.value === o && styles.chipOn]}>
          <Text style={props.value === o ? styles.chipTextOn : styles.chipText}>{o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 24, fontWeight: '600', flex: 1 },
  link: { color: '#1f6feb', fontSize: 16 },
  danger: { color: '#b3261e', fontSize: 16 },
  review: { color: '#9a6700', fontSize: 16, fontWeight: '600' },
  note: { paddingHorizontal: 20, paddingBottom: 8, color: '#b3261e', fontSize: 14 },
  noteOk: { color: '#1a7f37' },
  split: { flex: 1, flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e1e4e8' },
  list: { flex: 4, borderRightWidth: 1, borderRightColor: '#e1e4e8' },
  listBody: { padding: 16, gap: 14 },
  pane: { flex: 6 },
  paneBody: { padding: 20, gap: 16 },
  group: { gap: 4 },
  groupTitle: { fontSize: 15, fontWeight: '700', color: '#444' },
  typeRow: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, minHeight: 44 },
  typeRowOn: { backgroundColor: '#e8f0fe' },
  typeModel: { fontSize: 16 },
  dim: { color: '#999' },
  section: { gap: 12 },
  sectionTitle: { fontSize: 19, fontWeight: '600' },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 13, color: '#666', fontWeight: '400' },
  draft: { fontSize: 12, color: '#9a6700', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  grow: { flex: 1 },
  self: { alignSelf: 'flex-start' },
  value: { fontSize: 16 },
  check: { fontSize: 22 },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  qty: { width: 64, textAlign: 'center' },
  cables: { gap: 10 },
  cable: { gap: 6, padding: 10, borderWidth: 1, borderColor: '#e1e4e8', borderRadius: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 8 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1565c0' },
  btnOk: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1a7f37' },
  btnGhost: { paddingHorizontal: 8, paddingVertical: 10 },
  btnText: { color: '#fff', fontWeight: '600' },
  off: { opacity: 0.4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
});
