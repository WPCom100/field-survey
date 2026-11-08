/**
 * Device card (T20, Phase 3 §4.3): the side panel beside the plan when a device is selected. Since
 * T175 (D266, the "Plan · rail, card, status buttons" board) it is built on the UI system
 * (`app/src/ui`): a header with the ID, its badges, "model type" and "category · grid · room", ⋯ and
 * ×; Status as a two-column grid of swatch buttons with a check on the current one ("each tap
 * saves"); Notes with the vocabulary chips; rows for Type, the addresses `addressNeeds` asks for
 * (T146) and Photos with thumbnails and Camera / Library; collapsible sections with counts
 * (Accessories, Connections, Punch items, Parts, Quick actions, History) whose open state the card
 * keeps while it is open (`docs/ui-plan.md` §6); proposals as dashed DRAFT cards.
 *
 * Every tap commits one op (D45, no Save button) through `actions.ts`. Plain taps are `Field
 * survey` (D96); `⋯` delete / restore / move pin ask for a reason (`Correction`), as does a
 * connection row's ⋯ → Delete… (T138), whose History line offers Restore…; Put back in the unplaced
 * list… (T139) takes a placement back. Camera / Library and a thumbnail tap hand over to the photo
 * flow (T21); a connection row opens the end editor (T22); rule drafts are decided through the
 * `ProposalDecider` (T33); the quick actions E6 / E7 / E9 run through `runQuickAction` of the rules
 * package (T34). Neuron ID scan (T54) gets its button when it lands. Render it with
 * `key={deviceId}`: a card instance belongs to one device (its note commits on leave).
 *
 * Maestro reads a control's accessibility label as its text (and an accessibility state's value
 * before it): the current status button labels itself `✓ <status>` (the flows assert it), and a
 * section header labels itself with its title and count (`Punch items 3 · 1 draft`, `Parts 2`,
 * `Photos 1`), never through the children's join, which iOS separates with commas.
 */

import { OpError, vocab, type Editor, type Store } from '@field-survey/core';
import { runQuickAction, type QuickAction } from '@field-survey/rules';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PhotoStrip } from '../photo/PhotoStrip';
import { BadgeStrip } from '../plan/chips';
import { UNSURVEYED } from '../plan/filters';
import type { Badges } from '../plan/lists';
import { pinStyleFor } from '../plan/pins';
import { UNPLACE_REASON, unplaceDevice } from '../placement/actions';
import {
  BADGE,
  Badge,
  Banner,
  Btn,
  Chip,
  Field,
  Icon,
  Row,
  Section,
  Swatch,
  color,
  fieldStyles,
  font,
  hit,
  hitSlopTo,
  photosBadge,
  radius,
  ruleBadge,
  shadow,
  space,
  tabular,
  tinted,
  type IconName,
} from '../ui';
import {
  addOptionalAccessory,
  addOptionalCable,
  appendPhrase,
  checkDmxAddress,
  checkIpAddress,
  checkNeuronId,
  deleteCable,
  deleteDevice,
  ipDuplicates,
  neuronDuplicates,
  restoreCable,
  restoreDevice,
  saveDmxAddress,
  saveIpAddress,
  saveNeuronId,
  setFound,
  setNotes,
  setStatus,
  setType,
} from './actions';
import { accessoryGroupLine, loadDeviceCard, type CardConnection, type CardDraft, type DeviceCard as Card, type HistoryEntry, type JumpTarget } from './model';
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
  /** Open a punch item or missing part in the item editor (T162). */
  onOpenItem?: (kind: 'punch' | 'part', id: string) => void;
};

type Pending =
  | { kind: 'delete' | 'restore' | 'move'; reason: string }
  /** Put back in the unplaced list (T139): starts with "Placed by mistake". */
  | { kind: 'unplace'; reason: string }
  /** A connection's cable (T138): `title` is what the reason box names (`N C-01 → switch`). */
  | { kind: 'deleteCable' | 'restoreCable'; cableId: string; title: string; reason: string }
  | null;

type SectionKey = 'accessories' | 'connections' | 'punch' | 'parts' | 'quick' | 'history';

/** How the sections start: Quick actions and History folded, the rest open. The card keeps each one's state while it is open (D266, `docs/ui-plan.md` §6). */
const SECTIONS_OPEN: Readonly<Record<SectionKey, boolean>> = { accessories: true, connections: true, punch: true, parts: true, quick: false, history: false };

