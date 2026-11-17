import { OpError, type Editor, type Role, type Store } from '@field-survey/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  ACCESSORY_GROUP,
  CABLE_CODES,
  CATEGORIES,
  NSPS_POWER_SUPPLY,
  REJECTED_GROUP,
  ROLES,
  ROLE_LABELS,
  acceptAllDrafts,
  acceptType,
  blankCable,
  copySources,
  copyTypes,
  createType,
  promoteType,
  describeCable,
  editorStamp,
  libraryGroups,
  loadLibrary,
  parseAliases,
  rejectType,
  reopenType,
  roleOf,
  roleOfCategory,
  sourceLine,
  updateType,
  type CopySource,
  type IdScheme,
  type LibraryAccessory,
  type LibraryCable,
  type LibraryGroup,
  type LibraryType,
  type LibraryView,
} from './model';
import { SectionScreen } from '../home/SectionScreen';
import { loadSuggestions, type Suggestion } from '../suggestions/model';
import { useReload } from '../sync/useReload';
import { SuggestionList, SuggestionsPane } from './SuggestionEditor';
import { Banner, Btn, Chip, PageHeader, PAGE_GUTTER, color, fieldStyles, font, radius, space } from '../ui';

/** One row of the virtualised list: a group's header, or a type. */
type Item = { kind: 'head'; group: LibraryGroup; total: LibraryGroup | null; collapsed: boolean } | { kind: 'type'; type: LibraryType };

type Pane = { kind: 'type'; id: string } | { kind: 'new' } | { kind: 'copy' } | { kind: 'suggestions' } | null;
/** Run an edit; `done` is the line shown after it (a function to word it from what the edit did). */
type RunFn = (fn: (e: Editor, s: Store) => Promise<unknown>, done?: string | (() => string)) => Promise<boolean>;

/**
 * Device-type library (T48, Phase 3 §10): the type list on the left (by category, drafts
 * flagged), the selected type's editor on the right — model, category, aliases, ID scheme,
 * default cables (the rules offer them to every device of an accepted type, R2g), optional
 * cables and accessories, Accept / Reject — plus "+ New type" and "Copy from…". `scope` is the
 * project id, or null for the app library (T61, D65): then `editor` writes to the library stream
 * (`/library/ops`, D184). A project's accepted types can be promoted with `libraryEditor`.
 * At catalogue size (T114, about 1100 types after the DaVinci import) the list has a search box
 * (model, alias, display name), a group chip filter, "Drafts only", the accessories folded,
 * and "Accept all drafts in <group>" on each group header. Suggestion chips (T99, D174): a type's
 * on its editor beside the default cables, a category's and a cable code's under "Suggestions…".
 */
