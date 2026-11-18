import { Editor, type Store } from '@field-survey/core';
import { DEVICE_CATEGORIES } from '@field-survey/rules';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native';

import { openAppStore } from '../db';
import { useIdentity } from '../identity/IdentityGate';
import { askTypeSetup, questionsForDrafts } from '../library/typeSetup';
import { Btn, Notice, styles as w } from '../setup/widgets';
import { Chip as UiChip, FormActions, color, font, radius, space, tabular } from '../ui';
import { revealOffset } from '../ui/reveal';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import {
  DraftError,
  acceptAll,
  acceptCable,
  acceptDevice,
  addCableDraft,
  addDeviceDraft,
  cableBlockers,
  commitWaitingCables,
  deviceBlockers,
  editDevice,
  foldAccessory,
  foldBlockers,
  promoteExcluded,
  readyCables,
  realEnd,
  rejectDraft,
  reopenDraft,
  setCableCode,
  setEndpoint,
  type DeviceChoice,
} from './actions';
import { excludedLines, listImports, promotedKeys, riserBlobFor, type Batch, type ExcludedRow } from './api';
import {
  FILTERS,
  bulkCables,
  bulkDevices,
  cablesOn,
  devicesOn,
  endpointOptions,
  levelCounts,
  loadDraftReview,
  mismatchList,
  pct,
  splitLevelCodes,
  type CableDraftRow,
  type DeviceDraftRow,
  type DraftFilter,
  type DraftReviewData,
  type Endpoint,
  type LevelKey,
  type Side,
  type SortKey,
} from './model';
import { SourceCrops } from './SourceCrop';

type Tab = 'devices' | 'cables';

const CONFLICT_TEXT: Readonly<Record<string, string>> = {
  'model:SR/LR': 'SR or LR — the BOM does not say which',
  'qty:bom≠riser': 'BOM and riser quantities differ',
  'cards:bom≠riser': 'Option cards differ between BOM and riser',
  'source:riser_only': 'On the riser, not in the BOM',
  'pairing:ebdk≠erp': 'EBDKs and relay panels do not pair one to one',
  'network:no_N_run': 'No network (N) run drawn to it',
  'confidence:low': 'Low confidence reading',
  'endpoint:low_confidence': 'Far end is a guess (under 0.7)',
  'endpoint:unresolved': 'Far end not found',
  'code:unknown': 'A line with no wire code — what is it?',
};

/** A conflict's sentence; a split-floor one names the two codes the server flagged (T172). */
function conflictText(c: string): string {
  const split = splitLevelCodes(c);
  return split ? `A panel-class device on a split floor: ${split.join(' or ')}?` : (CONFLICT_TEXT[c] ?? c);
}

const STATE_LABEL: Record<string, string> = { proposed: '', accepted: '✓ accepted', edited: '✓ edited', rejected: '✗ rejected' };

/**
 * Setup step 4, Review drafts (T44, Phase 3 §3.3, D193): per level, the BOM / riser / hand-typed
 * device and cable drafts with confidence and source, the side panel with candidates and source
 * crops, Accept / Edit / Reject / Reopen, Accept all ≥ 0.9, the mismatch list and the excluded
 * BOM lines (Promote, D12); the Cables tab with endpoint pickers and Confirm endpoint (D6). Every
 * edit is an op, so the decisions work offline; crops, excluded lines and the riser blob need the
 * server.
 */
