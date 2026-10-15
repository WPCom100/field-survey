import { vocab, type Store } from '@field-survey/core';
import {
  ACTION_LABEL,
  ENTITY_LABEL,
  FILTER_OPS,
  OP_LABEL,
  RULING_ENTITIES,
  UNARY_OPS,
  actionFields,
  actionsFor,
  checkRuling,
  fieldOf,
  RULING_FIELDS,
  type Condition,
  type RulingDraft,
  type RulingField,
  type RulingPreview,
} from '@field-survey/rules';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { logTo } from '../log';
import { bumpRulesVersion, engineFor } from '../rules/engine';
import { useRulesVersion } from '../rules/useRulesVersion';
import { takeRuling } from '../rulings/handoff';
import {
  addCondition,
  copyOf,
  emptyDraft,
  loadRulingProposals,
  loadRulings,
  previewFooter,
  previewTitle,
  removeCondition,
  toggleLevel,
  withActionKind,
  withCondition,
  withEntity,
  type RulingListRow,
  type RulingProposalRow,
  type RulingsView,
} from '../rulings/model';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';

type Mode = { kind: 'idle' } | { kind: 'edit'; draft: RulingDraft; source: string | null } | { kind: 'preview'; draft: RulingDraft; preview: RulingPreview; skip: ReadonlySet<string>; back: 'edit' | 'detail' } | { kind: 'detail'; id: string };

/**
 * Rulings (T37, Phase 3 §8, PLAN §6.4). Left: the project's rulings (standing · applied, op
 * count, open proposals). Right: the editor (reason, level scope, entity + conditions, action:
 * set / rename phrase / append note / generate item, standing), the preview (Level · Ref · Field ·
 * Was → Now, untick to skip, Apply n), or a stored ruling (standing on/off, its open proposals
 * with Accept / Reject, Preview again, Copy, Delete…). The Lint view's "Fix all via ruling" and
 * the plan lists' "Apply as ruling…" open it pre-filled (`?from=handoff`).
 */
