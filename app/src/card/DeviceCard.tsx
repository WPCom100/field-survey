/**
 * Device card (T20, Phase 3 §4.3): the side panel beside the plan when a device is selected.
 * Sections scroll and collapse; every tap commits one op (D45, no Save button) through
 * `actions.ts`. Plain taps are `Field survey` (D96); `[⋯]` delete / restore / move pin ask for
 * a reason (`Correction`). Camera / Library and a thumbnail tap hand over to the photo flow
 * (T21); a connection row opens the end editor (T22); rule drafts are decided through the
 * `ProposalDecider` (T33); the quick actions E6 / E7 / E9 run through `runQuickAction` of the
 * rules package (T34). Neuron ID scan (T54) is shown with its button disabled until it lands.
 * Render it with `key={deviceId}`: a card instance belongs to one device (its note commits on leave).
 */

import { OpError, vocab, type Editor, type Store } from '@field-survey/core';
import { runQuickAction, type QuickAction } from '@field-survey/rules';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PhotoStrip } from '../photo/PhotoStrip';
import { BadgeStrip, Swatch, chipStyles } from '../plan/chips';
import { UNSURVEYED } from '../plan/filters';
import type { Badges } from '../plan/lists';
import { pinStyleFor } from '../plan/pins';
import {
  addOptionalAccessory,
  addOptionalCable,
  appendPhrase,
  checkNeuronId,
  deleteDevice,
  neuronDuplicates,
  restoreDevice,
  saveNeuronId,
  setFound,
  setNotes,
  setStatus,
} from './actions';
import { accessoryGroupLine, loadDeviceCard, type CardDraft, type DeviceCard as Card, type HistoryEntry, type JumpTarget } from './model';
import { QUICK_ACTIONS, type ProposalDecider, type QuickActionKey } from './proposals';

const CHIPS_SHOWN = 4;

export type DeviceCardProps = {
  store: Store;
  /** Null while the plan has not loaded: the card is then read-only. */
  editor: Editor | null;
  deviceId: string;
  badges: Badges;
  /** Changes after an edit or a sync: reload. */
  reloadKey: unknown;
  names: ReadonlyMap<string, string>;
  /** A `file://` URI for a cached blob, or null. */
  resolveBlobUri: (sha: string, kind: 'thumb' | 'image') => string | null;
  decider: ProposalDecider;
  /** The device has a pin on the sheet shown, or none at all, so "Move pin" / "Place pin" can work. */
  canMovePin: boolean;
  /** No pin anywhere yet (a device created from Needs review, T81): the menu offers "Place pin…". */
  unplaced?: boolean;
  /** Another level can be opened (false on the demo level, which has none). */
  canOpenLevels: boolean;
  onEdited: () => void;
  onClose: () => void;
  onJump: (t: JumpTarget) => void;
  /** Start move-pin mode on the plan with this reason; the plan's next tap places the pin. */
  onStartMove: (reason: string) => void;
  /** Take a photo of this device (T21); absent = no capture here. */
  onPhoto?: (source: 'camera' | 'library') => void;
  /** Open one of its photos (caption, link, markup). */
  onOpenPhoto?: (photoId: string) => void;
  /** Open a connection end in the end editor (T22). */
  onOpenEnd?: (endId: string) => void;
};

type Pending = { kind: 'delete' | 'restore' | 'move'; reason: string } | null;