export function DeviceCard(props: DeviceCardProps) {
  const { store, editor, deviceId, reloadKey, onEdited } = props;
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [headHeight, setHeadHeight] = useState(0);
  const [pending, setPending] = useState<Pending>(null);
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(SECTIONS_OPEN);
  const fold = (k: SectionKey) => ({ open: open[k], onToggle: (v: boolean) => setOpen((o) => ({ ...o, [k]: v })) });

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
    return <View style={styles.loading}>{error ? <Banner tone="danger" text={error} /> : <ActivityIndicator color={color.primary} />}</View>;
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
    const p = pending;
    void run((e) => {
      switch (p.kind) {
        case 'deleteCable':
          return deleteCable(e, p.cableId, reason);
        case 'restoreCable':
          return restoreCable(e, p.cableId, reason);
        case 'delete':
          return deleteDevice(e, d.id, reason);
        case 'unplace':
          return unplaceDevice(e, store, d.id, reason);
        default:
          return restoreDevice(e, d.id, reason);
      }
    }).then((ok) => ok && setPending(null));
  };
  const pendingQuestion = (p: NonNullable<Pending>): string => {
    switch (p.kind) {
      case 'delete':
        return `Delete ${d.label}: why?`;
      case 'restore':
        return `Restore ${d.label}: why?`;
      case 'move':
        return `Move the pin of ${d.label}: why?`;
      case 'unplace':
        return d.placedFromDraft
          ? `Put ${d.label} back in the unplaced list (the device is deleted, its draft's unit is left to place): why?`
          : `Put ${d.label} back in the unplaced list (its pin is cleared): why?`;
      case 'deleteCable':
        return `Delete the connection ${p.title} with both ends: why?`;
      case 'restoreCable':
        return `Restore the connection ${p.title}: why?`;
    }
  };
  const danger = pending?.kind === 'delete' || pending?.kind === 'deleteCable';
  const okLabel = danger ? 'Delete' : pending?.kind === 'move' ? 'Tap the new position ▸' : pending?.kind === 'unplace' ? 'Put back' : 'Restore';
  const punchCount = `${card.punch.length}${card.drafts.length ? ` · ${card.drafts.length} ${card.drafts.length === 1 ? 'draft' : 'drafts'}` : ''}`;

  return (
    <View style={styles.root}>
      {/* header: ID with its badges, "model type", "category · grid · room", ⋯ and × */}
      <View style={styles.head} onLayout={(e) => setHeadHeight(e.nativeEvent.layout.height)}>
        <View style={styles.headLine}>
          {/* the badges wrap under the ID when the panel is narrow; ⋯ and × stay top right */}
          <View style={styles.headTitle}>
            <Text style={styles.headId}>{d.label}</Text>
            <BadgeStrip b={{ ...props.badges, isNew: d.isNew, deleted: d.deleted }} />
            {d.fieldAddition ? <Badge text="+" /> : null}
          </View>
          {editor ? <IconButton name="more" label="More: move pin, put back, delete" onPress={() => setMenu((m) => !m)} testID="card.menu" /> : null}
          <IconButton name="close" label="Close" onPress={props.onClose} testID="card.close" />
        </View>
        <Text style={styles.headModel} numberOfLines={2} testID="card.model">
          {[d.device, d.type].filter(Boolean).join(' ') || '(no model)'}
        </Text>
        <Text style={styles.headSub} numberOfLines={2} testID="card.sub">
          {[d.category, d.drawingPosition, d.room].filter(Boolean).join(' · ') || '—'}
        </Text>
        {d.isNew ? <Text style={styles.headNote}>NEW · ID assigned at sync</Text> : null}
      </View>

      {pending ? (
        <View style={styles.reasonBox}>
          <Text style={styles.reasonQuestion}>{pendingQuestion(pending)}</Text>
          <TextInput
            style={fieldStyles.input}
            value={pending.reason}
            onChangeText={(t) => setPending({ ...pending, reason: t })}
            placeholder="Reason (kept in the history)"
            placeholderTextColor={color.text3}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={confirmPending}
            testID="card.reason"
          />
          <View style={styles.actions}>
            <Btn title={okLabel} kind={danger ? 'destructive' : 'primary'} disabled={!pending.reason.trim()} onPress={confirmPending} testID="card.reason.ok" />
            <Btn title="Cancel" onPress={() => setPending(null)} testID="card.reason.cancel" />
          </View>
        </View>
      ) : null}

      {error ? <Banner tone="danger" text={error} style={styles.banner} /> : null}

      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {d.deleted ? (
          <Banner
            tone="danger"
            text={`Deleted${d.deleteReason ? `: ${d.deleteReason}` : ''}`}
            action={editor ? { label: 'Restore…', onPress: () => setPending({ kind: 'restore', reason: '' }) } : undefined}
            style={styles.banner}
          />
        ) : null}

        {/* Status: the five device statuses as swatch buttons, two to a row; each tap saves (D45) */}
        <View style={styles.block}>
          <FieldHead title="Status" hint="each tap saves">
            <Marks card={card} field="status" />
          </FieldHead>
          <View style={styles.statusGrid}>
            {vocab.DEVICE_STATUS.map((s) => (
              <StatusButton key={s} status={s} on={d.status === s} disabled={readOnly} onPress={() => void run((e) => setStatus(e, d.id, s))} />
            ))}
          </View>
          {!d.status ? <Text style={styles.hint}>{UNSURVEYED}</Text> : null}
          {card.findings.map((f) => (
            <Text key={f.id} style={styles.finding}>
              ⚑ {f.lintId}: {f.message}
            </Text>
          ))}
        </View>

        <NotesSection card={card} readOnly={readOnly} run={run} />

        {/* rows: Type, the addresses the device needs or has (T146, D245), Photos */}
        <View>
          <TypeRow card={card} readOnly={readOnly} run={run} />
          {d.needsNeuronId || d.neuronId ? <AddressRow kind="neuron" card={card} store={store} readOnly={readOnly} run={run} /> : null}
          {d.needsIpAddress || d.ipAddress ? <AddressRow kind="ip" card={card} store={store} readOnly={readOnly} run={run} /> : null}
          {d.needsDmxAddress || d.dmxAddress ? <AddressRow kind="dmx" card={card} store={store} readOnly={readOnly} run={run} /> : null}
          <PhotosRow card={card} readOnly={readOnly} resolveBlobUri={props.resolveBlobUri} onPhoto={props.onPhoto} onOpenPhoto={props.onOpenPhoto} />
        </View>

        {card.accessories.length || card.accessoryOffers.length ? (
          <Section title="Accessories" count={card.accessories.length} {...fold('accessories')}>
            {card.accessories.map((a) => {
              const top = Math.max(a.expected ?? 2, a.found ?? 0);
              return (
                <View key={a.id} style={styles.acc}>
                  <Text style={styles.accModel} numberOfLines={1}>
                    {a.model} <Text style={styles.accExpected}>expected {a.expected ?? '—'}</Text>
                    {a.short ? <Text style={styles.finding}> ⚑ short</Text> : null}
                  </Text>
                  <View style={styles.chips}>
                    <Text style={styles.hint}>found</Text>
                    {Array.from({ length: top + 1 }, (_, n) => (
                      <Chip key={n} label={String(n)} small selected={a.found === n} disabled={readOnly} onPress={() => void (a.found !== n && run((e) => setFound(e, a.id, n)))} />
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
                  onPress={() => void run((e) => addOptionalAccessory(e, d.id, o.model, o.expected))}
                />
              ));
              if (!block.group) return rows;
              // One block per accessory group of the type (T113): "one of these back boxes".
              return (
                <View key={`group:${block.group.label}`} style={styles.offerGroup}>
                  <Text style={styles.groupLine}>{accessoryGroupLine(block)}</Text>
                  {rows}
                </View>
              );
            })}
          </Section>
        ) : null}

        <Section title="Connections" count={card.connections.length} {...fold('connections')} testID="card.section.connections">
          {card.connections.length === 0 ? <Text style={styles.empty}>None on this device.</Text> : null}
          {card.connections.map((c, i) => (
            <ConnectionRow
              key={c.id}
              c={c}
              first={i === 0}
              readOnly={readOnly}
              canOpenLevels={props.canOpenLevels}
              onOpenEnd={props.onOpenEnd}
              onJump={props.onJump}
              onDelete={() => setPending({ kind: 'deleteCable', cableId: c.cableId, title: `${c.cable ?? '?'} ${c.label} → ${c.to}`, reason: '' })}
            />
          ))}
          {/* The type's optional cables (Library, T105): greyed until tapped, then a real run with both ends. */}
          {card.cableOffers.map((o) => (
            <OfferRow key={o.key} label={`+ add ${o.title}`} sub="optional" disabled={readOnly} onPress={() => void run((e) => addOptionalCable(e, store, d.id, o.cable))} />
          ))}
        </Section>

        <Section title="Punch items" count={punchCount} {...fold('punch')} testID="card.section.punch">
          {card.punch.length === 0 && card.drafts.length === 0 ? <Text style={styles.empty}>None.</Text> : null}
          {card.punch.map((p, i) => (
            <Row
              key={p.id}
              first={i === 0}
              onPress={props.onOpenItem ? () => props.onOpenItem?.('punch', p.id) : undefined}
              testID={`card.punch.${p.item}`}
              style={p.open ? undefined : styles.closed}
            >
              <View style={styles.flex}>
                <View style={styles.line}>
                  <Text style={styles.itemId}>{p.label === 'NEW' ? 'NEW' : `#${p.label}`}</Text>
                  <Text style={styles.itemText} numberOfLines={2}>
                    {p.item}
                  </Text>
                </View>
                <Text style={styles.itemSub} numberOfLines={2}>
                  {[p.deviceText, p.type, p.owner, p.tracking, p.notes].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </Row>
          ))}
          {card.drafts.map((dr) => (
            <DraftRow key={dr.id} draft={dr} decider={props.decider} readOnly={readOnly} onDecided={onEdited} />
          ))}
        </Section>

        <Section title="Parts" count={card.parts.length} {...fold('parts')} testID="card.section.parts">
          {card.parts.length === 0 ? <Text style={styles.empty}>None.</Text> : null}
          {card.parts.map((m, i) => (
            <Row
              key={m.id}
              first={i === 0}
              onPress={props.onOpenItem ? () => props.onOpenItem?.('part', m.id) : undefined}
              testID={`card.part.${m.part}`}
              style={m.partStatus === 'Installed' ? styles.closed : undefined}
            >
              <View style={styles.flex}>
                <View style={styles.line}>
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
            </Row>
          ))}
        </Section>

        <Section title="Quick actions" {...fold('quick')} testID="card.section.quick">
          <QuickActions deviceId={d.id} readOnly={readOnly} run={run} />
        </Section>

        <Section title="History" count={card.history.length} {...fold('history')} testID="card.section.history">
          {card.history.map((h) => (
            <HistoryLine
              key={h.opId}
              h={h}
              names={props.names}
              onRestore={
                h.cable?.restorable && !readOnly ? () => setPending({ kind: 'restoreCable', cableId: h.cable!.id, title: h.now ?? 'connection', reason: '' }) : undefined
              }
            />
          ))}
        </Section>
      </ScrollView>

      {/* the ⋯ menu: a popover under the header, dismissed by a tap anywhere else on the card (docs/ui-plan.md §6) */}
      {menu ? (
        <>
          <Pressable style={styles.menuBackdrop} onPress={() => setMenu(false)} accessibilityRole="button" accessibilityLabel="Close the menu" />
          <View style={[styles.menu, { top: Math.max(headHeight - space.xs, hit.target) }]} accessibilityRole="menu">
            {props.canMovePin && !d.deleted ? (
              <MenuItem
                testID="card.menu.move"
                label={props.unplaced ? 'Place pin…' : 'Move pin…'}
                onPress={() => {
                  setMenu(false);
                  setPending({ kind: 'move', reason: '' });
                }}
              />
            ) : null}
            {!d.deleted && (d.placedFromDraft || d.pin) ? (
              <MenuItem
                testID="card.menu.unplace"
                label="Put back in the unplaced list…"
                onPress={() => {
                  setMenu(false);
                  setPending({ kind: 'unplace', reason: UNPLACE_REASON });
                }}
              />
            ) : null}
            {d.deleted ? (
              <MenuItem
                testID="card.menu.restore"
                label="Restore…"
                onPress={() => {
                  setMenu(false);
                  setPending({ kind: 'restore', reason: '' });
                }}
              />
            ) : (
              <MenuItem
                testID="card.menu.delete"
                label="Delete…"
                danger
                onPress={() => {
                  setMenu(false);
                  setPending({ kind: 'delete', reason: '' });
                }}
              />
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ status, notes

type Run = (fn: (e: Editor) => Promise<unknown>) => Promise<boolean>;

/**
 * One status as the board draws it: the swatch with its glyph, the word, and on the current one a
 * check, the status colour as border and text over its pale tint (dark text on the No access yellow).
 */
function StatusButton({ status, on, disabled, onPress }: { status: string; on: boolean; disabled: boolean; onPress: () => void }) {
  const st = pinStyleFor(status);
  const t = tinted(st.fill, color.text);
  return (
    <Pressable
      disabled={disabled}
      onPress={() => !on && onPress()}
      testID={`card.status.${status}`}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={on ? `✓ ${status}` : status}
      style={({ pressed }) => [
        styles.statusBtn,
        on && { borderColor: st.fill, borderWidth: 1.5, backgroundColor: t.bg },
        pressed && !on && styles.pressed,
        disabled && !on && styles.off,
      ]}
    >
      <Swatch {...st} size={20} />
      <Text style={[styles.statusText, on && { color: t.fg, fontWeight: '600' }]} numberOfLines={2}>
        {status}
      </Text>
      {on ? <Icon name="check" size={18} color={t.fg} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

/** A field's caption row: the title, an optional hint and the field's marks. */
function FieldHead({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <View style={styles.fieldHead}>
      <Text style={styles.fieldTitle}>{title}</Text>
      {hint ? <Text style={styles.fieldHint}>· {hint}</Text> : null}
      {children}
    </View>
  );
}

/** The field's review and unsynced marks (Phase 3 §13), in the words the flows read: `in review`, `↑ not synced`. */
function Marks({ card, field }: { card: Card; field: string }) {
  const review = card.inReview.has(field);
  const pend = card.pending.has(field);
  if (!review && !pend) return null;
  return (
    <>
      {review ? <Text style={styles.markReview}>in review</Text> : null}
      {pend ? <Text style={styles.markPending}>↑ not synced</Text> : null}
    </>
  );
}

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
    <View style={styles.block}>
      <FieldHead title="Notes">
        <Marks card={card} field="notes" />
      </FieldHead>
      <TextInput
        style={[fieldStyles.input, styles.notes, card.inReview.has('notes') && styles.reviewBorder]}
        value={draft}
        editable={!readOnly}
        onChangeText={edit}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit(typed.current);
        }}
        placeholder="Notes"
        testID="card.notes"
        placeholderTextColor={color.text3}
        multiline
        submitBehavior="blurAndSubmit"
        returnKeyType="done"
      />
      {readOnly ? null : (
        <View style={styles.chips}>
          {chips.map((p) => (
            <Chip
              key={p}
              label={p}
              style={styles.chip}
              onPress={() => {
                const next = appendPhrase(typed.current, p);
                edit(next);
                commit(next);
              }}
            />
          ))}
          {card.phrases.length > CHIPS_SHOWN ? <Chip label={more ? 'less ▴' : `more (${card.phrases.length - CHIPS_SHOWN}) ▾`} onPress={() => setMore((m) => !m)} /> : null}
        </View>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ rows

/**
 * The master's Type column (T104): a row with the stored text; a tap opens a box with the project's
 * `type` vocabulary as chips (a chip replaces the text); free typing stays. Save writes one op.
 */
function TypeRow({ card, readOnly, run }: { card: Card; readOnly: boolean; run: Run }) {
  const d = card.device;
  const [typing, setTyping] = useState<string | null>(null);
  const save = (text: string) => void run((e) => setType(e, d.id, text)).then((ok) => ok && setTyping(null));
  return (
    <>
      <Row first minHeight={48} onPress={readOnly ? undefined : () => setTyping(d.type ?? '')} testID="card.type.edit">
        <Text style={styles.rowLabel}>Type</Text>
        <View style={styles.rowValues}>
          <Text style={[styles.rowValue, !d.type && styles.rowEmpty, card.inReview.has('type') && styles.reviewText]} numberOfLines={2} testID="card.type">
            {d.type ?? '—'}
          </Text>
          <Marks card={card} field="type" />
        </View>
      </Row>
      {typing !== null ? (
        <View style={styles.rowEditor}>
          <TextInput
            style={fieldStyles.input}
            value={typing}
            onChangeText={setTyping}
            placeholder="Type (e.g. Echo relay panel)"
            placeholderTextColor={color.text3}
            testID="card.type.input"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => save(typing)}
          />
          {card.typeChips.length ? (
            <View style={styles.chips}>
              {card.typeChips.map((c) => (
                <Chip key={c} label={c} small selected={typing === c} style={styles.chip} onPress={() => setTyping(c)} />
              ))}
            </View>
          ) : null}
          <View style={styles.actions}>
            <Btn title="Save" kind="primary" onPress={() => save(typing)} testID="card.type.save" />
            <Btn title="Cancel" onPress={() => setTyping(null)} />
          </View>
        </View>
      ) : null}
    </>
  );
}

type AddressKind = 'neuron' | 'ip' | 'dmx';

const ADDRESS: Readonly<Record<AddressKind, { title: string; field: string; placeholder: string }>> = {
  neuron: { title: 'Neuron ID', field: 'neuron_id', placeholder: '12 hex digits, e.g. 00A1B2C3D4E5' },
  ip: { title: 'IP address', field: 'ip_address', placeholder: 'IPv4, e.g. 10.101.4.23' },
  dmx: { title: 'DMX address', field: 'dmx_address', placeholder: 'universe/address, e.g. 1/001' },
};

/**
 * Neuron ID, IP address or DMX address (T146, D246) as a row: the value (or "Not entered"), Add /
 * Edit, Clear (IP and DMX). The editor opens under the row with the format check (`checkNeuronId`,
 * `checkIpAddress`, `checkDmxAddress`), the duplicate warning (Neuron ID, IP) and one `Field
 * survey` op; Save and Cancel sit beside the field so the keyboard never covers them (T20-9);
 * Return saves. The Neuron ID is normalised and saved with its method (`typed`).
 */
function AddressRow({ kind, card, store, readOnly, run }: { kind: AddressKind; card: Card; store: Store; readOnly: boolean; run: Run }) {
  const d = card.device;
  const a = ADDRESS[kind];
  const value = kind === 'neuron' ? d.neuronId : kind === 'ip' ? d.ipAddress : d.dmxAddress;
  const [typing, setTyping] = useState<string | null>(null);
  const [dupes, setDupes] = useState<{ id: string; label: string }[]>([]);
  const check = typing === null || !typing.trim() ? null : kind === 'neuron' ? checkNeuronId(typing) : kind === 'ip' ? checkIpAddress(typing) : checkDmxAddress(typing);

  useEffect(() => {
    if (kind === 'dmx' || !check || check.error) return setDupes([]);
    let active = true;
    (kind === 'neuron' ? neuronDuplicates : ipDuplicates)(store, d.projectId, check.value, d.id).then(
      (r) => active && setDupes(r),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [kind, store, d.projectId, d.id, check?.value, check?.error]);

  const write = (text: string) => (e: Editor) => (kind === 'neuron' ? saveNeuronId(e, d.id, text) : kind === 'ip' ? saveIpAddress(e, d.id, text) : saveDmxAddress(e, d.id, text));
  const save = () => run(write(typing ?? '')).then((ok) => ok && setTyping(null));
  const clear = () => run(write('')).then((ok) => ok && setTyping(null));

  return (
    <>
      <Row minHeight={48}>
        <Text style={styles.rowLabel}>{a.title}</Text>
        <View style={styles.rowValues}>
          <Text style={[styles.rowValue, styles.mono, !value && styles.rowEmpty, card.inReview.has(a.field) && styles.reviewText]} numberOfLines={2}>
            {value ?? 'Not entered'}
          </Text>
          {kind === 'neuron' && value && d.neuronMethod ? <Text style={styles.hint}>({d.neuronMethod})</Text> : null}
          <Marks card={card} field={a.field} />
        </View>
        {readOnly || typing !== null ? null : <Btn title={value ? 'Edit' : 'Add'} kind="tertiary" small onPress={() => setTyping(value ?? '')} testID={`card.${kind}.type`} />}
      </Row>
      {typing !== null ? (
        <View style={styles.rowEditor}>
          <View style={styles.editLine}>
            <TextInput
              style={[fieldStyles.input, styles.mono, styles.flex]}
              value={typing}
              onChangeText={setTyping}
              placeholder={a.placeholder}
              placeholderTextColor={color.text3}
              keyboardType={kind === 'ip' ? 'decimal-pad' : kind === 'dmx' ? 'numbers-and-punctuation' : 'default'}
              autoCapitalize={kind === 'neuron' ? 'characters' : 'none'}
              autoCorrect={false}
              autoFocus
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={() => check && !check.error && void save()}
              testID={`card.${kind}.input`}
            />
            <Btn title={dupes.length ? 'Save anyway' : 'Save'} kind="primary" small disabled={!check || !!check.error} onPress={() => void save()} testID={`card.${kind}.save`} />
            <Btn title="Cancel" small onPress={() => setTyping(null)} />
          </View>
          {check && typing ? <Text style={check.error ? styles.errorText : styles.hint}>{check.error ?? `${check.value} ✓`}</Text> : null}
          {dupes.length ? <Text style={styles.finding}>⚠ Already on {dupes.map((x) => x.label).join(', ')} in this project.</Text> : null}
          {kind !== 'neuron' && value ? (
            <View style={styles.actions}>
              <Btn title="Clear" kind="tertiary" small onPress={() => void clear()} testID={`card.${kind}.clear`} />
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** Photos: the count and the waiting badge, Camera / Library (T21), the thumbnails (D128). */
function PhotosRow({
  card,
  readOnly,
  resolveBlobUri,
  onPhoto,
  onOpenPhoto,
}: {
  card: Card;
  readOnly: boolean;
  resolveBlobUri: DeviceCardProps['resolveBlobUri'];
  onPhoto: DeviceCardProps['onPhoto'];
  onOpenPhoto: DeviceCardProps['onOpenPhoto'];
}) {
  const off = readOnly || !onPhoto;
  return (
    <View style={styles.photoBlock}>
      <View style={styles.photoHead}>
        {/* one element reading `Photos 1`, then `📷 n waiting` while some bytes are on this iPad only (the flows match it) */}
        <View
          style={styles.photoTitle}
          accessible
          accessibilityLabel={`Photos ${card.photos.length}${card.photosWaiting ? ` ${photosBadge(card.photosWaiting).text}` : ''}`}
          testID="card.section.photos"
        >
          <Text style={styles.rowLabel}>Photos</Text>
          <Text style={styles.count}>{card.photos.length}</Text>
          {card.photosWaiting ? <Badge {...photosBadge(card.photosWaiting)} /> : null}
        </View>
        <View style={styles.flex} />
        {/* one group, so a narrow panel wraps both buttons to the next line together */}
        <View style={styles.line}>
          <Btn title="Camera" kind="tertiary" small icon={<Icon name="camera" size={18} color={color.primary} />} disabled={off} onPress={() => onPhoto?.('camera')} />
          <Btn title="Library" kind="tertiary" small icon={<Icon name="image" size={18} color={color.primary} />} disabled={off} onPress={() => onPhoto?.('library')} testID="card.photo.library" />
        </View>
      </View>
      <PhotoStrip photos={card.photos} resolveBlobUri={resolveBlobUri} onOpen={onOpenPhoto} />
    </View>
  );
}

// ------------------------------------------------------------------ sections

/** A connection of the device: swatch, `C-nn`, `X → to`, the end's status and note, the jump to the far device, ⋯ → Delete… (T138). */
function ConnectionRow({
  c,
  first,
  readOnly,
  canOpenLevels,
  onOpenEnd,
  onJump,
  onDelete,
}: {
  c: CardConnection;
  first: boolean;
  readOnly: boolean;
  canOpenLevels: boolean;
  onOpenEnd: DeviceCardProps['onOpenEnd'];
  onJump: DeviceCardProps['onJump'];
  onDelete: () => void;
}) {
  return (
    <Row first={first} onPress={onOpenEnd ? () => onOpenEnd(c.id) : undefined}>
      <Swatch {...pinStyleFor(c.status ?? 'Not started')} size={20} />
      <View style={styles.flex}>
        <View style={styles.line}>
          <Text style={styles.itemId} testID={`card.conn.${c.label}`}>
            {c.label}
          </Text>
          <Text style={styles.itemText} numberOfLines={2}>
            {c.cable ?? '?'} → {c.to}
          </Text>
        </View>
        <Text style={styles.itemSub} numberOfLines={2}>
          {[c.status ?? 'Not started', c.singleRow ? '1 row' : null, c.statusSource === 'copied' ? 'copied' : null, c.note].filter(Boolean).join(' · ')}
        </Text>
        {c.jump && (c.jump.sameLevel || canOpenLevels) ? (
          <Pressable onPress={() => onJump(c.jump!)} hitSlop={hitSlopTo(hit.small)} style={styles.jumpBtn} testID={`card.conn.${c.label}.jump`} accessibilityRole="button">
            <Text style={styles.link}>{c.jump.label} ▸</Text>
          </Pressable>
        ) : null}
        {c.farDraft ? (
          <Text style={styles.itemSub} numberOfLines={2}>
            → {c.farDraft}
          </Text>
        ) : null}
      </View>
      {readOnly ? null : (
        <Pressable onPress={onDelete} hitSlop={hitSlopTo(hit.small)} style={styles.linkBtn} accessibilityRole="button" accessibilityLabel={`Delete connection ${c.label}`}>
          <Icon name="more" size={20} color={color.text2} />
        </Pressable>
      )}
    </Row>
  );
}

/** A greyed "+ add …" row: something the device's type offers but the device does not have yet (T105). */
function OfferRow(props: { label: string; sub: string | null; disabled: boolean; onPress: () => void }) {
  return (
    <Row minHeight={48} chevron={false} onPress={props.disabled ? undefined : props.onPress} testID={`card.offer.${props.label.replace(/^\+ add /, '')}`}>
      <Text style={styles.offerText} numberOfLines={2}>
        {props.label}
      </Text>
      {props.sub ? <Text style={styles.hint}>{props.sub}</Text> : null}
    </Row>
  );
}

/** `tracking_status` → `Tracking status`: the Edit form's field labels. */
function labelOf(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One rule draft (Phase 3 §4.3) as a dashed DRAFT card: the rule, the item, its type · owner; Accept,
 * Edit (a small form over the payload's text fields, then "Save & accept"), Reject, and "why?" from
 * the engine's `explain()` (T33). A decision is one op group; the card reloads through `onDecided`.
 * The Lint view lists the drafts no card shows with it too (T100).
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
    <View style={styles.draft}>
      <View style={styles.line}>
        <Badge {...BADGE.draft} />
        <Badge {...ruleBadge(draft.ruleId)} />
      </View>
      <Text style={styles.draftTitle}>{draft.title}</Text>
      {draft.sub ? <Text style={styles.itemSub}>{draft.sub}</Text> : null}
      {editing ? (
        <View style={styles.draftForm}>
          {Object.keys(editing).map((k) => (
            <View key={k} style={styles.question}>
              <Field
                label={labelOf(k)}
                value={editing[k] ?? ''}
                onChange={(v) => setEditing((f) => (f ? { ...f, [k]: v } : f))}
                multiline={k === 'notes' || k === 'item'}
                testID={`proposal.field.${k}`}
              />
              {draft.chips?.[k]?.length ? (
                <View style={styles.chips}>
                  {draft.chips[k]!.map((c) => (
                    <Chip key={c} label={c} small selected={editing[k] === c} style={styles.chip} onPress={() => setEditing((f) => (f ? { ...f, [k]: c } : f))} />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
          {/* small, like the draft's own buttons: both fit one line inside the dashed card on the portrait panel */}
          <View style={styles.actions}>
            <Btn title="Save & accept" kind="primary" small disabled={!canAct} onPress={saveEdit} testID={`proposal.save.${draft.title}`} />
            <Btn title="Cancel" small disabled={busy} onPress={() => setEditing(null)} />
          </View>
        </View>
      ) : (
        <View style={styles.draftActions}>
          <Btn title="Accept" kind="primary" small disabled={!canAct} onPress={() => act({ kind: 'accept' })} testID={`proposal.accept.${draft.title}`} style={styles.draftAccept} />
          <Btn title="Edit" small disabled={!canAct || draft.editable.length === 0} onPress={startEdit} testID={`proposal.edit.${draft.title}`} />
          <Btn title="Reject" kind="tertiary" small disabled={!canAct} onPress={() => act({ kind: 'reject' })} testID={`proposal.reject.${draft.title}`} />
          <Pressable onPress={toggleWhy} hitSlop={hitSlopTo(hit.small)} style={styles.linkBtn} testID={`proposal.why.${draft.title}`} accessibilityRole="button">
            <Text style={styles.link}>why? {why !== null ? '▴' : '▸'}</Text>
          </Pressable>
        </View>
      )}
      {why !== null ? <Text style={styles.itemSub}>{why}</Text> : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      {!decider.wired ? <Text style={styles.hint}>Read-only here; decide from the plan.</Text> : null}
    </View>
  );
}

/**
 * Quick actions E6 / E7 / E9 (Phase 3 §4.3, T34) and "Not found on site" (T101, runs on its tap): a
 * tap opens the one question the action asks (what was found / the make / the new room), Apply
 * writes the records in one group through the rules package; the card reloads through `run`.
 */
function QuickActions({ deviceId, readOnly, run }: { deviceId: string; readOnly: boolean; run: Run }) {
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
    <View style={styles.quick}>
      <View style={styles.actions}>
        {QUICK_ACTIONS.map((x) => (
          <Btn
            key={x.key}
            small
            testID={`card.quick.${x.key}`}
            title={x.label}
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
        <View style={styles.question}>
          <Text style={styles.fieldTitle}>{q.input}</Text>
          <TextInput
            style={fieldStyles.input}
            value={answer}
            onChangeText={setAnswer}
            autoCapitalize="sentences"
            autoCorrect={false}
            autoFocus
            testID="card.quick.input"
            returnKeyType="done"
            onSubmitEditing={() => void apply()}
          />
          <View style={styles.actions}>
            <Btn title="Apply" kind="primary" disabled={busy || (!q.optional && !answer.trim())} onPress={() => void apply()} testID="card.quick.apply" />
            <Btn title="Cancel" disabled={busy} onPress={() => setAsking(null)} />
          </View>
        </View>
      ) : null}
      {!readOnly && !q ? (
        <Text style={styles.hint}>
          Spot-check fixed closes an ETC item "Reterminated - all good"; Non-ETC device marks it Not installed and asks the EC to confirm; Relocated notes the move; Not found on site marks it Not installed
          and not found, no item.
        </Text>
      ) : null}
    </View>
  );
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function HistoryLine({ h, names, onRestore }: { h: HistoryEntry; names: ReadonlyMap<string, string>; onRestore?: () => void }) {
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
      {h.cable ? (
        <Text style={styles.histBody} numberOfLines={3}>
          {h.now}
        </Text>
      ) : h.was !== null || h.now !== null ? (
        <Text style={styles.histBody} numberOfLines={3}>
          {h.was ?? ''} → {h.now ?? ''}
        </Text>
      ) : null}
      <Text style={styles.histWhy} numberOfLines={2}>
        {h.changeType}
        {h.reason && h.reason !== h.changeType ? ` · "${h.reason}"` : ''}
      </Text>
      {onRestore ? (
        <View style={styles.actions}>
          <Btn title="Restore…" small onPress={onRestore} testID="card.history.restore" />
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ pieces

/** A 44-pt icon-only button (⋯, ×) with its own label for VoiceOver. */
function IconButton({ name, label, onPress, testID }: { name: IconName; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}>
      <Icon name={name} size={22} color={color.text2} />
    </Pressable>
  );
}

function MenuItem({ label, onPress, danger, testID }: { label: string; onPress: () => void; danger?: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="menuitem" style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
      <Text style={[styles.menuText, danger && styles.menuDanger]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  scroll: { paddingTop: space.lg, paddingBottom: 40, gap: 14 },
  // header
  head: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: 2, borderBottomWidth: 1, borderBottomColor: color.hairline, backgroundColor: color.surface },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: hit.target },
  headTitle: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  headId: { ...font.headline, ...tabular, color: color.text },
  headModel: { ...font.callout, color: color.text },
  headSub: { ...font.caption, color: color.text3 },
  headNote: { ...font.captionBold, color: color.primary },
  iconBtn: { width: hit.target, height: hit.target, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: color.surface2 },
  off: { opacity: 0.45 },
  // the ⋯ popover
  menuBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  menu: { position: 'absolute', right: space.sm, minWidth: 260, paddingVertical: space.xs, backgroundColor: color.surface, borderRadius: radius.card, borderWidth: 1, borderColor: color.hairline, ...shadow.card },
  menuItem: { minHeight: hit.target, justifyContent: 'center', paddingHorizontal: space.lg },
  menuText: { ...font.callout, color: color.text },
  menuDanger: { color: color.danger },
  // the reason box
  reasonBox: { padding: space.lg, gap: space.sm, backgroundColor: color.warningTint, borderBottomWidth: 1, borderBottomColor: color.hairline },
  reasonQuestion: { ...font.captionBold, color: color.warning },
  banner: { marginHorizontal: space.lg },
  // field blocks (Status, Notes)
  block: { paddingHorizontal: space.lg, gap: space.sm },
  fieldHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, minHeight: 18 },
  fieldTitle: { ...font.captionBold, color: color.text2 },
  fieldHint: { ...font.caption, color: color.text3 },
  markReview: { ...font.captionBold, color: color.warning },
  markPending: { ...font.caption, color: color.text3 },
  hint: { ...font.caption, color: color.text3 },
  finding: { ...font.caption, color: color.warning },
  errorText: { ...font.caption, color: color.danger },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  statusBtn: {
    flexBasis: '48%',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  statusText: { ...font.callout, color: color.text, flex: 1 },
  notes: { minHeight: 56, textAlignVertical: 'top', paddingVertical: space.sm },
  reviewBorder: { borderColor: color.warning, borderWidth: 2 },
  reviewText: { color: color.warning },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  chip: { maxWidth: '100%' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  // rows (Type, addresses, Photos): the panel is 287 pt in portrait, so the label column is 80 and a
  // value may wrap to two lines rather than truncate
  rowLabel: { ...font.callout, color: color.text2, width: 80 },
  rowValues: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  rowValue: { ...font.callout, color: color.text, flexShrink: 1 },
  rowEmpty: { color: color.text3 },
  mono: { ...tabular, letterSpacing: 0.5 },
  rowEditor: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm },
  editLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  photoBlock: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm, borderTopWidth: 1, borderTopColor: color.hairline },
  photoHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, minHeight: hit.small },
  photoTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  count: { ...font.callout, ...tabular, color: color.text3 },
  // sections
  empty: { ...font.callout, color: color.text3, paddingHorizontal: space.lg, paddingVertical: space.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  itemId: { ...font.captionBold, ...tabular, color: color.text2 },
  itemText: { ...font.callout, color: color.text, flex: 1 },
  itemSub: { ...font.caption, color: color.text3, flex: 1 },
  closed: { opacity: 0.55 },
  link: { ...font.calloutBold, color: color.primary },
  linkBtn: { minHeight: hit.small, justifyContent: 'center', paddingHorizontal: space.xs },
  jumpBtn: { minHeight: hit.small, justifyContent: 'center', alignSelf: 'flex-start' },
  offerText: { ...font.callout, color: color.text3, fontStyle: 'italic', flex: 1 },
  acc: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.xs },
  accModel: { ...font.calloutBold, color: color.text },
  accExpected: { ...font.caption, color: color.text3 },
  offerGroup: { marginLeft: space.lg, paddingLeft: space.sm, borderLeftWidth: 2, borderLeftColor: color.border },
  groupLine: { ...font.caption, color: color.text3, paddingHorizontal: space.lg, paddingTop: space.sm },
  draft: {
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: space.xs,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.muted,
    borderRadius: radius.card,
  },
  draftTitle: { ...font.headline, color: color.text },
  draftActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, marginTop: 6 },
  draftAccept: { flexGrow: 1, flexBasis: 72 },
  draftForm: { gap: space.sm, paddingTop: space.xs },
  quick: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  question: { gap: space.xs },
  hist: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: 2, borderTopWidth: 1, borderTopColor: color.hairline },
  histHead: { ...font.captionBold, color: color.text2 },
  histBody: { ...font.caption, color: color.text },
  histWhy: { ...font.caption, color: color.text3 },
});