export default function RulingsScreen() {
  const params = useLocalSearchParams<{ project?: string; from?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const dataKey = syncDataKey(sync);
  const rulesKey = useRulesVersion();
  const [store, setStore] = useState<Store | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<RulingsView | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        setProjectId(pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setNote(String(e)),
    );
  }, [params.project]);
  useFocusEffect(useCallback(() => setTick((n) => n + 1), []));

  // A hand-off (lint seed, multi-selection) opens the editor pre-filled, once.
  useEffect(() => {
    if (!projectId || params.from !== 'handoff') return;
    const h = takeRuling(projectId);
    if (h) setMode({ kind: 'edit', draft: h.draft, source: h.source });
  }, [projectId, params.from]);

  useEffect(() => {
    if (!store || !projectId) return;
    let active = true;
    loadRulings(store, projectId).then(
      (v) => active && setView(v),
      (e: unknown) => active && setNote(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, projectId, tick, dataKey, rulesKey]);

  const engine = useMemo(() => (store && projectId ? engineFor(store, projectId, user.id) : null), [store, projectId, user.id]);
  const codes = useMemo(() => (view?.levels ?? []).map((l) => l.code), [view]);

  const preview = useCallback(
    (draft: RulingDraft, back: 'edit' | 'detail') => {
      if (!engine) return;
      setBusy(true);
      engine.previewRuling(draft).then(
        (p) => {
          setBusy(false);
          if (p.problems.length) setNote(p.problems.join(' '));
          else setMode({ kind: 'preview', draft, preview: p, skip: new Set(), back });
        },
        (e: unknown) => {
          setBusy(false);
          setNote(`Preview failed: ${String((e as Error)?.message ?? e)}`);
        },
      );
    },
    [engine],
  );

  const apply = useCallback(
    (draft: RulingDraft, skip: ReadonlySet<string>) => {
      if (!engine) return;
      setBusy(true);
      engine.applyRuling(draft, { skip }).then(
        (r) => {
          setBusy(false);
          logTo('rules', 'info', 'ruling_applied', { ruling: r.rulingId, records: r.records, skipped: r.skipped });
          setNote(`Applied "${draft.text.trim()}": ${r.records} change${r.records === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} unticked` : ''}.`);
          setMode({ kind: 'detail', id: r.rulingId });
          bumpRulesVersion();
          setTick((n) => n + 1);
        },
        (e: unknown) => {
          setBusy(false);
          setNote(`Not applied: ${String((e as Error)?.message ?? e)}`);
        },
      );
    },
    [engine],
  );

  const selected = mode.kind === 'detail' ? (view?.rows.find((r) => r.id === mode.id) ?? null) : null;
  const title = view ? `Rulings (${view.standing} standing · ${view.applied} applied)` : 'Rulings';

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <Link href={projectId ? { pathname: '/', params: { project: projectId } } : '/'} style={styles.link}>
          ← Levels
        </Link>
        <View style={{ flex: 1 }} />
        <Btn label="+ New ruling" onPress={() => setMode({ kind: 'edit', draft: emptyDraft(), source: null })} disabled={!engine} />
      </View>
      <View style={styles.body}>
        <FlatList
          style={styles.list}
          data={view?.rows ?? []}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <Pressable onPress={() => setMode({ kind: 'detail', id: item.id })} style={[styles.row, mode.kind === 'detail' && mode.id === item.id && styles.rowOn]}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {item.standing ? '● ' : '○ '}
                {item.text}
              </Text>
              <Text style={styles.rowSub} numberOfLines={2}>
                {item.standing ? 'standing' : 'one-off'} · {item.opCount} change{item.opCount === 1 ? '' : 's'}
                {item.open ? ` · ${item.open} proposed` : ''}
                {item.appliedAt ? '' : ' · not applied here'}
              </Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>{view ? 'No rulings yet. A ruling applies one decision to every record that matches it.' : 'Loading…'}</Text>}
        />
        <View style={styles.panel}>
          {mode.kind === 'preview' ? (
            <PreviewPanel
              mode={mode}
              busy={busy}
              onToggle={(key) =>
                setMode((m) => {
                  if (m.kind !== 'preview') return m;
                  const skip = new Set(m.skip);
                  if (skip.has(key)) skip.delete(key);
                  else skip.add(key);
                  return { ...m, skip };
                })
              }
              onAll={(on) => setMode((m) => (m.kind === 'preview' ? { ...m, skip: on ? new Set() : new Set(m.preview.rows.map((r) => r.key)) } : m))}
              onApply={() => apply(mode.draft, mode.skip)}
              onBack={() => setMode(mode.back === 'edit' ? { kind: 'edit', draft: mode.draft, source: null } : { kind: 'detail', id: mode.draft.id ?? '' })}
            />
          ) : (
            <ScrollView contentContainerStyle={styles.panelBody}>
              {mode.kind === 'edit' ? (
                <EditorPanel
                  draft={mode.draft}
                  source={mode.source}
                  codes={codes}
                  busy={busy}
                  onChange={(draft) => setMode({ kind: 'edit', draft, source: mode.source })}
                  onPreview={() => preview(mode.draft, 'edit')}
                  onCancel={() => setMode({ kind: 'idle' })}
                />
              ) : selected && store && projectId && engine ? (
                <DetailPanel
                  row={selected}
                  store={store}
                  projectId={projectId}
                  reload={`${tick}|${rulesKey}|${dataKey}`}
                  onStanding={(on) =>
                    engine.setRulingStanding(selected.id, on).then(
                      () => {
                        setNote(on ? 'Standing: future matches are proposed.' : 'No longer standing: its open proposals are withdrawn.');
                        bumpRulesVersion();
                        setTick((n) => n + 1);
                      },
                      (e: unknown) => setNote(String((e as Error)?.message ?? e)),
                    )
                  }
                  onDecide={(ids, kind) =>
                    (async () => {
                      for (const id of ids) await engine.decide(id, { kind });
                    })().then(
                      () => {
                        setNote(`${kind === 'accept' ? 'Accepted' : 'Rejected'} ${ids.length} proposal${ids.length === 1 ? '' : 's'}.`);
                        bumpRulesVersion();
                        setTick((n) => n + 1);
                      },
                      (e: unknown) => setNote(String((e as Error)?.message ?? e)),
                    )
                  }
                  onPreview={() => selected.draft && preview(selected.draft, 'detail')}
                  onCopy={() => selected.draft && setMode({ kind: 'edit', draft: copyOf(selected.draft), source: 'Copy' })}
                  onDelete={(reason) =>
                    engine.deleteRuling(selected.id, reason).then(
                      () => {
                        setNote(`Deleted "${selected.text}". What it changed stays.`);
                        setMode({ kind: 'idle' });
                        bumpRulesVersion();
                        setTick((n) => n + 1);
                      },
                      (e: unknown) => setNote(String((e as Error)?.message ?? e)),
                    )
                  }
                />
              ) : (
                <Text style={styles.empty}>Select a ruling, or + New ruling. From the Lint view, &quot;Fix all via ruling&quot;; from a level&apos;s lists, Select → &quot;Apply as ruling…&quot;.</Text>
              )}
              {note ? <Text style={styles.note}>{note}</Text> : null}
            </ScrollView>
          )}
        </View>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ editor

function EditorPanel({
  draft: d,
  source,
  codes,
  busy,
  onChange,
  onPreview,
  onCancel,
}: {
  draft: RulingDraft;
  source: string | null;
  codes: readonly string[];
  busy: boolean;
  onChange: (d: RulingDraft) => void;
  onPreview: () => void;
  onCancel: () => void;
}) {
  const problems = checkRuling(d);
  const entity = d.filter.entity;
  const a = d.action;
  const setAction = (patch: Record<string, unknown>) => onChange({ ...d, action: { ...a, ...patch } as RulingDraft['action'] });
  return (
    <>
      <Text style={styles.panelTitle}>New ruling{source ? ` · from ${source}` : ''}</Text>
      <Label text="Reason" />
      <TextInput style={styles.input} value={d.text} onChangeText={(text) => onChange({ ...d, text })} placeholder="0-10V rows read Fixtures (the Change Log's Reason)" />

      <Label text="Scope" />
      <View style={styles.wrap}>
        <Chip label="All levels" on={!d.scope_levels?.length} onPress={() => onChange({ ...d, scope_levels: null })} />
        {codes.map((c) => (
          <Chip key={c} label={c} on={!!d.scope_levels?.includes(c)} onPress={() => onChange(toggleLevel(d, c))} />
        ))}
      </View>

      <Label text="Where" />
      <View style={styles.wrap}>
        {RULING_ENTITIES.map((e) => (
          <Chip key={e} label={ENTITY_LABEL[e]} on={entity === e} onPress={() => onChange(withEntity(d, e))} />
        ))}
      </View>
      {d.filter.ids?.length ? (
        <View style={styles.wrap}>
          <Text style={styles.sub}>
            Only the {d.filter.ids.length} chosen record{d.filter.ids.length === 1 ? '' : 's'}
          </Text>
          <Pressable onPress={() => onChange({ ...d, filter: { ...d.filter, ids: null } })}>
            <Text style={styles.link}>Use the conditions instead</Text>
          </Pressable>
        </View>
      ) : null}
      {d.filter.where.map((c, i) => (
        <ConditionRow key={i} entity={entity} c={c} first={i === 0} onChange={(p) => onChange(withCondition(d, i, p))} onRemove={() => onChange(removeCondition(d, i))} />
      ))}
      <Pressable onPress={() => onChange(addCondition(d))}>
        <Text style={styles.link}>+ condition</Text>
      </Pressable>

      <Label text="Action" />
      <View style={styles.wrap}>
        {actionsFor(entity).map((k) => (
          <Chip key={k} label={ACTION_LABEL[k]} on={a.kind === k} onPress={() => onChange(withActionKind(d, k))} />
        ))}
      </View>
      {a.kind === 'item' ? (
        <View style={styles.block}>
          <TextInput style={styles.input} value={a.item} onChangeText={(item) => setAction({ item })} placeholder="Item text (short; qualifiers go in Notes)" />
          <View style={styles.wrap}>
            {vocab.PUNCH_TYPE.map((t) => (
              <Chip key={t} label={t} on={a.type === t} onPress={() => setAction({ type: t })} />
            ))}
          </View>
          <View style={styles.wrap}>
            {vocab.OWNER.map((o) => (
              <Chip key={o} label={o} on={a.owner === o} onPress={() => setAction({ owner: o })} />
            ))}
          </View>
          <TextInput style={styles.input} value={a.notes ?? ''} onChangeText={(notes) => setAction({ notes })} placeholder="Notes (optional)" />
        </View>
      ) : (
        <View style={styles.block}>
          <FieldChips fields={actionFields(entity, a.kind)} value={a.field} onPick={(field) => setAction({ field })} />
          {a.kind === 'set' ? (
            <ValueInput field={fieldOf(entity, a.field)} value={a.value} onChange={(value) => setAction({ value })} placeholder="New value" />
          ) : a.kind === 'rename' ? (
            <>
              <TextInput style={styles.input} value={a.from} onChangeText={(from) => setAction({ from })} placeholder="Old phrase (the whole value or one ; phrase)" />
              <TextInput style={styles.input} value={a.to} onChangeText={(to) => setAction({ to })} placeholder="New phrase" />
            </>
          ) : (
            <TextInput style={styles.input} value={a.text} onChangeText={(text) => setAction({ text })} placeholder="Phrase to append (once, after '; ')" />
          )}
        </View>
      )}

      <Chip label={`${d.standing ? '☑' : '☐'} Standing: propose on future matches`} on={d.standing} onPress={() => onChange({ ...d, standing: !d.standing })} />
      {problems.length ? (
        <View style={styles.problems}>
          {problems.map((p) => (
            <Text key={p} style={styles.problem}>
              • {p}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.btnRow}>
        <Btn label={busy ? 'Working…' : 'Preview ▸'} onPress={onPreview} disabled={busy || problems.length > 0} />
        <Btn label="Cancel" onPress={onCancel} secondary />
      </View>
    </>
  );
}

function ConditionRow({ entity, c, first, onChange, onRemove }: { entity: RulingDraft['filter']['entity']; c: Condition; first: boolean; onChange: (p: Partial<Condition>) => void; onRemove: () => void }) {
  const f = fieldOf(entity, c.field);
  return (
    <View style={styles.cond}>
      <View style={styles.condHead}>
        <Text style={styles.sub}>{first ? 'Where' : 'AND'}</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onRemove} accessibilityRole="button">
          <Text style={styles.link}>✕ remove</Text>
        </Pressable>
      </View>
      <FieldChips fields={RULING_FIELDS[entity]} value={c.field} onPick={(field) => onChange({ field })} />
      <View style={styles.wrap}>
        {FILTER_OPS.map((op) => (
          <Chip key={op} label={OP_LABEL[op]} on={c.op === op} onPress={() => onChange({ op })} small />
        ))}
      </View>
      {UNARY_OPS.has(c.op) ? null : (
        <ValueInput
          field={f}
          value={Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? '')}
          onChange={(value) => onChange({ value })}
          placeholder={c.op === 'in' ? 'Values, comma-separated' : 'Value'}
          append={c.op === 'in'}
        />
      )}
    </View>
  );
}

function FieldChips({ fields, value, onPick }: { fields: readonly RulingField[]; value: string; onPick: (field: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hscroll}>
      {fields.map((f) => (
        <Chip key={f.field} label={f.label} on={value === f.field} onPress={() => onPick(f.field)} small />
      ))}
    </ScrollView>
  );
}

function ValueInput({ field, value, onChange, placeholder, append }: { field: RulingField | null; value: string; onChange: (v: string) => void; placeholder: string; append?: boolean }) {
  return (
    <>
      {field?.strict ? null : <TextInput style={styles.input} value={value} onChangeText={onChange} placeholder={placeholder} autoCapitalize="none" />}
      {field?.options?.length ? (
        <View style={styles.wrap}>
          {field.options.map((o) => {
            const list = value.split(/\s*,\s*/).filter(Boolean);
            const on = append ? list.includes(o) : value === o;
            return <Chip key={o} label={o} on={on} small onPress={() => onChange(append ? (on ? list.filter((x) => x !== o) : [...list, o]).join(', ') : o)} />;
          })}
        </View>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ preview

function PreviewPanel({
  mode,
  busy,
  onToggle,
  onAll,
  onApply,
  onBack,
}: {
  mode: Extract<Mode, { kind: 'preview' }>;
  busy: boolean;
  onToggle: (key: string) => void;
  onAll: (on: boolean) => void;
  onApply: () => void;
  onBack: () => void;
}) {
  const p = mode.preview;
  const ticked = p.rows.filter((r) => !mode.skip.has(r.key)).length;
  return (
    <View style={styles.previewRoot}>
      <Text style={styles.panelTitle}>{mode.draft.text.trim()}</Text>
      <View style={styles.btnRow}>
        <Text style={styles.value}>{previewTitle(p, ticked)}</Text>
        <View style={{ flex: 1 }} />
        <Btn label={ticked === p.rows.length ? 'Untick all' : 'Tick all'} onPress={() => onAll(ticked !== p.rows.length)} secondary disabled={!p.rows.length} />
        <Btn label={busy ? 'Applying…' : `Apply ${ticked}`} onPress={onApply} disabled={busy || (!ticked && !!mode.draft.id) || (!ticked && !mode.draft.standing)} />
        <Btn label="Back" onPress={onBack} secondary />
      </View>
      <View style={[styles.tr, styles.th]}>
        <Text style={styles.cTick}> </Text>
        <Text style={styles.cLvl}>Lvl</Text>
        <Text style={styles.cRef}>Ref</Text>
        <Text style={styles.cField}>Field</Text>
        <Text style={styles.cVal}>Was</Text>
        <Text style={styles.cVal}>Now</Text>
      </View>
      <FlatList
        style={styles.table}
        data={p.rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => {
          const on = !mode.skip.has(item.key);
          return (
            <Pressable onPress={() => onToggle(item.key)} style={[styles.tr, !on && styles.trOff]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
              <Text style={styles.cTick}>{on ? '☑' : '☐'}</Text>
              <Text style={styles.cLvl}>{item.levelCode ?? '—'}</Text>
              <Text style={styles.cRef} numberOfLines={1}>
                {item.ref}
              </Text>
              <Text style={styles.cField}>{item.label}</Text>
              <Text style={styles.cVal} numberOfLines={2}>
                {item.was ?? '—'}
              </Text>
              <Text style={[styles.cVal, styles.now]} numberOfLines={2}>
                {item.now}
              </Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>Nothing to change: every matching record is already right.</Text>}
        ListFooterComponent={
          <View style={styles.footer}>
            {previewFooter(p, mode.draft).map((t) => (
              <Text key={t} style={styles.sub}>
                {t}
              </Text>
            ))}
          </View>
        }
      />
    </View>
  );
}

// ------------------------------------------------------------------ a stored ruling

function DetailPanel({
  row: r,
  store,
  projectId,
  reload,
  onStanding,
  onDecide,
  onPreview,
  onCopy,
  onDelete,
}: {
  row: RulingListRow;
  store: Store;
  projectId: string;
  reload: string;
  onStanding: (on: boolean) => void;
  onDecide: (ids: string[], kind: 'accept' | 'reject') => void;
  onPreview: () => void;
  onCopy: () => void;
  onDelete: (reason: string) => void;
}) {
  const [proposals, setProposals] = useState<RulingProposalRow[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setDeleting(false);
    setReason('');
  }, [r.id]);
  useEffect(() => {
    let active = true;
    loadRulingProposals(store, projectId, r.id).then(
      (p) => active && setProposals(p),
      () => active && setProposals([]),
    );
    return () => {
      active = false;
    };
  }, [store, projectId, r.id, reload]);
  return (
    <>
      <Text style={styles.panelTitle}>{r.text}</Text>
      <Text style={styles.value}>
        {r.filter} → {r.action}
      </Text>
      <Text style={styles.sub}>
        {r.scope} · {r.opCount} change{r.opCount === 1 ? '' : 's'}
        {r.appliedAt ? ` · applied ${r.appliedAt.slice(0, 16).replace('T', ' ')}` : ' · not applied on this project (copied)'}
        {r.createdBy ? ` · by ${r.createdBy}` : ''}
      </Text>
      <Chip label={`${r.standing ? '☑' : '☐'} Standing: propose on future matches`} on={r.standing} onPress={() => onStanding(!r.standing)} />
      <View style={styles.btnRow}>
        <Btn label="Preview again ▸" onPress={onPreview} disabled={!r.draft} />
        <Btn label="Copy as new" onPress={onCopy} disabled={!r.draft} secondary />
        <Btn label="Delete…" onPress={() => setDeleting(true)} secondary disabled={deleting} />
      </View>
      {deleting ? (
        <View style={styles.block}>
          <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="Why delete it? (what it changed stays)" />
          <View style={styles.btnRow}>
            <Btn label="Delete" onPress={() => onDelete(reason)} disabled={!reason.trim()} />
            <Btn label="Cancel" onPress={() => setDeleting(false)} secondary />
          </View>
        </View>
      ) : null}
      <Label text={`Proposed by this ruling (${proposals.length})`} />
      {proposals.length ? (
        <View style={styles.btnRow}>
          <Btn label={`Accept all ${proposals.length}`} onPress={() => onDecide(proposals.map((p) => p.id), 'accept')} />
        </View>
      ) : (
        <Text style={styles.sub}>{r.standing ? 'Nothing waiting: every matching record is right, or unticked.' : 'Not standing: nothing is proposed.'}</Text>
      )}
      {proposals.map((p) => (
        <View key={p.id} style={styles.prop}>
          <Text style={styles.rowTitle}>
            {p.levelCode ?? '—'} · {p.subject}
          </Text>
          <Text style={styles.rowSub}>{p.why ?? p.change}</Text>
          <View style={styles.btnRow}>
            <Btn label="Accept" onPress={() => onDecide([p.id], 'accept')} small />
            <Btn label="Reject" onPress={() => onDecide([p.id], 'reject')} small secondary />
            {p.levelId ? (
              <Pressable onPress={() => router.push({ pathname: '/plan/[levelId]', params: { levelId: p.levelId!, ...(p.deviceId ? { device: p.deviceId } : {}) } })}>
                <Text style={styles.link}>Open card ▸</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ bits

function Label({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

function Chip({ label, on, onPress, small }: { label: string; on: boolean; onPress: () => void; small?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, small && styles.chipSmall, on && styles.chipOn]}>
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function Btn({ label, onPress, disabled, secondary, small }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, secondary && styles.btn2, small && styles.btnSmall, disabled && styles.off]} accessibilityRole="button">
      <Text style={secondary ? styles.btn2Text : styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 24, fontWeight: '600' },
  link: { color: '#1f6feb', fontSize: 16 },
  body: { flex: 1, flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e1e4e8' },
  list: { width: '34%', flexGrow: 0, borderRightWidth: 1, borderRightColor: '#e1e4e8' },
  row: { paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  rowOn: { backgroundColor: '#dce8fb' },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 13, color: '#666', marginTop: 2 },
  empty: { fontSize: 15, color: '#666', padding: 16 },
  panel: { flex: 1 },
  panelBody: { padding: 16, gap: 10 },
  panelTitle: { fontSize: 18, fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '700', color: '#555', marginTop: 6, textTransform: 'uppercase' },
  value: { fontSize: 16 },
  sub: { fontSize: 13, color: '#666' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  hscroll: { gap: 8, paddingVertical: 2 },
  block: { gap: 8 },
  cond: { gap: 6, borderWidth: 1, borderColor: '#e1e4e8', borderRadius: 8, padding: 10 },
  condHead: { flexDirection: 'row', alignItems: 'center' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 4 },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  problems: { gap: 2 },
  problem: { color: '#b3261e', fontSize: 14 },
  btnRow: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  btn: { backgroundColor: '#1f6feb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  btn2: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#1f6feb' },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 6 },
  off: { opacity: 0.4 },
  btnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  btn2Text: { color: '#1f6feb', fontSize: 15, fontWeight: '600' },
  note: { color: '#0a5', fontSize: 14 },
  prop: { gap: 4, borderBottomWidth: 1, borderBottomColor: '#eef0f3', paddingVertical: 8 },
  previewRoot: { flex: 1, padding: 16, gap: 10 },
  table: { flex: 1 },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eef0f3' },
  th: { borderBottomColor: '#c9ccd1' },
  trOff: { opacity: 0.45 },
  cTick: { width: 24, fontSize: 18 },
  cLvl: { width: 44, fontSize: 14 },
  cRef: { width: 110, fontSize: 14 },
  cField: { width: 90, fontSize: 14, color: '#555' },
  cVal: { flex: 1, fontSize: 14 },
  now: { fontWeight: '600' },
  footer: { gap: 4, paddingVertical: 12 },
});