export function DraftReview({ projectId, focus }: { projectId: string; focus?: string | null }) {
  const identity = useIdentity();
  const dataKey = syncDataKey(useSyncStatus());
  const [store, setStore] = useState<Store | null>(null);
  const [data, setData] = useState<DraftReviewData | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [levelKey, setLevelKey] = useState<LevelKey | null>(null);
  const [tab, setTab] = useState<Tab>('devices');
  const [filter, setFilter] = useState<DraftFilter>('open');
  const [sort, setSort] = useState<SortKey>('confidence');
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const panelRef = useRef<ScrollView>(null);
  const panelContent = useRef(0);

  /** Scroll the side panel so `field` sits near its top, its results above the keyboard (T187). */
  const revealInPanel = useCallback((field: TextInput | null) => {
    const scroll = panelRef.current;
    // getInnerViewRef is on ScrollView at runtime (RN 0.86) but missing from its legacy .d.ts
    const inner = (scroll as unknown as { getInnerViewRef?: () => View | null } | null)?.getInnerViewRef?.();
    const outer = scroll?.getNativeScrollRef();
    if (!scroll || !inner || !outer || !field) return;
    field.measureLayout(
      inner,
      (_x, y) =>
        outer.measureInWindow((_wx, top, _w, height) => {
          const kb = Keyboard.metrics();
          const covered = kb ? top + height - kb.screenY : 0;
          scroll.scrollTo({ y: revealOffset({ y, margin: space.md, content: panelContent.current, view: height, covered }), animated: true });
        }),
      () => undefined,
    );
  }, []);

  const editor = useMemo(() => (store ? new Editor(store, { projectId, userId: identity.user.id }) : null), [store, projectId, identity.user.id]);

  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (!store) return;
    let live = true;
    loadDraftReview(store, projectId).then(
      (d) => {
        if (!live) return;
        setData(d);
        // first load: the focused draft's level, else the first level with open drafts
        setLevelKey((k) => {
          if (k && d.levels.some((l) => l.key === k)) return k;
          const f = focus ? [...d.devices, ...d.cables].find((x) => x.id === focus) : undefined;
          if (f) {
            if (d.cables.some((c) => c.id === f.id)) setTab('cables');
            setFilter('all');
            return f.levelId ?? d.levels.find((l) => l.code === f.levelCode)?.key ?? null;
          }
          return (d.levels.find((l) => l.open > 0) ?? d.levels[0])?.key ?? null;
        });
      },
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [store, projectId, reload, dataKey, focus]);
  useEffect(() => {
    let live = true;
    listImports(identity, projectId).then(
      (b) => live && setBatches(b),
      () => live && setBatches(null),
    );
    return () => {
      live = false;
    };
  }, [identity, projectId, reload]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, done?: string) => {
      setError(null);
      setNotice(null);
      try {
        const r = await fn();
        setNotice(typeof r === 'string' ? r : (done ?? null));
        setReload((n) => n + 1);
      } catch (e) {
        setError(e instanceof DraftError ? e.message : `Not saved: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [],
  );

  if (!data || !store || !editor) return <Text style={styles.dim}>Loading drafts…</Text>;
  const level = data.levels.find((l) => l.key === levelKey) ?? null;
  if (!level) {
    return (
      <View style={styles.pad}>
        <Text style={styles.h1}>Review drafts</Text>
        <Text style={styles.dim}>No levels and no drafts yet.</Text>
      </View>
    );
  }
  const counts = levelCounts(data, level.key);
  const devices = devicesOn(data, level.key, filter, sort);
  const cables = cablesOn(data, level.key, filter, sort);
  const mismatches = mismatchList(data, level.key);
  const selDevice = data.devices.find((d) => d.id === selected) ?? null;
  const selCable = data.cables.find((c) => c.id === selected) ?? null;
  const riserBlob = batches ? riserBlobFor(batches, typeof selCable?.sourceRef?.file === 'string' ? selCable.sourceRef.file : null) : null;
  const ready = readyCables(data).length;

  const bulkCount = tab === 'devices' ? bulkDevices(data, level.key).length : bulkCables(data, level.key).length;
  const bulk = () => {
    Alert.alert(
      `Accept all ≥ 0.9 on ${level.code}?`,
      `Every open ${tab === 'devices' ? 'device' : 'cable'} draft at 0.9 or over with no conflict is accepted.${tab === 'cables' ? ' Their endpoints stay unconfirmed.' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept all',
          onPress: () =>
            void run(async () => {
              const accepted = tab === 'devices' ? bulkDevices(data, level.key) : [];
              const n = await acceptAll(editor, store, data, level.key, tab, { riserBlob: batches ? riserBlobFor(batches, null) : null });
              // the types they bring that wait for a first-use answer, listed once (T200), never one per draft
              askTypeSetup(await questionsForDrafts(store, accepted));
              return `${n} accepted`;
            }),
        },
      ],
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.h1}>Review drafts</Text>
        <Text style={styles.counts}>
          Devices {counts.devices} · Cables {counts.cables} · Needs review {counts.review}
        </Text>
        <View style={{ flex: 1 }} />
        <Btn title={`Accept all ✓ ≥ 0.9 (${bulkCount})`} small primary disabled={bulkCount === 0} onPress={bulk} />
      </View>
      <ScrollView horizontal style={styles.levels} contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
        {data.levels.map((l) => (
          <Chip key={l.key} on={l.key === level.key} label={`${l.code}${l.open ? ` · ${l.open}` : ''}`} dim={!l.inScope} onPress={() => (setLevelKey(l.key), setSelected(null))} testID={`drafts.level.${l.code}`} />
        ))}
      </ScrollView>
      <View style={styles.chips}>
        <Chip label={`Devices (${counts.devices})`} on={tab === 'devices'} onPress={() => (setTab('devices'), setSelected(null), setAdding(false))} testID="drafts.tab.devices" />
        <Chip label={`Cables (${counts.cables})`} on={tab === 'cables'} onPress={() => (setTab('cables'), setSelected(null), setAdding(false))} testID="drafts.tab.cables" />
        <Text style={styles.sep}>|</Text>
        {FILTERS.map(([f, t]) => (
          <Chip key={f} label={t} on={filter === f} onPress={() => setFilter(f)} testID={`drafts.filter.${f}`} />
        ))}
        <Text style={styles.sep}>|</Text>
        {(['confidence', 'model', 'state'] as SortKey[]).map((s) => (
          <Chip key={s} label={`Sort: ${s}`} on={sort === s} onPress={() => setSort(s)} />
        ))}
        <Chip label={tab === 'devices' ? '+ Draft device' : '+ Draft cable'} testID={tab === 'devices' ? 'drafts.addDevice' : 'drafts.addCable'} on={adding} onPress={() => (setAdding((a) => !a), setSelected(null))} />
        {ready ? <Chip label={`Make ${ready} waiting cable${ready === 1 ? '' : 's'}`} onPress={() => void run(async () => `${await commitWaitingCables(editor, store, projectId, { riserBlob: batches ? riserBlobFor(batches, null) : null })} cables made`)} /> : null}
      </View>
      <Notice text={error} error />
      <Notice text={notice} testID="drafts.notice" />

      <View style={styles.body}>
        <ScrollView style={styles.left} contentContainerStyle={styles.leftBody}>
          {tab === 'devices' ? <DeviceTable rows={devices} selected={selected} onSelect={(id) => (setSelected(id), setAdding(false))} /> : <CableTable rows={cables} selected={selected} onSelect={(id) => (setSelected(id), setAdding(false))} />}
          <Text style={styles.h2}>Mismatch list ({level.code})</Text>
          {mismatches.length ? (
            mismatches.map((m, i) => (
              <Pressable key={`${m.draftId}${i}`} onPress={() => (setTab(m.kind === 'device' ? 'devices' : 'cables'), setFilter('all'), setSelected(m.draftId))}>
                <Text style={styles.mismatch}>• {m.text}</Text>
              </Pressable>
            ))
          ) : (
            <Text style={styles.dim}>Nothing on this level disagrees between the sources.</Text>
          )}
          {tab === 'devices' ? <Excluded batches={batches} data={data} level={level.levelId} levelCode={level.code} run={run} editor={editor} projectId={projectId} /> : null}
        </ScrollView>
        <ScrollView
          ref={panelRef}
          style={styles.panel}
          contentContainerStyle={{ padding: space.lg, gap: 10, paddingBottom: 60 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          onContentSizeChange={(_w, h) => (panelContent.current = h)}
        >
          {adding ? (
            tab === 'devices' ? (
              <AddDevice levels={data.levels} levelId={level.levelId} onAdd={(f) => run(() => addDeviceDraft(editor, projectId, f).then((id) => (setSelected(id), setAdding(false), 'Draft added')))} />
            ) : (
              <AddCable levels={data.levels} codes={data.codes} levelId={level.levelId} onAdd={(f) => run(() => addCableDraft(editor, projectId, f, data.codes).then((id) => (setSelected(id), setAdding(false), 'Draft added')))} />
            )
          ) : selDevice ? (
            <DevicePanel key={selDevice.id} d={selDevice} data={data} batches={batches} identity={identity} editor={editor} store={store} run={run} />
          ) : selCable ? (
            <CablePanel key={selCable.id} projectId={projectId} c={selCable} data={data} batches={batches} identity={identity} editor={editor} store={store} riserBlob={riserBlob} run={run} reveal={revealInPanel} />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

/** The screen's chips on the system's `Chip` (T180); `dim` = an out-of-scope level. */
function Chip({ label, on, onPress, dim, testID }: { label: string; on?: boolean; onPress: () => void; dim?: boolean; testID?: string }) {
  return <UiChip small label={label} selected={!!on} onPress={onPress} testID={testID} style={dim && !on ? styles.chipDim : undefined} />;
}

function StateCell({ state, flagged, extra }: { state: string; flagged: boolean; extra?: string }) {
  if (state !== 'proposed') return <Text style={[styles.cState, state === 'rejected' ? styles.red : styles.green]}>{STATE_LABEL[state]}</Text>;
  return <Text style={[styles.cState, flagged && styles.warn]}>{extra ?? (flagged ? '⚠ review' : '')}</Text>;
}

function DeviceTable({ rows, selected, onSelect }: { rows: DeviceDraftRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <View>
      <View style={styles.thead}>
        {['Model', 'Name', 'Category', 'Qty', 'Conf', 'Src', ''].map((h, i) => (
          <Th key={i} col={[styles.cModel, styles.cName, styles.cCat, styles.cQty, styles.cConf, styles.cSrc, styles.cState][i]} title={h} />
        ))}
      </View>
      {rows.map((d) => (
        <Pressable key={d.id} onPress={() => onSelect(d.id)} style={[styles.tr, selected === d.id && styles.trOn]} testID={`drafts.device.${d.model ?? d.id}`}>
          <Text style={styles.cModel} numberOfLines={1}>
            {d.needs.model ? `${d.candidates[0]?.replace(/-(SR|LR)$/, '')}-?` : (d.model ?? '?')}
          </Text>
          <Text style={styles.cName} numberOfLines={1}>
            {d.name ?? ''}
          </Text>
          <Text style={styles.cCat} numberOfLines={1}>
            {d.category ?? '—'}
          </Text>
          <Text style={[styles.cQty, d.needs.qty && styles.warn]}>
            {d.qty ?? '?'}
            {d.needs.qty ? ' ⚠' : ''}
          </Text>
          <Text style={[styles.cConf, d.confidence != null && d.confidence < 0.7 && styles.warn]}>{pct(d.confidence)}</Text>
          <Text style={styles.cSrc}>{d.src}</Text>
          <StateCell state={d.state} flagged={d.flagged} />
        </Pressable>
      ))}
      {rows.length === 0 ? <Text style={styles.dim}>No device drafts here under this filter.</Text> : null}
    </View>
  );
}

/** A header cell: the column's width, the label's font, one line (a narrow column shrinks the word rather than breaking it, T194). */
function Th({ col, title }: { col: StyleProp<TextStyle>; title: string }) {
  return (
    <Text style={[col, w.label]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
      {title}
    </Text>
  );
}

function CableTable({ rows, selected, onSelect }: { rows: CableDraftRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <View>
      <View style={styles.thead}>
        {['Code', 'From', 'To', 'To-lvl', 'Conf', 'Src', ''].map((h, i) => (
          <Th key={i} col={[styles.cCode, styles.cFrom, styles.cTo, styles.cQty, styles.cConf, styles.cSrc, styles.cState][i]} title={h} />
        ))}
      </View>
      {rows.map((c) => (
        <Pressable key={c.id} onPress={() => onSelect(c.id)} style={[styles.tr, selected === c.id && styles.trOn]} testID={`drafts.cable.${c.code ?? 'unknown'}`}>
          <Text style={[styles.cCode, !c.code && styles.warn]}>{c.code ?? '?'}</Text>
          <Text style={styles.cFrom} numberOfLines={1}>
            {c.ends.from?.label ?? c.fromLabel ?? '—'}
          </Text>
          <Text style={[styles.cTo, !c.ends.to && styles.warn]} numberOfLines={1}>
            {c.ends.to?.label ?? (c.toLabel ? `“${c.toLabel}”` : '— pick')}
          </Text>
          <Text style={styles.cQty}>{c.toLevelCode ?? ''}</Text>
          <Text style={[styles.cConf, c.confidence != null && c.confidence < 0.7 && styles.warn]}>{pct(c.confidence)}</Text>
          <Text style={styles.cSrc}>{c.src}</Text>
          {c.waiting ? <Text style={[styles.cState, styles.warn]}>✓ waits for placing</Text> : <StateCell state={c.state} flagged={c.flagged} />}
        </Pressable>
      ))}
      {rows.length === 0 ? <Text style={styles.dim}>No cable drafts here under this filter.</Text> : null}
    </View>
  );
}

function Radio({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.radio} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={[styles.radioText, on && styles.radioOn]}>
        {on ? '◉' : '○'} {label}
      </Text>
    </Pressable>
  );
}

function Line({ k, v, testID }: { k: string; v: string; testID?: string }) {
  return (
    <Text style={styles.kv} testID={testID}>
      <Text style={styles.k}>{k} </Text>
      {v}
    </Text>
  );
}

const REJECT_REASONS = ['Already in the baseline (master)', 'Not a device we survey', 'Out of scope floor', 'Duplicate draft'];

function RejectForm({ onReject }: { onReject: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <Btn title="Reject…" small onPress={() => setOpen(true)} testID="draft.reject" />;
  return (
    <View style={styles.form}>
      <Text style={w.label}>Why reject it?</Text>
      <View style={styles.chips}>
        {REJECT_REASONS.map((r) => (
          <Chip key={r} label={r} on={reason === r} onPress={() => setReason(r)} />
        ))}
      </View>
      <TextInput style={w.input} value={reason} onChangeText={setReason} placeholder="Reason" placeholderTextColor={color.text3} testID="draft.reject.reason" />
      <FormActions>
        <Btn title="Cancel" small onPress={() => setOpen(false)} />
        <Btn title="Reject" small disabled={!reason.trim()} onPress={() => onReject(reason)} testID="draft.reject.submit" />
      </FormActions>
    </View>
  );
}

function DevicePanel({ d, data, batches, identity, editor, store, run }: { d: DeviceDraftRow; data: DraftReviewData; batches: Batch[] | null; identity: ReturnType<typeof useIdentity>; editor: Editor; store: Store; run: Run }) {
  const [choice, setChoice] = useState<DeviceChoice>({});
  const [editing, setEditing] = useState(false);
  const blockers = deviceBlockers(d, choice);
  const fold = d.accessoryOf && d.state !== 'rejected' ? foldBlockers(data, d) : null;
  const lvl = (id: string | null) => data.levels.find((l) => l.levelId === id)?.code ?? null;
  return (
    <>
      <Text style={styles.h2}>
        Draft device {d.conflicts.length ? '⚠ conflict' : ''} <Text style={styles.dim}>{STATE_LABEL[d.state]}</Text>
      </Text>
      {fold ? (
        <View style={styles.form}>
          <Text style={styles.warn}>
            ⚑ An accessory, not a device: the library files {d.accessoryOf!.model} as another type's accessory.
            {d.accessoryOf!.parentLabel ? ` It is an accessory of ${d.accessoryOf!.parentLabel}.` : ' No draft of this level lists it.'}
          </Text>
          {fold.length ? <Text style={styles.dim}>{fold.join(' ')}</Text> : null}
          <View style={styles.btnRow}>
            {d.accessoryOf!.parentLabel ? <Btn title={`Fold into ${d.accessoryOf!.parentLabel}`} primary small disabled={fold.length > 0} onPress={() => void run(() => foldAccessory(editor, store, data, d), 'Folded into its parent')} /> : null}
            {d.state !== 'proposed' && d.placed === 0 ? <RejectForm onReject={(r) => void run(() => rejectDraft(editor, 'device', d, r), 'Rejected')} /> : null}
          </View>
        </View>
      ) : null}
      {d.needs.model ? (
        <View>
          <Text style={w.label}>Model — pick one</Text>
          {d.needs.model.options.map((m) => (
            <Radio key={m} label={m} on={choice.model === m} onPress={() => setChoice((c) => ({ ...c, model: m }))} />
          ))}
        </View>
      ) : (
        <Line k="Model" v={`${d.model ?? '?'}${d.modelRaw && d.modelRaw !== d.model ? `  (BOM: ${d.modelRaw})` : ''}`} />
      )}
      {d.name ? <Line k="Name" v={d.name} /> : null}
      {d.needs.category ? (
        <View>
          <Text style={w.label}>Category — pick one</Text>
          <View style={styles.chips}>
            {DEVICE_CATEGORIES.map((c) => (
              <Chip key={c} label={c} on={choice.category === c} onPress={() => setChoice((x) => ({ ...x, category: c }))} />
            ))}
          </View>
        </View>
      ) : (
        <Line k="Category" v={d.category ?? '—'} />
      )}
      {d.needs.qty ? (
        <View>
          <Text style={w.label}>Quantity — the sources differ</Text>
          {d.needs.qty.bom != null ? <Radio label={`BOM ${d.needs.qty.bom}`} on={choice.qty === d.needs.qty.bom} onPress={() => setChoice((c) => ({ ...c, qty: d.needs.qty!.bom }))} /> : null}
          {d.needs.qty.riser != null ? <Radio label={`Riser ${d.needs.qty.riser}`} on={choice.qty === d.needs.qty.riser} onPress={() => setChoice((c) => ({ ...c, qty: d.needs.qty!.riser }))} /> : null}
        </View>
      ) : (
        <Line k="Qty" v={String(d.qty ?? '?')} />
      )}
      {d.needs.level ? (
        <View>
          <Text style={w.label}>Level — pick one</Text>
          {d.needs.level.options.map((o) => (
            <Radio key={o.id} label={o.code} on={choice.levelId === o.id} onPress={() => setChoice((c) => ({ ...c, levelId: o.id }))} />
          ))}
        </View>
      ) : (
        <Line k="Level" v={`${d.levelCode ?? 'pool (no level)'}  · basis: ${d.levelBasis ?? '—'}`} testID="draft.level" />
      )}
      <Line k="Confidence" v={`${pct(d.confidence)}${d.extraction ? ` (${d.extraction})` : ''}`} />
      {d.accessories.length ? <Line k="Accessories" v={d.accessories.map((a) => `${a.model} ×${a.qty ?? '?'}${a.role === 'component' ? ' (component)' : ''}`).join(' · ')} /> : null}
      {d.conflicts.map((c) => (
        <Text key={c} style={styles.warn}>
          ⚠ {conflictText(c)}
        </Text>
      ))}
      {d.reviewItemId ? <Text style={styles.warn}>⚑ Source conflict with the master's count.</Text> : null}
      {d.onLevel ? <Text style={styles.dim}>{d.onLevel} device{d.onLevel === 1 ? '' : 's'} of this model already on {lvl(d.levelId)} (the baseline).</Text> : null}
      {d.placed ? <Text style={styles.dim}>{d.placed} placed from this draft.</Text> : null}

      <Text style={w.label}>Source crops</Text>
      <SourceCrops identity={identity} batches={batches} sources={d.sources} />

      {d.state === 'proposed' ? (
        <>
          {blockers.length ? <Text style={styles.dim}>{blockers.join(' ')}</Text> : null}
          <View style={styles.btnRow}>
            <Btn
              title="Accept"
              primary
              small
              disabled={blockers.length > 0}
              onPress={() =>
                void run(async () => {
                  await acceptDevice(editor, d, choice);
                  // first use of its type (T200): the model as accepted, and its accessory lines
                  askTypeSetup(await questionsForDrafts(store, [{ model: choice.model ?? d.model, category: choice.category ?? d.category, accessories: d.accessories }]));
                }, 'Accepted')
              }
              testID="draft.accept"
            />
            <Btn title="Edit…" small onPress={() => setEditing((e) => !e)} testID="draft.edit" />
            <RejectForm onReject={(r) => void run(() => rejectDraft(editor, 'device', d, r), 'Rejected')} />
          </View>
        </>
      ) : d.placed === 0 ? (
        <View style={styles.btnRow}>
          <Btn title="Reopen" small onPress={() => void run(() => reopenDraft(editor, 'device', d), 'Reopened')} />
          {d.state !== 'rejected' ? <Btn title="Edit…" small onPress={() => setEditing((e) => !e)} /> : null}
        </View>
      ) : null}
      {editing ? <EditDevice d={d} levels={data.levels} onSave={(f) => void run(() => editDevice(editor, d, f).then(() => setEditing(false)), 'Saved and accepted')} /> : null}
    </>
  );
}

function EditDevice({ d, levels, onSave }: { d: DeviceDraftRow; levels: DraftReviewData['levels']; onSave: (f: { model: string; category: string | null; qty: number | null; name: string | null; levelId: string | null }) => void }) {
  const [model, setModel] = useState(d.model ?? '');
  const [category, setCategory] = useState<string | null>(d.category);
  const [qty, setQty] = useState(d.qty != null ? String(d.qty) : '');
  const [name, setName] = useState(d.name ?? '');
  const [levelId, setLevelId] = useState<string | null>(d.levelId);
  // Save & accept leads the form, so it stays above the keyboard while a field is typed in (T175 → T180:
  // at the end of the form it fell under the keyboard in portrait)
  return (
    <View style={styles.form}>
      <Btn title="Save & accept" testID="draft.save" primary small onPress={() => onSave({ model, category, qty: qty.trim() ? Number(qty) : null, name: name || null, levelId })} />
      <Text style={w.label}>Model</Text>
      <TextInput style={w.input} value={model} onChangeText={setModel} autoCapitalize="characters" autoCorrect={false} testID="draft.edit.model" />
      {d.candidates.length > 1 ? (
        <View style={styles.chips}>
          {d.candidates.map((m) => (
            <Chip key={m} label={m} on={model === m} onPress={() => setModel(m)} />
          ))}
        </View>
      ) : null}
      <Text style={w.label}>Category</Text>
      <View style={styles.chips}>
        {DEVICE_CATEGORIES.map((c) => (
          <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} testID={`draft.edit.cat.${c}`} />
        ))}
      </View>
      <View style={styles.btnRow}>
        <View style={{ width: 90 }}>
          <Text style={w.label}>Qty</Text>
          <TextInput style={w.input} value={qty} onChangeText={setQty} keyboardType="number-pad" testID="draft.edit.qty" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={w.label}>Name (panel tag)</Text>
          <TextInput style={w.input} value={name} onChangeText={setName} autoCapitalize="characters" autoCorrect={false} />
        </View>
      </View>
      <Text style={w.label}>Level</Text>
      <View style={styles.chips}>
        <Chip label="pool (no level)" on={levelId === null} onPress={() => setLevelId(null)} />
        {levels
          .filter((l) => l.levelId)
          .map((l) => (
            <Chip key={l.key} label={l.code} on={levelId === l.levelId} onPress={() => setLevelId(l.levelId)} />
          ))}
      </View>
    </View>
  );
}

function CablePanel({
  projectId,
  c,
  data,
  batches,
  identity,
  editor,
  store,
  riserBlob,
  run,
  reveal,
}: {
  projectId: string;
  c: CableDraftRow;
  data: DraftReviewData;
  batches: Batch[] | null;
  identity: ReturnType<typeof useIdentity>;
  editor: Editor;
  store: Store;
  riserBlob: string | null;
  run: Run;
  reveal: (field: TextInput | null) => void;
}) {
  const [picking, setPicking] = useState<Side | null>(null);
  const blockers = cableBlockers(c);
  const open = c.state === 'proposed';
  const endLine = (side: Side) => {
    const e = c.ends[side];
    if (!e) return '— not set';
    const real = realEnd(data, e);
    const what = e.kind === 'draft_device' ? (real ? `  → ${real.text} (in the baseline)` : '  (not placed yet)') : e.kind === 'placeholder' ? '  (placeholder)' : '';
    return `${e.label}${what}${e.riser ? `  · riser: ${e.riser}` : ''}`;
  };
  return (
    <>
      <Text style={styles.h2}>
        Draft cable {c.code ?? '?'} {c.conflicts.length ? '⚠' : ''} <Text style={styles.dim}>{STATE_LABEL[c.state]}</Text>
      </Text>
      {open && c.unknownCode ? (
        <View>
          <Text style={w.label}>What is this cable? Pick its code</Text>
          {c.codeGuess ? (
            <Text style={styles.dim}>
              Guess: {c.codeGuess.value}
              {c.codeGuess.reason === 'load' ? ' (load circuits) to Fixtures' : ''} ({pct(c.codeGuess.confidence)}, {c.codeGuess.source === 'label' ? 'from the text at the line’s end' : 'the model’s reading'})
            </Text>
          ) : null}
          <View style={styles.chips}>
            {data.codes.map((k) => (
              <Chip key={k} label={k === c.codeGuess?.value && c.code !== k ? `${k} ?` : k} on={c.code === k} onPress={() => void run(() => setCableCode(editor, store, data, c.id, k))} />
            ))}
          </View>
        </View>
      ) : open ? (
        <View>
          <Text style={w.label}>Cable code{c.codeEdited ? `  (was ${c.codeWas ?? 'none'})` : ''}</Text>
          <View style={styles.chips}>
            {data.codes.map((k) => (
              <Chip key={k} label={k} on={c.code === k} onPress={() => void run(() => setCableCode(editor, store, data, c.id, k))} />
            ))}
          </View>
        </View>
      ) : null}
      <Text style={styles.dim}>
        The riser reads: {c.fromLabel ?? '?'} → {c.toLabel ?? '(nothing)'} {c.toLevelCode ? `· level ${c.toLevelCode}` : ''} · confidence {pct(c.confidence)}
      </Text>
      {(['from', 'to'] as const).map((side) => (
        <View key={side} style={styles.end}>
          <Text style={w.label}>{side === 'from' ? 'From' : 'To'}</Text>
          <Text style={[styles.endText, !c.ends[side] && styles.warn]}>{endLine(side)}</Text>
          {open ? <Btn title={picking === side ? 'Close' : 'Change…'} small onPress={() => setPicking((p) => (p === side ? null : side))} testID={`draft.cable.change.${side}`} /> : null}
          {picking === side ? <EndpointPicker c={c} side={side} data={data} reveal={reveal} onPick={(e) => void run(() => setEndpoint(editor, store, c.id, side, e).then(() => setPicking(null)), 'Endpoint set')} /> : null}
        </View>
      ))}
      {c.conflicts.map((k) => (
        <Text key={k} style={styles.warn}>
          ⚠ {conflictText(k)}
        </Text>
      ))}
      <Text style={w.label}>Riser crop</Text>
      <SourceCrops identity={identity} batches={batches} sources={c.sources} />
      {open ? (
        <>
          {blockers.length ? <Text style={styles.dim}>{blockers.join(' ')}</Text> : null}
          <View style={styles.btnRow}>
            <Btn title="Confirm endpoint ✓" testID="draft.cable.confirm" primary small disabled={blockers.length > 0} onPress={() => void run(() => acceptCable(editor, store, data, c, { confirm: true, riserBlob }).then(cableNote))} />
            <Btn title="Accept unconfirmed" small disabled={blockers.length > 0} onPress={() => void run(() => acceptCable(editor, store, data, c, { confirm: false, riserBlob }).then(cableNote))} />
            <RejectForm onReject={(r) => void run(() => rejectDraft(editor, 'cable', c, r), 'Rejected')} />
          </View>
        </>
      ) : c.committed ? (
        <Pressable onPress={() => router.push({ pathname: '/cables', params: { project: projectId } })} hitSlop={space.sm}>
          <Text style={styles.link}>Its cable is made{c.confirmed ? ', endpoints confirmed' : ' (unconfirmed ⚑)'}. Open Cable / riser ▸</Text>
        </Pressable>
      ) : c.state === 'rejected' ? (
        <Btn title="Reopen" small onPress={() => void run(() => reopenDraft(editor, 'cable', c), 'Reopened')} />
      ) : (
        <>
          <Text style={styles.warn}>Accepted — the cable is made once its draft-device end is placed.</Text>
          <Btn title="Reopen" small onPress={() => void run(() => reopenDraft(editor, 'cable', c), 'Reopened')} />
        </>
      )}
    </>
  );
}

function cableNote(r: { linked: boolean; waiting: boolean; pending: boolean }): string {
  if (r.waiting) return 'Accepted — both ends are drafts: it waits for one of them to be placed';
  if (r.pending) return 'Accepted — the cable is made on the placed end; its far end follows when that draft is placed';
  return r.linked ? 'Accepted — the baseline already had this cable; the riser crop is now on it' : 'Accepted — the cable is made';
}

/**
 * Change… on a cable end. The box sits low in the side panel, so while it has focus the panel
 * scrolls it near its top and the results list above the keyboard (T187): on focus when the
 * keyboard is already up, else once the keyboard has shown (its inset is in place by then).
 */
function EndpointPicker({ c, side, data, reveal, onPick }: { c: CableDraftRow; side: Side; data: DraftReviewData; reveal: (field: TextInput | null) => void; onPick: (e: Endpoint | null) => void }) {
  const [q, setQ] = useState('');
  const input = useRef<TextInput>(null);
  const options = endpointOptions(data, c, side, q).slice(0, 40);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (input.current?.isFocused()) reveal(input.current);
    });
    return () => sub.remove();
  }, [reveal]);
  return (
    <View style={styles.form}>
      <TextInput
        ref={input}
        onFocus={() => {
          if (Keyboard.isVisible()) reveal(input.current);
        }}
        style={w.input}
        value={q} onChangeText={setQ} placeholder="Search devices, drafts, placeholders (any level)" placeholderTextColor={color.text3} autoCorrect={false} testID="draft.cable.search" />
      {options.map((e) => (
        <Pressable key={`${e.kind}:${e.id}`} onPress={() => onPick(e)} style={styles.option} testID="draft.cable.option">
          <Text style={styles.optionText}>
            {e.kind === 'device' ? '▣' : e.kind === 'draft_device' ? '◌' : '⌂'} {e.label}
            {e.confidence != null ? `  · ${pct(e.confidence)}` : ''}
            {e.riser ? `  · riser: ${e.riser}` : ''}
          </Text>
        </Pressable>
      ))}
      {options.length === 0 ? <Text style={styles.dim}>Nothing matches.</Text> : null}
      {c.chosen[side] ? <Btn title="Clear my choice" small onPress={() => onPick(null)} /> : null}
    </View>
  );
}

function AddDevice({ levels, levelId, onAdd }: { levels: DraftReviewData['levels']; levelId: string | null; onAdd: (f: { levelId: string | null; model: string; category: string; qty: number; name: string | null }) => void }) {
  const [model, setModel] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [qty, setQty] = useState('1');
  const [name, setName] = useState('');
  const [lvl, setLvl] = useState<string | null>(levelId);
  return (
    <View style={styles.form}>
      <Text style={styles.h2}>Add a device draft by hand</Text>
      <Text style={w.label}>Model</Text>
      <TextInput style={w.input} value={model} onChangeText={setModel} autoCapitalize="characters" autoCorrect={false} placeholder="PI1002" placeholderTextColor={color.text3} testID="drafts.new.model" />
      <Text style={w.label}>Category</Text>
      <View style={styles.chips}>
        {DEVICE_CATEGORIES.map((c) => (
          <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} testID={`drafts.new.cat.${c}`} />
        ))}
      </View>
      <View style={styles.btnRow}>
        <View style={{ width: 90 }}>
          <Text style={w.label}>Qty</Text>
          <TextInput style={w.input} value={qty} onChangeText={setQty} keyboardType="number-pad" testID="drafts.new.qty" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={w.label}>Name (panel tag)</Text>
          <TextInput style={w.input} value={name} onChangeText={setName} autoCapitalize="characters" autoCorrect={false} />
        </View>
      </View>
      <Text style={w.label}>Level</Text>
      <View style={styles.chips}>
        {levels
          .filter((l) => l.levelId)
          .map((l) => (
            <Chip key={l.key} label={l.code} on={lvl === l.levelId} onPress={() => setLvl(l.levelId)} testID={`drafts.new.level.${l.code}`} />
          ))}
      </View>
      <Btn title="Add draft" testID="drafts.new.add" primary small disabled={!model.trim() || !category} onPress={() => category && onAdd({ levelId: lvl, model, category, qty: Number(qty), name: name || null })} />
    </View>
  );
}

function AddCable({
  levels,
  codes,
  levelId,
  onAdd,
}: {
  levels: DraftReviewData['levels'];
  codes: readonly string[];
  levelId: string | null;
  onAdd: (f: { levelId: string | null; code: string; fromLabel: string; toLabel: string; toLevelId: string | null }) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [toLevel, setToLevel] = useState<string | null>(null);
  return (
    <View style={styles.form}>
      <Text style={styles.h2}>Add a cable draft by hand</Text>
      <Text style={w.label}>Code</Text>
      <View style={styles.chips}>
        {codes.map((k) => (
          <Chip key={k} label={k} on={code === k} onPress={() => setCode(k)} testID={`drafts.new.code.${k}`} />
        ))}
      </View>
      <Text style={w.label}>From (as written)</Text>
      <TextInput style={w.input} value={from} onChangeText={setFrom} autoCorrect={false} placeholder="CT02LCPA" placeholderTextColor={color.text3} testID="drafts.new.from" />
      <Text style={w.label}>To (as written)</Text>
      <TextInput style={w.input} value={to} onChangeText={setTo} autoCorrect={false} placeholder="UFMP4 Level 03" placeholderTextColor={color.text3} testID="drafts.new.to" />
      <Text style={w.label}>Far end level</Text>
      <View style={styles.chips}>
        <Chip label="same level" on={toLevel === null} onPress={() => setToLevel(null)} />
        {levels
          .filter((l) => l.levelId && l.levelId !== levelId)
          .map((l) => (
            <Chip key={l.key} label={l.code} on={toLevel === l.levelId} onPress={() => setToLevel(l.levelId)} />
          ))}
      </View>
      <Btn title="Add draft" testID="drafts.new.addCable" primary small disabled={!code || !from.trim() || !to.trim()} onPress={() => code && onAdd({ levelId, code, fromLabel: from, toLabel: to, toLevelId: toLevel })} />
    </View>
  );
}

function Excluded({ batches, data, level, levelCode, run, editor, projectId }: { batches: Batch[] | null; data: DraftReviewData; level: string | null; levelCode: string; run: Run; editor: Editor; projectId: string }) {
  const [open, setOpen] = useState(false);
  if (batches === null) return <Text style={styles.dim}>Excluded BOM lines: needs a connection to the server.</Text>;
  const all = excludedLines(batches);
  if (!all.length) return null;
  const promoted = promotedKeys(data.devices);
  const here = all.filter((l) => !l.levelCode || l.levelCode === levelCode);
  const levelFor = (l: ExcludedRow) => data.levels.find((x) => x.code === l.levelCode)?.levelId ?? level;
  return (
    <View style={{ marginTop: 14 }}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.fold}>
        <Text style={styles.h2}>
          Excluded BOM lines ({here.length} here, {all.length} in all) {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {open
        ? (here.length ? here : all).map((l) => (
            <View key={l.key} style={styles.excluded}>
              <Text style={styles.exText}>
                {l.model ?? l.part_number ?? '?'} ×{l.qty ?? '?'} — {l.description ?? ''} <Text style={styles.dim}>({l.reason}; p.{String(l.source_ref.page ?? '?')} line {String(l.source_ref.line ?? '?')})</Text>
              </Text>
              {promoted.has(l.key) ? (
                <Text style={styles.green}>promoted ✓</Text>
              ) : (
                <Btn
                  title="Promote…"
                  small
                  // promoteExcluded returns the new draft's id, which run() would show as the notice (T158)
                  onPress={() => void run(() => promoteExcluded(editor, projectId, l.batch, l, levelFor(l)).then(() => 'Promoted — pick its category and Accept'))}
                />
              )}
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // the page's padding stays near the old 14 pt: the device table is tight in portrait
  root: { flex: 1, paddingHorizontal: space.md, paddingVertical: space.md, gap: space.sm },
  pad: { paddingHorizontal: space.xl, paddingVertical: space.lg, gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  h1: { ...font.title, color: color.text },
  h2: { ...font.headline, color: color.text, marginTop: 6 },
  counts: { ...font.callout, ...tabular, color: color.text2 },
  levels: { flexGrow: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  chipDim: { opacity: 0.6 },
  sep: { ...font.callout, color: color.muted },
  body: { flex: 1, flexDirection: 'row', gap: space.sm, marginTop: 6 },
  // ScrollViews carry their own flexGrow: 1, which beats `flex`: the 3 : 2 split needs flexGrow + flexBasis 0 (T194)
  left: { flexGrow: 3, flexShrink: 1, flexBasis: 0, backgroundColor: color.surface, borderRadius: radius.card, borderWidth: 1, borderColor: color.hairline },
  leftBody: { paddingBottom: 40, paddingHorizontal: space.sm },
  panel: { flexGrow: 2, flexShrink: 1, flexBasis: 0, backgroundColor: color.surface, borderRadius: radius.card, borderWidth: 1, borderColor: color.hairline },
  thead: { flexDirection: 'row', gap: 6, paddingVertical: 6, paddingHorizontal: space.sm, marginTop: space.sm, marginBottom: 2, borderRadius: radius.control, backgroundColor: color.surface2, borderBottomWidth: 1, borderColor: color.hairline },
  tr: { flexDirection: 'row', gap: 6, minHeight: 44, paddingVertical: 9, borderBottomWidth: 1, borderColor: color.hairline, alignItems: 'center' },
  trOn: { backgroundColor: color.primaryTint },
  cModel: { flex: 3, ...font.callout, color: color.text },
  cName: { flex: 2, ...font.caption, color: color.text2 },
  cCat: { flex: 2, ...font.caption, color: color.text2 },
  cQty: { width: 44, ...font.callout, ...tabular, color: color.text },
  cConf: { width: 44, ...font.callout, ...tabular, color: color.text },
  cSrc: { width: 46, ...font.caption, color: color.text2 },
  cState: { width: 92, ...font.caption, color: color.text },
  cCode: { width: 50, ...font.calloutBold, color: color.text },
  cFrom: { flex: 3, ...font.caption, color: color.text },
  cTo: { flex: 4, ...font.caption, color: color.text },
  mismatch: { ...font.callout, color: color.warning, paddingVertical: space.xs },
  kv: { ...font.callout, color: color.text },
  k: { fontWeight: '600', color: color.text2 },
  warn: { color: color.warning },
  red: { color: color.danger },
  green: { color: color.success },
  dim: { ...font.caption, color: color.text3 },
  link: { ...font.callout, color: color.primary },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' },
  form: { gap: space.sm, padding: space.md, borderRadius: radius.control, backgroundColor: color.bg, borderWidth: 1, borderColor: color.hairline },
  radio: { minHeight: 44, justifyContent: 'center' },
  radioText: { ...font.callout, color: color.text },
  radioOn: { fontWeight: '600', color: color.primary },
  end: { gap: space.xs },
  endText: { ...font.callout, color: color.text },
  option: { minHeight: 44, justifyContent: 'center', paddingVertical: space.sm, borderBottomWidth: 1, borderColor: color.hairline },
  optionText: { ...font.callout, color: color.text },
  fold: { minHeight: 44, justifyContent: 'center' },
  excluded: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6, borderBottomWidth: 1, borderColor: color.hairline },
  exText: { flex: 1, ...font.caption, color: color.text },
});