export function DeviceCard(props: DeviceCardProps) {
  const { store, editor, deviceId, reloadKey, onEdited } = props;
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  useEffect(() => {
    let active = true;
    loadDeviceCard(store, deviceId).then(
      (c) => active && setCard(c),
      (e: unknown) => active && setError(String(e)),
    );
    return () => {
      active = false;
    };
  }, [store, deviceId, reloadKey]);

  /** Run one edit; refresh on success, show the reason on refusal. */
  const run = useCallback(
    async (fn: (e: Editor) => Promise<unknown>): Promise<boolean> => {
      if (!editor) return false;
      try {
        setError(null);
        await fn(editor);
        onEdited();
        return true;
      } catch (e) {
        setError(e instanceof OpError ? e.message : `Not saved: ${String((e as Error)?.message ?? e)}`);
        console.warn('[store] card edit refused', e);
        return false;
      }
    },
    [editor, onEdited],
  );

  if (!card) {
    return <View style={styles.loading}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}</View>;
  }
  const d = card.device;
  const readOnly = !editor || d.deleted;

  const confirmPending = () => {
    if (!pending) return;
    const reason = pending.reason;
    if (pending.kind === 'move') {
      if (!reason.trim()) return setError('Say why the pin moves (kept in the history).');
      setPending(null);
      props.onStartMove(reason.trim());
      return;
    }
    void run((e) => (pending.kind === 'delete' ? deleteDevice(e, d.id, reason) : restoreDevice(e, d.id, reason))).then((ok) => ok && setPending(null));
  };

  return (
    <View style={styles.root}>
      {/* header */}
      <View style={styles.head}>
        <View style={styles.headLine}>
          <Text style={styles.headId}>{d.label}</Text>
          <BadgeStrip b={{ ...props.badges, isNew: d.isNew, deleted: d.deleted }} />
          {d.fieldAddition ? <Text style={chipStyles.badgePlain}>+</Text> : null}
          <View style={styles.flex} />
          {editor ? (
            <Pressable onPress={() => setMenu((m) => !m)} hitSlop={8} style={styles.headBtn}>
              <Text style={styles.headBtnText}>⋯</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={props.onClose} hitSlop={8} style={styles.headBtn}>
            <Text style={styles.headBtnText}>×</Text>
          </Pressable>
        </View>
        <Text style={styles.headModel} numberOfLines={2}>
          {[d.device, d.type].filter(Boolean).join(' ') || '(no model)'}
        </Text>
        <Text style={styles.headSub} numberOfLines={2}>
          {[d.category, d.drawingPosition, d.room].filter(Boolean).join(' · ') || '—'}
        </Text>
        {d.isNew ? <Text style={styles.headNote}>NEW · ID assigned at sync</Text> : null}
      </View>

      {menu ? (
        <View style={styles.menu}>
          {props.canMovePin && !d.deleted ? (
            <MenuButton label={props.unplaced ? 'Place pin…' : 'Move pin…'} onPress={() => (setMenu(false), setPending({ kind: 'move', reason: '' }))} />
          ) : null}
          {d.deleted ? (
            <MenuButton label="Restore…" onPress={() => (setMenu(false), setPending({ kind: 'restore', reason: '' }))} />
          ) : (
            <MenuButton label="Delete…" danger onPress={() => (setMenu(false), setPending({ kind: 'delete', reason: '' }))} />
          )}
        </View>
      ) : null}

      {pending ? (
        <View style={styles.reasonBox}>
          <Text style={styles.label}>
            {pending.kind === 'delete' ? `Delete ${d.label}: why?` : pending.kind === 'restore' ? `Restore ${d.label}: why?` : `Move the pin of ${d.label}: why?`}
          </Text>
          <TextInput
            style={styles.input}
            value={pending.reason}
            onChangeText={(t) => setPending({ ...pending, reason: t })}
            placeholder="Reason (kept in the history)"
            placeholderTextColor="#888"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={confirmPending}
          />
          <View style={styles.rowWrap}>
            <SmallButton
              label={pending.kind === 'delete' ? 'Delete' : pending.kind === 'restore' ? 'Restore' : 'Tap the new position ▸'}
              danger={pending.kind === 'delete'}
              disabled={!pending.reason.trim()}
              onPress={confirmPending}
            />
            <SmallButton label="Cancel" onPress={() => setPending(null)} />
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {d.deleted ? (
          <View style={styles.deleted}>
            <Text style={styles.deletedText}>Deleted{d.deleteReason ? `: ${d.deleteReason}` : ''}</Text>
            {editor ? <SmallButton label="Restore…" onPress={() => setPending({ kind: 'restore', reason: '' })} /> : null}
          </View>
        ) : null}

        <Section title="Status" marks={marks(card, 'status')}>
          <View style={styles.rowWrap}>
            {vocab.DEVICE_STATUS.map((s) => {
              const on = d.status === s;
              const st = pinStyleFor(s);
              return (
                <Pressable
                  key={s}
                  disabled={readOnly}
                  onPress={() => !on && run((e) => setStatus(e, d.id, s))}
                  style={[styles.statusBtn, on && (st.hollow ? { borderColor: st.fill, borderWidth: 2 } : { backgroundColor: st.fill, borderColor: st.fill })]}>
                  <Text style={[styles.statusText, on && { color: st.hollow ? st.fill : '#fff', fontWeight: '700' }]}>
                    {on ? '✓ ' : ''}
                    {s}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {!d.status ? <Text style={styles.muted}>{UNSURVEYED}</Text> : null}
          {card.findings.map((f) => (
            <Text key={f.id} style={styles.finding}>
              ⚑ {f.lintId}: {f.message}
            </Text>
          ))}
        </Section>

        <NotesSection card={card} readOnly={readOnly} run={run} />

        {card.accessories.length || card.accessoryOffers.length ? (
          <Section title="Accessories" marks="">
            {card.accessories.map((a) => {
              const top = Math.max(a.expected ?? 2, a.found ?? 0);
              return (
                <View key={a.id} style={styles.acc}>
                  <Text style={styles.accModel} numberOfLines={1}>
                    {a.model} <Text style={styles.muted}>expected {a.expected ?? '—'}</Text>
                    {a.short ? <Text style={styles.finding}> ⚑ short</Text> : null}
                  </Text>
                  <View style={styles.rowWrap}>
                    <Text style={styles.muted}>found</Text>
                    {Array.from({ length: top + 1 }, (_, n) => (
                      <Pressable
                        key={n}
                        disabled={readOnly}
                        onPress={() => a.found !== n && run((e) => setFound(e, a.id, n))}
                        style={[styles.num, a.found === n && styles.numOn]}>
                        <Text style={[styles.numText, a.found === n && styles.numTextOn]}>{n}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              );
            })}
            {card.accessoryOfferGroups.map((block) => {
              const rows = block.offers.map((o) => (
                <OfferRow
                  key={o.model}
                  label={`+ add ${o.model}`}
                  sub={o.expected !== null ? `expected ${o.expected}` : null}
                  disabled={readOnly}
                  onPress={() => run((e) => addOptionalAccessory(e, d.id, o.model, o.expected))}
                />
              ));
              if (!block.group) return rows;
              // One block per accessory group of the type (T113): "one of these back boxes".
              return (
                <View key={`group:${block.group.label}`} style={styles.offerGroup}>
                  <Text style={styles.muted}>{accessoryGroupLine(block)}</Text>
                  {rows}
                </View>
              );
            })}
          </Section>
        ) : null}

        {/* A type without Neuron IDs (racks, NSPS by default — T68, D185) hides the section unless one was captured anyway. */}
        {card.device.needsNeuronId || card.device.neuronId ? <NeuronSection card={card} store={store} readOnly={readOnly} run={run} /> : null}

        <Section title={`Photos (${card.photos.length})`} marks={card.photosWaiting ? `📷 ${card.photosWaiting} waiting` : ''}>
          <PhotoStrip photos={card.photos} resolveBlobUri={props.resolveBlobUri} onOpen={props.onOpenPhoto} />
          <View style={styles.rowWrap}>
            <SmallButton label="📷 Camera" disabled={readOnly || !props.onPhoto} onPress={() => props.onPhoto?.('camera')} />
            <SmallButton label="🖼 Library" disabled={readOnly || !props.onPhoto} onPress={() => props.onPhoto?.('library')} />
          </View>
        </Section>

        <Section title={`Connections (${card.connections.length})`} marks="">
          {card.connections.length === 0 ? <Text style={styles.muted}>None on this device.</Text> : null}
          {card.connections.map((c) => (
            <Pressable key={c.id} style={styles.item} onPress={() => props.onOpenEnd?.(c.id)} disabled={!props.onOpenEnd}>
              <View style={styles.itemLine}>
                <Swatch {...pinStyleFor(c.status ?? 'Not started')} />
                <Text style={styles.itemId}>{c.label}</Text>
                <Text style={styles.itemText} numberOfLines={2}>
                  {c.cable ?? '?'} → {c.to}
                </Text>
              </View>
              <View style={styles.itemLine}>
                <Text style={styles.itemSub} numberOfLines={2}>
                  {[c.status ?? 'Not started', c.singleRow ? '1 row' : null, c.statusSource === 'copied' ? 'copied' : null, c.note].filter(Boolean).join(' · ')}
                </Text>
                {c.jump && (c.jump.sameLevel || props.canOpenLevels) ? (
                  <Pressable onPress={() => props.onJump(c.jump!)} hitSlop={6} style={styles.jump}>
                    <Text style={styles.jumpText}>{c.jump.label} ▸</Text>
                  </Pressable>
                ) : null}
                {props.onOpenEnd ? <Text style={styles.chev}>›</Text> : null}
              </View>
            </Pressable>
          ))}
          {/* The type's optional cables (Library, T105): greyed until tapped, then a real run with both ends. */}
          {card.cableOffers.map((o) => (
            <OfferRow key={o.key} label={`+ add ${o.title}`} sub="optional" disabled={readOnly} onPress={() => run((e) => addOptionalCable(e, store, d.id, o.cable))} />
          ))}
        </Section>

        <Section title={`Punch items (${card.punch.length})${card.drafts.length ? ` + proposals (${card.drafts.length})` : ''}`} marks="">
          {card.punch.length === 0 && card.drafts.length === 0 ? <Text style={styles.muted}>None.</Text> : null}
          {card.punch.map((p) => (
            <View key={p.id} style={[styles.item, !p.open && styles.closed]}>
              <View style={styles.itemLine}>
                <Text style={styles.itemId}>{p.label === 'NEW' ? 'NEW' : `#${p.label}`}</Text>
                <Text style={styles.itemText} numberOfLines={2}>
                  {p.item}
                </Text>
              </View>
              <Text style={styles.itemSub} numberOfLines={2}>
                {[p.deviceText, p.type, p.owner, p.tracking, p.notes].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}
          {card.drafts.map((dr) => (
            <DraftRow key={dr.id} draft={dr} decider={props.decider} readOnly={readOnly} onDecided={onEdited} />
          ))}
        </Section>

        <Section title={`Missing parts (${card.parts.length})`} marks="">
          {card.parts.length === 0 ? <Text style={styles.muted}>None.</Text> : null}
          {card.parts.map((m) => (
            <View key={m.id} style={[styles.item, m.partStatus === 'Installed' && styles.closed]}>
              <View style={styles.itemLine}>
                <Text style={styles.itemId}>{m.label === 'NEW' ? 'NEW' : `#${m.label}`}</Text>
                <Text style={styles.itemText} numberOfLines={2}>
                  {m.part}
                  {m.qty != null ? ` ×${m.qty}` : ''}
                </Text>
              </View>
              <Text style={styles.itemSub} numberOfLines={2}>
                {[m.partStatus, m.owner, m.sources.length ? `src ${m.sources.join(', ')}` : null, m.notes].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}
        </Section>

        <Section title="Quick actions" marks="" collapsed>
          <QuickActions deviceId={d.id} readOnly={readOnly} run={run} />
        </Section>

        <Section title={`History (${card.history.length})`} marks="" collapsed>
          {card.history.map((h) => (
            <HistoryLine key={h.opId} h={h} names={props.names} />
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}

// ------------------------------------------------------------------ sections

/** IN REVIEW / unsynced marks of one field, as the section header shows them. */
function marks(card: Card, field: string): string {
  return [card.inReview.has(field) ? 'in review' : null, card.pending.has(field) ? '↑ not synced' : null].filter(Boolean).join(' · ');
}

type Run = (fn: (e: Editor) => Promise<unknown>) => Promise<boolean>;

function NotesSection({ card, readOnly, run }: { card: Card; readOnly: boolean; run: Run }) {
  const d = card.device;
  const [draft, setDraft] = useState(d.notes ?? '');
  const [more, setMore] = useState(false);
  const focused = useRef(false);
  /** What the store has (or the last commit sent), so an unchanged blur writes nothing. */
  const saved = useRef(d.notes ?? '');
  const typed = useRef(draft);
  const edit = (text: string) => {
    typed.current = text;
    setDraft(text);
  };

  // A reload (after an edit or a sync) brings the stored note; never overwrite what is being typed.
  useEffect(() => {
    saved.current = d.notes ?? '';
    if (!focused.current) edit(d.notes ?? '');
  }, [d.notes]);

  const commit = useCallback(
    (text: string) => {
      if (text.trim() === saved.current.trim()) return;
      saved.current = text.trim();
      void run((e) => setNotes(e, d.id, text));
    },
    [run, d.id],
  );

  // Leaving the card (another pin, ×) with an uncommitted note still commits it. The card is
  // keyed by device, so this instance only ever writes to `d.id`.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);
  useEffect(() => () => commitRef.current(typed.current), []);

  const chips = more ? card.phrases : card.phrases.slice(0, CHIPS_SHOWN);
  return (
    <Section title="Notes" marks={marks(card, 'notes')}>
      <TextInput
        style={[styles.input, styles.notes, card.inReview.has('notes') && styles.review]}
        value={draft}
        editable={!readOnly}
        onChangeText={edit}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit(typed.current);
        }}
        placeholder="Notes"
        placeholderTextColor="#888"
        multiline
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
      />
      {readOnly ? null : (
        <View style={styles.rowWrap}>
          {chips.map((p) => (
            <Pressable
              key={p}
              style={styles.phrase}
              onPress={() => {
                const next = appendPhrase(typed.current, p);
                edit(next);
                commit(next);
              }}>
              <Text style={styles.phraseText} numberOfLines={1}>
                {p}
              </Text>
            </Pressable>
          ))}
          {card.phrases.length > CHIPS_SHOWN ? (
            <Pressable style={styles.phrase} onPress={() => setMore((m) => !m)}>
              <Text style={styles.phraseMore}>{more ? 'less ▴' : `more (${card.phrases.length - CHIPS_SHOWN}) ▾`}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </Section>
  );
}

function NeuronSection({ card, store, readOnly, run }: { card: Card; store: Store; readOnly: boolean; run: Run }) {
  const d = card.device;
  const [typing, setTyping] = useState<string | null>(null);
  const [dupes, setDupes] = useState<{ id: string; label: string }[]>([]);
  const check = typing === null ? null : checkNeuronId(typing);

  useEffect(() => {
    if (!check || check.error) return setDupes([]);
    let active = true;
    neuronDuplicates(store, d.projectId, check.value, d.id).then((r) => active && setDupes(r), () => {});
    return () => {
      active = false;
    };
  }, [store, d.projectId, d.id, check?.value, check?.error]);

  const save = () => run((e) => saveNeuronId(e, d.id, typing ?? '')).then((ok) => ok && setTyping(null));

  return (
    <Section title="Neuron ID" marks={marks(card, 'neuron_id')}>
      <View style={styles.rowWrap}>
        <Text style={[styles.neuron, !d.neuronId && styles.muted]}>{d.neuronId ?? '— not captured'}</Text>
        {d.neuronId && d.neuronMethod ? <Text style={styles.muted}>({d.neuronMethod})</Text> : null}
      </View>
      {typing === null ? (
        readOnly ? null : (
          <View style={styles.rowWrap}>
            <SmallButton label="Scan ▸" disabled onPress={() => {}} />
            <SmallButton label="Type…" onPress={() => setTyping(d.neuronId ?? '')} />
          </View>
        )
      ) : (
        <View>
          {/* Save and Cancel sit beside the field, so the keyboard never covers them (T20-9); Return saves. */}
          <View style={styles.neuronRow}>
            <TextInput
              style={[styles.input, styles.mono, styles.flex]}
              value={typing}
              onChangeText={setTyping}
              placeholder="12 hex digits, e.g. 00A1B2C3D4E5"
              placeholderTextColor="#888"
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={() => check && !check.error && void save()}
            />
            <SmallButton label={dupes.length ? 'Save anyway' : 'Save'} disabled={!check || !!check.error} onPress={() => void save()} />
            <SmallButton label="Cancel" onPress={() => setTyping(null)} />
          </View>
          {check && typing ? (
            <Text style={check.error ? styles.error : styles.muted}>{check.error ?? `${check.value} ✓`}</Text>
          ) : null}
          {dupes.length ? <Text style={styles.finding}>⚠ Already on {dupes.map((x) => x.label).join(', ')} in this project.</Text> : null}
        </View>
      )}
    </Section>
  );
}

/**
 * One rule draft (Phase 3 §4.3): Accept, Edit (a small form over the payload's text fields,
 * then "Save & accept"), Reject, and "why?" from the engine's `explain()` (T33). A decision is
 * one op group; the card reloads through `onDecided`. The Lint view lists the drafts no card
 * shows with it too (T100).
 */
export function DraftRow({ draft, decider, readOnly, onDecided }: { draft: CardDraft; decider: ProposalDecider; readOnly: boolean; onDecided: () => void }) {
  const [why, setWhy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAct = decider.wired && !readOnly && !busy;

  const act = (decision: Parameters<ProposalDecider['decide']>[1]) => {
    setBusy(true);
    setError(null);
    decider.decide(draft.id, decision).then(
      () => {
        setBusy(false);
        setEditing(null);
        onDecided();
      },
      (e: unknown) => {
        setBusy(false);
        setError(`Not saved: ${String((e as Error)?.message ?? e)}`);
        console.warn('[rules] decision refused', e);
      },
    );
  };
  const toggleWhy = () => {
    if (why !== null) {
      setWhy(null);
      return;
    }
    decider.explain(draft.id).then(
      (t) => setWhy(t ?? draft.why ?? `Rule ${draft.ruleId}`),
      () => setWhy(draft.why ?? `Rule ${draft.ruleId}`),
    );
  };
  const startEdit = () => {
    const form: Record<string, string> = {};
    for (const k of draft.editable) form[k] = String(draft.payload[k] ?? '');
    setEditing(form);
  };
  const saveEdit = () => {
    if (!editing) return;
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(editing)) {
      const was = draft.payload[k];
      payload[k] = typeof was === 'number' ? (v.trim() === '' ? null : Number(v)) : v;
    }
    act({ kind: 'edit', payload });
  };

  return (
    <View style={[styles.item, styles.draft]}>
      <View style={styles.itemLine}>
        <Text style={[chipStyles.badge, chipStyles.badgeDraft]}>DRAFT</Text>
        <Text style={styles.itemId}>⚑ {draft.ruleId}</Text>
        <Text style={styles.itemText} numberOfLines={2}>
          {draft.title}
        </Text>
      </View>
      {draft.sub ? <Text style={styles.itemSub}>{draft.sub}</Text> : null}
      {editing ? (
        <View style={styles.draftForm}>
          {Object.keys(editing).map((k) => (
            <View key={k} style={styles.draftField}>
              <Text style={styles.draftLabel}>{k.replace(/_/g, ' ')}</Text>
              <TextInput
                style={styles.draftInput}
                value={editing[k]}
                onChangeText={(v) => setEditing((f) => (f ? { ...f, [k]: v } : f))}
                multiline={k === 'notes' || k === 'item'}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          ))}
          <View style={styles.rowWrap}>
            <SmallButton label="Save & accept" disabled={!canAct} onPress={saveEdit} />
            <SmallButton label="Cancel" disabled={busy} onPress={() => setEditing(null)} />
          </View>
        </View>
      ) : (
        <View style={styles.rowWrap}>
          <SmallButton label="Accept" disabled={!canAct} onPress={() => act({ kind: 'accept' })} />
          <SmallButton label="Edit" disabled={!canAct || draft.editable.length === 0} onPress={startEdit} />
          <SmallButton label="Reject" disabled={!canAct} onPress={() => act({ kind: 'reject' })} />
          <Pressable onPress={toggleWhy} hitSlop={6}>
            <Text style={styles.jumpText}>why? {why !== null ? '▴' : '▸'}</Text>
          </Pressable>
        </View>
      )}
      {why !== null ? <Text style={styles.itemSub}>{why}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!decider.wired ? <Text style={styles.muted}>Read-only here; decide from the plan.</Text> : null}
    </View>
  );
}

/**
 * Quick actions E6 / E7 / E9 (Phase 3 §4.3, T34) and "Not found on site" (T101, runs on its tap): a tap opens the one question the action asks
 * (what was found / the make / the new room), Apply writes the records in one group through the
 * rules package; the card reloads through `run`.
 */
function QuickActions({ deviceId, readOnly, run }: { deviceId: string; readOnly: boolean; run: (fn: (e: Editor) => Promise<unknown>) => Promise<boolean> }) {
  const [asking, setAsking] = useState<QuickActionKey | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const q = QUICK_ACTIONS.find((x) => x.key === asking) ?? null;

  const apply = async () => {
    if (!q) return;
    const text = answer.trim();
    if (!q.optional && !text) return;
    const action: QuickAction | null = q.key === 'E6' ? { kind: 'E6', found: text || null } : q.key === 'E7' ? { kind: 'E7', make: text } : q.key === 'E9' ? { kind: 'E9', room: text } : null;
    if (!action) return;
    setBusy(true);
    const ok = await run((e) => runQuickAction(e, deviceId, action));
    setBusy(false);
    if (ok) {
      setAsking(null);
      setAnswer('');
    }
  };

  /** An action that asks nothing ("Not found on site") runs on its tap. */
  const runAtOnce = async (action: QuickAction) => {
    setBusy(true);
    await run((e) => runQuickAction(e, deviceId, action));
    setBusy(false);
  };

  return (
    <View style={styles.draftForm}>
      <View style={styles.rowWrap}>
        {QUICK_ACTIONS.map((x) => (
          <SmallButton
            key={x.key}
            label={x.label}
            disabled={readOnly || !x.enabled || busy}
            onPress={() => {
              setAnswer('');
              if (x.input === null) {
                setAsking(null);
                void runAtOnce({ kind: 'not_found' });
                return;
              }
              setAsking(asking === x.key ? null : x.key);
            }}
          />
        ))}
      </View>
      {q?.input ? (
        <View style={styles.draftField}>
          <Text style={styles.draftLabel}>{q.input}</Text>
          <TextInput style={styles.draftInput} value={answer} onChangeText={setAnswer} autoCapitalize="sentences" autoCorrect={false} autoFocus />
          <View style={styles.rowWrap}>
            <SmallButton label="Apply" disabled={busy || (!q.optional && !answer.trim())} onPress={() => void apply()} />
            <SmallButton label="Cancel" disabled={busy} onPress={() => setAsking(null)} />
          </View>
        </View>
      ) : null}
      {!readOnly && !q ? <Text style={styles.muted}>Spot-check fixed closes an ETC item "Reterminated - all good"; Non-ETC device marks it Not installed and asks the EC to confirm; Relocated notes the move; Not found on site marks it Not installed and not found, no item.</Text> : null}
    </View>
  );
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function HistoryLine({ h, names }: { h: HistoryEntry; names: ReadonlyMap<string, string> }) {
  const t = new Date(h.at);
  const when = Number.isNaN(t.getTime()) ? h.at : `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const who = names.get(h.userId) ?? `user …${h.userId.slice(-4)}`;
  return (
    <View style={styles.hist}>
      <Text style={styles.histHead} numberOfLines={1}>
        {when} {who} · {h.what}
        {h.pending ? ' ↑' : ''}
        {h.inReview ? ' · in review' : ''}
      </Text>
      {h.was !== null || h.now !== null ? (
        <Text style={styles.histBody} numberOfLines={3}>
          {h.was ?? ''} → {h.now ?? ''}
        </Text>
      ) : null}
      <Text style={styles.histWhy} numberOfLines={2}>
        {h.changeType}
        {h.reason && h.reason !== h.changeType ? ` · "${h.reason}"` : ''}
      </Text>
    </View>
  );
}

// ------------------------------------------------------------------ pieces

function Section({ title, marks: m, collapsed, children }: { title: string; marks: string; collapsed?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <View style={[styles.section, m.includes('in review') && styles.review]}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.sectionHead} hitSlop={4}>
        <Text style={styles.sectionTitle}>
          {open ? '▾' : '▸'} {title}
        </Text>
        {m ? <Text style={styles.sectionMarks}>{m}</Text> : null}
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

function SmallButton({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.btn, danger && styles.btnDanger, disabled && styles.btnDisabled]}>
      <Text style={[styles.btnText, danger && styles.btnDangerText, disabled && styles.btnDisabledText]}>{label}</Text>
    </Pressable>
  );
}

function MenuButton({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={styles.menuItem}>
      <Text style={[styles.menuText, danger && styles.btnDangerText]}>{label}</Text>
    </Pressable>
  );
}

/** A greyed "+ add …" row: something the device's type offers but the device does not have yet (T105). */
function OfferRow(props: { label: string; sub: string | null; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} disabled={props.disabled} style={[styles.item, styles.offer]} hitSlop={4}>
      <View style={styles.itemLine}>
        <Text style={styles.offerText} numberOfLines={2}>
          {props.label}
        </Text>
        {props.sub ? <Text style={styles.muted}>{props.sub}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  scroll: { paddingBottom: 40 },
  head: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1', gap: 2 },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headId: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headBtn: { paddingHorizontal: 8, paddingVertical: 2 },
  headBtnText: { fontSize: 22, color: '#1565c0', fontWeight: '600' },
  headModel: { fontSize: 14, color: '#222' },
  headSub: { fontSize: 12, color: '#555' },
  headNote: { fontSize: 12, color: '#1565c0', fontWeight: '600' },
  menu: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1', backgroundColor: '#f8f9fb' },
  menuItem: { paddingHorizontal: 14, paddingVertical: 10 },
  menuText: { fontSize: 15, color: '#1565c0' },
  reasonBox: { padding: 12, gap: 6, backgroundColor: '#fff8e1', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  label: { fontSize: 13, fontWeight: '600', color: '#333' },
  error: { color: '#b71c1c', fontSize: 13, paddingHorizontal: 12, paddingVertical: 4 },
  muted: { fontSize: 12, color: '#777' },
  finding: { fontSize: 12, color: '#e65100', marginTop: 4 },
  deleted: { margin: 12, padding: 10, borderRadius: 6, backgroundColor: '#ffebee', gap: 6 },
  deletedText: { color: '#b71c1c', fontWeight: '600' },
  section: { marginHorizontal: 8, marginTop: 8, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de' },
  review: { borderColor: '#e65100', borderWidth: 2 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  sectionMarks: { fontSize: 11, color: '#e65100' },
  sectionBody: { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  statusBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  statusText: { fontSize: 13, color: '#222' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, backgroundColor: '#fff' },
  neuronRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notes: { minHeight: 60, textAlignVertical: 'top' },
  mono: { fontVariant: ['tabular-nums'], letterSpacing: 1 },
  phrase: { maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, backgroundColor: '#eef2f7' },
  phraseText: { fontSize: 12, color: '#1f3b63' },
  phraseMore: { fontSize: 12, color: '#1565c0', fontWeight: '600' },
  acc: { gap: 4 },
  offerGroup: { gap: 2, paddingLeft: 6, borderLeftWidth: 2, borderColor: '#c9ccd1' },
  offer: { minHeight: 44, justifyContent: 'center', opacity: 0.6 },
  offerText: { flex: 1, fontSize: 13, color: '#555', fontStyle: 'italic' },
  accModel: { fontSize: 13, fontWeight: '600' },
  num: { minWidth: 30, paddingVertical: 4, alignItems: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#c9ccd1' },
  numOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  numText: { fontSize: 13 },
  numTextOn: { color: '#fff', fontWeight: '700' },
  neuron: { fontSize: 15, fontVariant: ['tabular-nums'], letterSpacing: 1 },
  item: { gap: 2, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#eceef1' },
  itemLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itemId: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  itemText: { flex: 1, fontSize: 13, color: '#222' },
  itemSub: { flex: 1, fontSize: 12, color: '#555' },
  closed: { opacity: 0.55 },
  draft: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#6a1b9a', borderRadius: 6, padding: 6 },
  draftForm: { gap: 4, paddingTop: 4 },
  draftField: { gap: 2 },
  draftLabel: { fontSize: 11, color: '#6a1b9a', textTransform: 'capitalize' },
  draftInput: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 4, fontSize: 13, backgroundColor: '#fff' },
  jump: { paddingHorizontal: 6, paddingVertical: 2 },
  jumpText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
  chev: { fontSize: 20, color: '#999', paddingLeft: 4 },
  btn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
  btnDanger: { borderColor: '#b71c1c' },
  btnDangerText: { color: '#b71c1c' },
  btnDisabled: { borderColor: '#d0d3d8' },
  btnDisabledText: { color: '#aaa' },
  hist: { paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#eceef1' },
  histHead: { fontSize: 12, fontWeight: '600', color: '#333' },
  histBody: { fontSize: 12, color: '#222' },
  histWhy: { fontSize: 11, color: '#777' },
});