export function LibraryScreen(props: {
  store: Store | null;
  editor: Editor | null;
  /** Writes to the app library's stream (Promote); null where promotion is not offered. */
  libraryEditor: Editor | null;
  scope: string | null;
  /** Opens Needs review for this library's conflicts. */
  onOpenReview?: () => void;
  /** Changes when a pull brought new ops for this library (reload; `projectDataKey`). */
  dataKey: string;
  names: ReadonlyMap<string, string>;
  /** The app library (T190 moves it onto the shell): its way out, left of the header's buttons. */
  header?: React.ReactNode;
  /** A project's library: on the shell with the rail and the bar (D280, T189). */
  shell?: boolean;
}) {
  const { store, editor, scope } = props;
  const [view, setView] = useState<LibraryView | null>(null);
  const [chips, setChips] = useState<Suggestion[]>([]);
  const [pane, setPane] = useState<Pane>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  // T186: a pull during a load no longer throws it away (useReload)
  useReload({
    name: 'library',
    subject: store ? (scope ?? 'app') : null,
    reloadKey: `${tick}|${props.dataKey}`,
    load: () => Promise.all([loadLibrary(store!, scope), loadSuggestions(store!, scope)]),
    apply: ([v, c]) => {
      setView(v);
      setChips(c);
    },
    fail: (e) => setNote({ text: String(e), error: true }),
  });

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

  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [draftsOnly, setDraftsOnly] = useState(false);
  const [accessoriesOpen, setAccessoriesOpen] = useState(false);

  const types = useMemo(() => view?.types ?? [], [view]);
  const selected = pane?.kind === 'type' ? (types.find((t) => t.id === pane.id) ?? null) : null;
  const all = useMemo(() => libraryGroups(types), [types]);
  const filtered = !!query.trim() || draftsOnly;
  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    for (const g of libraryGroups(types, { query, group, draftsOnly })) {
      // the accessories stay folded unless asked for (their chip, a search, or the header)
      const collapsed = g.key === ACCESSORY_GROUP && !accessoriesOpen && !query.trim() && group !== ACCESSORY_GROUP;
      out.push({ kind: 'head', group: g, total: all.find((a) => a.key === g.key) ?? null, collapsed });
      if (!collapsed) for (const t of g.types) out.push({ kind: 'type', type: t });
    }
    return out;
  }, [types, all, query, group, draftsOnly, accessoriesOpen]);

  const acceptGroup = (g: LibraryGroup) => {
    const n = g.drafts;
    Alert.alert(`Accept all ${n} draft${n === 1 ? '' : 's'} in ${g.key}?`, 'Each accept is recorded under your name, the same as accepting them one by one. The search and Drafts only do not narrow this.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: `Accept ${n}`,
        onPress: () => {
          let done = 0;
          void run(async (e, s) => {
            done = await acceptAllDrafts(e, s, scope, g.key);
          }, () => `Accepted ${done} draft${done === 1 ? '' : 's'} in ${g.key}.`);
        },
      },
    ]);
  };

  const title = `${scope ? 'Device-type library' : 'App device-type library'} (${types.filter((t) => t.state !== 'rejected').length} types${view?.drafts ? ` · ${view.drafts} draft${view.drafts === 1 ? '' : 's'}` : ''})`;
  const intro = scope ? "This project's device types: what the plan offers and what the rules key on." : 'What every new project copies: the accepted types and their suggestion chips.';
  const actions = (
          <>
            {props.header}
            {view?.inReview && props.onOpenReview ? <Btn kind="tertiary" title={`${view.inReview} in review ▸`} onPress={props.onOpenReview} testID="library.review" /> : null}
            <Btn title="Suggestions…" onPress={() => setPane({ kind: 'suggestions' })} testID="library.suggestions" />
            <Btn title="Copy from…" disabled={!editor} onPress={() => setPane({ kind: 'copy' })} testID="library.copy" />
            <Btn kind="primary" title="+ New type" disabled={!editor} onPress={() => setPane({ kind: 'new' })} testID="library.new" />
          </>
  );
  const body = (
    <>
      {note ? <Banner tone={note.error ? 'danger' : 'success'} text={note.text} testID="library.note" style={styles.note} /> : null}
      <View style={styles.split}>
        <View style={styles.list}>
          <View style={styles.filters}>
            <View style={styles.row}>
              <TextInput value={query} onChangeText={setQuery} placeholder="Search model, alias or name" testID="library.search" placeholderTextColor={color.text3} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={[styles.input, styles.grow]} />
              <Text style={styles.sub}>Drafts only</Text>
              <Switch value={draftsOnly} onValueChange={setDraftsOnly} trackColor={{ true: color.primary }} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.wrapLine} keyboardShouldPersistTaps="handled">
              {[null, ...all.map((g) => g.key)].map((k) => (
                <Chip
                  key={k ?? 'all'}
                  small
                  selected={group === k}
                  onPress={() => setGroup(group === k ? null : k)}
                  label={`${k ?? 'All'} (${k ? (all.find((g) => g.key === k)?.types.length ?? 0) : types.length})`}
                />
              ))}
            </ScrollView>
          </View>
          <FlatList
            data={items}
            keyExtractor={(it) => (it.kind === 'head' ? `h:${it.group.key}` : it.type.id)}
            contentContainerStyle={styles.listBody}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={30}
            windowSize={11}
            renderItem={({ item }) =>
              item.kind === 'head' ? (
                <GroupHead item={item} filtered={filtered} canEdit={!!editor} onToggle={item.group.key === ACCESSORY_GROUP ? () => setAccessoriesOpen(!accessoriesOpen) : undefined} onAcceptAll={acceptGroup} />
              ) : (
                <TypeRow t={item.type} on={selected?.id === item.type.id} names={props.names} onPress={() => setPane({ kind: 'type', id: item.type.id })} />
              )
            }
            ListEmptyComponent={
              view ? (
                <Text style={styles.sub}>
                  {types.length
                    ? 'Nothing matches the search and filters.'
                    : scope
                      ? 'No device types yet. Add one, or copy them from another project or the app library.'
                      : "The app library is empty. New projects copy its accepted types; add one, copy from a project, or promote a project's type."}
                </Text>
              ) : null
            }
          />
        </View>
        {selected && pane?.kind === 'type' ? (
          <View style={styles.pane}>
            <TypeEditor
              key={editorStamp(selected)}
              type={selected}
              chips={chips.filter((c) => c.scope === 'type' && c.ref === selected.id)}
              codes={view?.codes ?? CABLE_CODES}
              scope={scope}
              canEdit={!!editor}
              run={run}
              libraryEditor={props.libraryEditor}
            />
          </View>
        ) : (
          <ScrollView style={styles.pane} contentContainerStyle={styles.paneBody} keyboardShouldPersistTaps="handled">
            {pane?.kind === 'new' ? (
              <NewType scope={scope} run={run} onCreated={(id) => setPane({ kind: 'type', id })} />
            ) : pane?.kind === 'copy' && store ? (
              <CopyFrom store={store} scope={scope} run={run} onDone={() => setPane(null)} />
            ) : pane?.kind === 'suggestions' ? (
              <SuggestionsPane rows={chips} codes={view?.codes ?? CABLE_CODES} noPartCodes={view?.noPartCodes ?? []} library={scope} canEdit={!!editor} run={run} libraryEditor={props.libraryEditor} />
            ) : (
              <Text style={styles.sub}>Pick a type to see and edit it.</Text>
            )}
          </ScrollView>
        )}
      </View>
    </>
  );
  if (props.shell) {
    return (
      <SectionScreen section="Library" projectId={scope} title={title} intro={intro} backTestID="library.back" actions={actions}>
        {body}
      </SectionScreen>
    );
  }
  return (
    <View style={styles.root}>
      <PageHeader title={title} caption={intro} actions={actions} />
      {body}
    </View>
  );
}

/** A group's header: name, counts, "Accept all" (the whole group, not just what the search shows). */
function GroupHead(props: { item: Extract<Item, { kind: 'head' }>; filtered: boolean; canEdit: boolean; onToggle?: () => void; onAcceptAll: (g: LibraryGroup) => void }) {
  const { group, total, collapsed } = props.item;
  const whole = total ?? group;
  const count = props.filtered && group.types.length !== whole.types.length ? `${group.types.length} of ${whole.types.length}` : `${whole.types.length}`;
  return (
    <View style={[styles.row, styles.groupHead]}>
      <Pressable disabled={!props.onToggle} onPress={props.onToggle} style={styles.grow}>
        <Text style={styles.groupTitle}>
          {props.onToggle ? (collapsed ? '▸ ' : '▾ ') : ''}
          {group.key} <Text style={styles.sub}>({count}{whole.drafts ? ` · ${whole.drafts} draft${whole.drafts === 1 ? '' : 's'}` : ''})</Text>
        </Text>
      </Pressable>
      {props.canEdit && whole.drafts > 0 && group.key !== REJECTED_GROUP ? (
        <Pressable onPress={() => props.onAcceptAll(whole)} hitSlop={space.md}>
          <Text style={styles.linkSmall}>Accept all {whole.drafts}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TypeRow(props: { t: LibraryType; on: boolean; names: ReadonlyMap<string, string>; onPress: () => void }) {
  const { t } = props;
  return (
    <Pressable onPress={props.onPress} style={[styles.typeRow, props.on && styles.typeRowOn]} testID="library.type">
      <Text style={[styles.typeModel, t.state === 'rejected' && styles.dim]} numberOfLines={1}>
        {t.state === 'draft' ? <Text style={styles.draft}>DRAFT </Text> : null}
        {t.state === 'rejected' ? <Text style={styles.dim}>rejected </Text> : null}
        {t.model}
        {t.aliases.length ? <Text style={styles.sub}> · {t.aliases.join(' · ')}</Text> : null}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {t.sourceRef?.displayName && t.sourceRef.displayName !== t.model ? `${t.sourceRef.displayName} · ` : ''}
        {t.devices} device{t.devices === 1 ? '' : 's'}
        {t.state === 'draft' ? ` · added by ${nameOf(props.names, t.createdById)}${t.createdAt ? ` ${shortDate(t.createdAt)}` : ''} ⚑` : ''}
      </Text>
    </Pressable>
  );
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
      <TextInput value={model} onChangeText={setModel} placeholder="Model (as the BOM spells it)" placeholderTextColor={color.text3} style={styles.input} autoFocus testID="library.new.model" />
      <Chips options={CATEGORIES} value={category} onPick={setCategory} testID="library.new.category" />
      <Btn
        kind="primary"
        title="Add draft"
        disabled={!model.trim()}
        onPress={() => {
          let id = '';
          void props
            .run(async (e, s) => {
              id = await createType(e, s, props.scope, { model, category });
            }, `Added ${model.trim()} as a draft.`)
            .then((ok) => ok && props.onCreated(id));
        }}
        testID="library.new.add"
      />
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
          <Chip
            key={s.id ?? 'app'}
            selected={from === s.id}
            label={`${s.name} (${s.types.length})`}
            onPress={() => {
              setFrom(s.id);
              setPicked(new Set());
            }}
            testID={`library.copy.source.${s.name}`}
          />
        ))}
      </View>
      {source ? (
        <>
          <Btn kind="tertiary" small title={picked.size === source.types.length ? 'Untick all' : `Tick all ${source.types.length}`} onPress={() => setPicked(picked.size === source.types.length ? new Set() : new Set(source.types.map((t) => t.id)))} />
          {source.types.map((t) => (
            <Pressable key={t.id} onPress={() => setPicked(toggle(picked, t.id))} style={[styles.row, styles.tickRow]} testID={`library.copy.type.${t.model}`}>
              <Text style={styles.check}>{picked.has(t.id) ? '☑' : '☐'}</Text>
              <Text style={[styles.value, styles.grow]}>
                {t.model} <Text style={styles.sub}>{t.category ?? ''}{t.defaultCables.length ? ` · ${t.defaultCables.map((c) => c.code).join(', ')}` : ''}</Text>
              </Text>
            </Pressable>
          ))}
          <Btn
            kind="primary"
            title={`Copy ${picked.size || ''}`}
            disabled={!picked.size}
            onPress={() => {
              let msg = '';
              void props.run(async (e, s) => {
                const out = await copyTypes(e, s, props.scope, [...picked]);
                msg = `Copied ${out.copied} type${out.copied === 1 ? '' : 's'}${out.skipped.length ? `; already here: ${out.skipped.join(', ')}` : ''}.`;
              }, () => msg).then((ok) => ok && props.onDone());
            }}
            testID="library.copy.go"
          />
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
function TypeEditor(props: { type: LibraryType; chips: Suggestion[]; codes: readonly string[]; scope: string | null; canEdit: boolean; run: RunFn; libraryEditor: Editor | null }) {
  const t = props.type;
  const [model, setModel] = useState(t.model);
  const [category, setCategory] = useState<string | null>(t.category);
  const [role, setRole] = useState<Role | null>(t.role);
  const [aliases, setAliases] = useState(t.aliases.join(', '));
  const [scheme, setScheme] = useState<IdScheme | null>(t.idScheme);
  const [neuron, setNeuron] = useState<boolean | null>(t.needsNeuronId);
  const [ip, setIp] = useState<boolean | null>(t.needsIpAddress);
  const [dmx, setDmx] = useState<boolean | null>(t.needsDmxAddress);
  const [defaults, setDefaults] = useState<LibraryCable[]>(t.defaultCables);
  const [optional, setOptional] = useState<LibraryCable[]>(t.optionalCables);
  const [accessories, setAccessories] = useState<LibraryAccessory[]>(t.optionalAccessories);
  const dirty =
    model !== t.model ||
    category !== t.category ||
    role !== t.role ||
    aliases !== t.aliases.join(', ') ||
    scheme !== t.idScheme ||
    neuron !== t.needsNeuronId ||
    ip !== t.needsIpAddress ||
    dmx !== t.needsDmxAddress ||
    JSON.stringify(defaults) !== JSON.stringify(t.defaultCables) ||
    JSON.stringify(optional) !== JSON.stringify(t.optionalCables) ||
    JSON.stringify(accessories) !== JSON.stringify(t.optionalAccessories);
  const save = () =>
    props.run(
      (e, s) => updateType(e, s, t.id, { model, category, role, aliases: parseAliases(aliases), idScheme: scheme, needsNeuronId: neuron, needsIpAddress: ip, needsDmxAddress: dmx, defaultCables: defaults, optionalCables: optional, optionalAccessories: accessories }),
      'Saved.',
    );
  const ro = !props.canEdit;
  return (
    <View style={styles.grow}>
      <ScrollView style={styles.grow} contentContainerStyle={styles.paneBody} keyboardShouldPersistTaps="handled">
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
          {t.sourceRef || t.description || t.accessoryOnly ? (
            <View style={styles.source}>
              {t.sourceRef ? <Text style={styles.sub}>From {sourceLine(t.sourceRef)}{t.sourceRef.libraryTimestamp ? ` (library ${t.sourceRef.libraryTimestamp.slice(0, 10)})` : ''}</Text> : null}
              {t.description ? <Text style={styles.desc}>{t.description}</Text> : null}
              {t.accessoryOnly ? <Text style={styles.sub}>Accessory only: listed as other types' accessory, never offered as a device.</Text> : null}
              {t.datasheetUrl ? (
                <Pressable onPress={() => void Linking.openURL(t.datasheetUrl!)} hitSlop={space.md} style={styles.self}>
                  <Text style={styles.link}>Datasheet ↗</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <Field label="Model">
            <TextInput value={model} onChangeText={setModel} editable={!ro} style={[styles.input, ro && fieldStyles.off]} />
          </Field>
          <Field label="Category">
            <Chips options={CATEGORIES} value={category} onPick={ro ? undefined : setCategory} testID="library.category" />
          </Field>
          <Field label="Role" hint="What its devices are to the rules, the ID scheme, the Punch List Device text and the pin shape (T112). Category default = the role the category names, if any.">
            <View style={styles.wrap}>
              {([null, ...ROLES] as const).map((v) => (
                <Chip
                  key={v ?? 'default'}
                  disabled={ro}
                  onPress={() => setRole(v)}
                  selected={role === v}
                  label={v === null ? `Category default (${ROLE_LABELS[roleOfCategory(category)]})` : ROLE_LABELS[v]}
                  testID={`library.role.${v ?? 'default'}`}
                />
              ))}
            </View>
          </Field>
          <Field label="Aliases (BOM)" hint="Comma-separated. A device whose Device text is the model or an alias is of this type.">
            <TextInput value={aliases} onChangeText={setAliases} editable={!ro} testID="library.aliases" placeholder="P-NSPS-D, P-NSPS-D-KIT" placeholderTextColor={color.text3} style={[styles.input, ro && fieldStyles.off]} />
          </Field>
          <Field label="ID scheme" hint="Level-number: 06M-04. Level-tag: 06M-S16 for stations, 06M-D3 for sensors. The server assigns the ID either way.">
            <View style={styles.wrap}>
              {([null, 'level_number', 'level_tag'] as const).map((v) => (
                <Chip
                  key={v ?? 'default'}
                  disabled={ro}
                  onPress={() => setScheme(v)}
                  selected={scheme === v}
                  label={v === null ? 'Category default' : v === 'level_number' ? 'Level-number' : 'Level-tag (S/D)'}
                  testID={`library.scheme.${v ?? 'default'}`}
                />
              ))}
            </View>
          </Field>
          {/* T146 (D245): what the type's devices need; null = by the wires they get (U → Neuron ID, N / NG → IP address, X → DMX address). */}
          {(
            [
              ['Neuron ID', neuron, setNeuron, 'neuron', 'A Unison (U) run needs one; stations and sensors ride the bus; an NSPS or rack hosts it and needs none. Needed / Not needed overrides the wires: the card hides the section and the device leaves its floor’s “Missing all / some Device Neuron IDs” item and the dashboard count.'],
              ['IP address', ip, setIp, 'ip', 'A network (N, NG) run needs one. Needed / Not needed overrides the wires; the device leaves its floor’s “Missing all / some Device IP addresses” item when not needed.'],
              ['DMX address', dmx, setDmx, 'dmx', 'A DMX (X) run needs one. Needed / Not needed overrides the wires; the device leaves its floor’s “Missing all / some Device DMX addresses” item when not needed.'],
            ] as const
          ).map(([label, value, set, key, hint]) => (
            <Field key={label} label={label} hint={hint}>
              <View style={styles.wrap}>
                {([null, true, false] as const).map((v) => (
                  <Chip
                    key={String(v)}
                    disabled={ro}
                    onPress={() => set(v)}
                    selected={value === v}
                    label={v === null ? 'By the wires' : v ? 'Needed' : 'Not needed'}
                    testID={`library.${key}.${v === null ? 'wires' : v ? 'needed' : 'not'}`}
                  />
                ))}
              </View>
            </Field>
          ))}
          <Field
            label="Default cables (always generated)"
            hint="Once the type is accepted, the rules offer each run as a draft to every device of this type that lacks it, instead of the category's (R2c / R2d). Unison (U) stays one bus per level (R2e).">
            <CableList list={defaults} codes={props.codes} onChange={ro ? undefined : setDefaults} testID="library.defaults" />
          </Field>
          <Field
            label="Suggestions"
            hint="Chips offered for this type's devices, before its category's and the project's (D174): under Notes, under an end's Note, for a punch item or a part. Saved as you add them; copied and promoted with the type (a chip added after the promotion has its own Promote).">
            <SuggestionList rows={props.chips} scope="type" refKey={t.id} library={props.scope} canEdit={props.canEdit} run={props.run} libraryEditor={t.promotedAs ? props.libraryEditor : null} />
          </Field>
          <Field label="Optional cables" hint="Kept with the type; not generated.">
            <CableList list={optional} codes={props.codes} onChange={ro ? undefined : setOptional} testID="library.optional" />
          </Field>
          <Field label="Optional accessories">
            {accessories.map((a, i) => (
              <View key={i} style={styles.row}>
                <TextInput value={a.model} editable={!ro} onChangeText={(v) => setAccessories(replace(accessories, i, { ...a, model: v }))} placeholder="Model" placeholderTextColor={color.text3} style={[styles.input, styles.grow]} testID={`library.acc.${i}.model`} />
                <Text style={styles.sub}>expected</Text>
                <TextInput value={a.expected_qty == null ? '' : String(a.expected_qty)} editable={!ro} onChangeText={(v) => setAccessories(replace(accessories, i, { ...a, expected_qty: toQty(v) }))} keyboardType="number-pad" style={[styles.input, styles.qty]} testID={`library.acc.${i}.qty`} />
                {!ro ? (
                  <Pressable onPress={() => setAccessories(accessories.filter((_, j) => j !== i))} hitSlop={space.md}>
                    <Text style={styles.danger}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {!ro ? (
              <View style={styles.wrap}>
                <Pressable onPress={() => setAccessories([...accessories, { model: '', expected_qty: 1 }])} hitSlop={space.md} testID="library.acc.add">
                  <Text style={styles.link}>+ add</Text>
                </Pressable>
                {roleOf({ role, category }, null) === 'nsps' && !accessories.some((a) => a.model === NSPS_POWER_SUPPLY.model) ? (
                  <Pressable onPress={() => setAccessories([...accessories, NSPS_POWER_SUPPLY])} hitSlop={space.md} testID="library.acc.nsps">
                    <Text style={styles.link}>+ {NSPS_POWER_SUPPLY.model} (expected 1, D52)</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </Field>
          <Text style={styles.sub}>Rules that reference this type: {t.rules.length ? t.rules.join(', ') : 'none'}</Text>
        </View>
      </ScrollView>
      {props.canEdit ? (
        <View style={[styles.actions, styles.footer]}>
          <Btn kind={dirty ? 'primary' : 'secondary'} title="Save" disabled={!dirty} onPress={() => void save()} testID="library.save" />
          {t.state === 'draft' ? (
            <>
              <Btn
                kind="primary"
                title="Accept draft"
                disabled={dirty}
                onPress={() =>
                  void props.run(
                    (e) => acceptType(e, t.id),
                    t.defaultCables.length ? `Accepted. The rules will offer its default cables to ${t.devices} device${t.devices === 1 ? '' : 's'} as drafts.` : 'Accepted.',
                  )
                }
                testID="library.accept"
              />
              <Pressable onPress={() => void props.run((e) => rejectType(e, t.id), 'Rejected: the type leaves the pickers; its devices keep it.')} hitSlop={space.md} testID="library.reject">
                <Text style={styles.danger}>Reject</Text>
              </Pressable>
            </>
          ) : (
            <Btn kind="tertiary" title="Back to draft" onPress={() => void props.run((e) => reopenType(e, t.id), 'Back to draft.')} testID="library.reopen" />
          )}
          {t.projectId && t.state === 'accepted' && props.libraryEditor ? (
            t.promotedAs ? (
              <Text style={styles.sub}>In the app library ✓</Text>
            ) : (
              <Btn
                kind="tertiary"
                title="Promote to app library"
                disabled={dirty}
                onPress={() => {
                  const lib = props.libraryEditor!;
                  void props.run((_e, s) => promoteType(lib, s, t.id), `Promoted: ${t.model} is in the app library; new projects copy it.`);
                }}
                testID="library.promote"
              />
            )
          ) : null}
          {dirty ? <Text style={styles.sub}>{t.state === 'draft' ? 'Unsaved changes: save before accepting.' : 'Unsaved changes.'}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function CableList(props: { list: LibraryCable[]; codes: readonly string[]; onChange?: (list: LibraryCable[]) => void; testID: string }) {
  const { list, codes, onChange, testID: tid } = props;
  if (!onChange) return list.length ? <>{list.map((c, i) => <Text key={i} style={styles.value}>{describeCable(c)}</Text>)}</> : <Text style={styles.sub}>None.</Text>;
  return (
    <View style={styles.cables}>
      {list.map((c, i) => {
        const set = (patch: Partial<LibraryCable>) => onChange(replace(list, i, { ...c, ...patch }));
        return (
          <View key={i} style={styles.cable}>
            <View style={styles.wrap}>
              {codes.map((code) => (
                <Chip key={code} small onPress={() => set({ code })} selected={c.code === code} label={code} testID={`${tid}.${i}.code.${code}`} />
              ))}
            </View>
            <LabeledInput label="From" value={c.from ?? ''} onChange={(v) => set({ from: v })} placeholder="empty = the device's name" testID={`${tid}.${i}.from`} />
            <LabeledInput label="To" value={c.to ?? ''} onChange={(v) => set({ to: v })} placeholder="e.g. P-NSPS-D Power Supply" testID={`${tid}.${i}.to`} />
            <LabeledInput label="Far end" value={c.far ?? ''} onChange={(v) => set({ far: v })} placeholder="a placeholder, e.g. 120v Power" testID={`${tid}.${i}.far`} />
            <View style={styles.row}>
              <Text style={styles.sub}>Single row</Text>
              <Switch value={c.single_row} onValueChange={(v) => set({ single_row: v })} trackColor={{ true: color.primary }} testID={`${tid}.${i}.single`} />
              <Text style={styles.sub}>Qty</Text>
              <TextInput value={c.qty == null ? '' : String(c.qty)} onChangeText={(v) => set({ qty: toQty(v) })} placeholder="—" placeholderTextColor={color.text3} keyboardType="number-pad" style={[styles.input, styles.qty]} />
              <View style={styles.grow} />
              <Pressable onPress={() => onChange(list.filter((_, j) => j !== i))} hitSlop={space.md}>
                <Text style={styles.danger}>Remove</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      <Pressable onPress={() => onChange([...list, blankCable()])} hitSlop={space.md} style={styles.self} testID={`${tid}.add`}>
        <Text style={styles.link}>+ add cable</Text>
      </Pressable>
    </View>
  );
}

function LabeledInput(props: { label: string; value: string; onChange: (v: string) => void; placeholder: string; testID?: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.sub, styles.inputLabel]}>{props.label}</Text>
      <TextInput value={props.value} onChangeText={props.onChange} placeholder={props.placeholder} placeholderTextColor={color.text3} style={[styles.input, styles.grow]} testID={props.testID} />
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

function Chips(props: { options: readonly string[]; value: string | null; onPick?: (v: string | null) => void; testID?: string }) {
  return (
    <View style={styles.wrap}>
      {props.options.map((o) => (
        <Chip
          key={o}
          disabled={!props.onPick}
          onPress={() => props.onPick?.(props.value === o ? null : o)}
          selected={props.value === o}
          label={o}
          testID={props.testID ? `${props.testID}.${o}` : undefined}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  link: { ...font.callout, color: color.primary },
  source: { gap: 2, paddingBottom: 6 },
  desc: { ...font.callout, color: color.text2 },
  danger: { ...font.calloutBold, color: color.danger },
  note: { marginHorizontal: PAGE_GUTTER, marginTop: space.sm },
  split: {
    flex: 1,
    flexDirection: 'row',
    marginHorizontal: PAGE_GUTTER,
    marginTop: space.md,
    marginBottom: space.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  // the list keeps a third of the screen at most, so the editor gets the rest (T125)
  list: { width: '34%', maxWidth: 380, borderRightWidth: 1, borderRightColor: color.hairline },
  listBody: { paddingHorizontal: space.md, paddingBottom: space.lg, gap: 2 },
  filters: { paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 6, gap: 6, borderBottomWidth: 1, borderBottomColor: color.hairline },
  wrapLine: { flexDirection: 'row', gap: space.sm, alignItems: 'center', paddingVertical: 6 },
  groupHead: { paddingTop: space.md },
  linkSmall: { ...font.captionBold, color: color.primary },
  pane: { flex: 1 },
  paneBody: { padding: 20, gap: space.lg },
  groupTitle: { ...font.calloutBold, color: color.text2 },
  typeRow: { paddingVertical: space.sm, paddingHorizontal: 10, borderRadius: radius.control, minHeight: 44 },
  typeRowOn: { backgroundColor: color.primaryTint },
  typeModel: { ...font.body, color: color.text },
  dim: { color: color.text3 },
  section: { gap: space.md },
  sectionTitle: { ...font.title, color: color.text },
  field: { gap: 6 },
  label: { ...font.captionBold, color: color.text2 },
  sub: { ...font.caption, color: color.text3, fontWeight: '400' },
  draft: { ...font.badge, color: color.warning },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: space.xs },
  tickRow: { minHeight: 44 },
  grow: { flex: 1 },
  self: { alignSelf: 'flex-start' },
  value: { ...font.body, color: color.text },
  check: { fontSize: 22, color: color.text2 },
  input: fieldStyles.input,
  qty: { width: 64, textAlign: 'center' },
  cables: { gap: 10 },
  cable: { gap: 6, padding: 10, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, backgroundColor: color.bg },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.lg, paddingTop: space.sm },
  footer: { paddingHorizontal: 20, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: color.hairline, backgroundColor: color.surface },
  inputLabel: { width: 64 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
});