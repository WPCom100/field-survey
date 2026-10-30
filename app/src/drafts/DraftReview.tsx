import { Editor, type Store } from '@field-survey/core';
import { DEVICE_CATEGORIES } from '@field-survey/rules';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { useIdentity } from '../identity/IdentityGate';
import { Btn, Notice, styles as w } from '../setup/widgets';
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
  promoteExcluded,
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
  'model:SR/LR': 'SR or LR — the BOM does not say which (D28)',
  'qty:bom≠riser': 'BOM and riser quantities differ (D28)',
  'cards:bom≠riser': 'Option cards differ between BOM and riser',
  'level:06/06M': 'A panel-class device on a split floor: 06 or 06M?',
  'source:riser_only': 'On the riser, not in the BOM',
  'pairing:ebdk≠erp': 'EBDKs and relay panels do not pair one to one',
  'network:no_N_run': 'No network (N) run drawn to it',
  'confidence:low': 'Low confidence reading',
  'endpoint:low_confidence': 'Far end is a guess (under 0.7)',
  'endpoint:unresolved': 'Far end not found',
  'code:unknown': 'A line with no wire code — what is it?',
};

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
        <Text style={styles.dim}>No levels and no drafts yet. Upload the BOM and the riser in 3 Sources, or add drafts by hand once levels exist.</Text>
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
  const ready = data.cables.filter((c) => c.waiting && realEnd(data, c.ends.from) && realEnd(data, c.ends.to)).length;

  const bulkCount = tab === 'devices' ? bulkDevices(data, level.key).length : bulkCables(data, level.key).length;
  const bulk = () => {
    Alert.alert(
      `Accept all ≥ 0.9 on ${level.code}?`,
      `Every open ${tab === 'devices' ? 'device' : 'cable'} draft at 0.9 or over with no conflict is accepted, each recorded as reviewed by ${identity.user.name}.${tab === 'cables' ? ' Their endpoints stay unconfirmed (⚑ in the cable view) until confirmed one by one.' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept all', onPress: () => void run(async () => `${await acceptAll(editor, store, data, level.key, tab, { riserBlob: batches ? riserBlobFor(batches, null) : null })} accepted`) },
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
          <Chip key={l.key} on={l.key === level.key} label={`${l.code}${l.open ? ` · ${l.open}` : ''}`} dim={!l.inScope} onPress={() => (setLevelKey(l.key), setSelected(null))} />
        ))}
      </ScrollView>
      <View style={styles.chips}>
        <Chip label={`Devices (${counts.devices})`} on={tab === 'devices'} onPress={() => (setTab('devices'), setSelected(null), setAdding(false))} />
        <Chip label={`Cables (${counts.cables})`} on={tab === 'cables'} onPress={() => (setTab('cables'), setSelected(null), setAdding(false))} />
        <Text style={styles.sep}>|</Text>
        {FILTERS.map(([f, t]) => (
          <Chip key={f} label={t} on={filter === f} onPress={() => setFilter(f)} />
        ))}
        <Text style={styles.sep}>|</Text>
        {(['confidence', 'model', 'state'] as SortKey[]).map((s) => (
          <Chip key={s} label={`Sort: ${s}`} on={sort === s} onPress={() => setSort(s)} />
        ))}
        <Chip label={tab === 'devices' ? '+ Draft device' : '+ Draft cable'} on={adding} onPress={() => (setAdding((a) => !a), setSelected(null))} />
        {ready ? <Chip label={`Make ${ready} waiting cable${ready === 1 ? '' : 's'}`} onPress={() => void run(async () => `${await commitWaitingCables(editor, store, projectId, { riserBlob: batches ? riserBlobFor(batches, null) : null })} cables made`)} /> : null}
      </View>
      <Notice text={error} error />
      <Notice text={notice} />

      <View style={styles.body}>
        <ScrollView style={styles.left} contentContainerStyle={{ paddingBottom: 40 }}>
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
        <ScrollView style={styles.panel} contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          {adding ? (
            tab === 'devices' ? (
              <AddDevice levels={data.levels} levelId={level.levelId} onAdd={(f) => run(() => addDeviceDraft(editor, projectId, f).then((id) => (setSelected(id), setAdding(false), 'Draft added')))} />
            ) : (
              <AddCable levels={data.levels} codes={data.codes} levelId={level.levelId} onAdd={(f) => run(() => addCableDraft(editor, projectId, f, data.codes).then((id) => (setSelected(id), setAdding(false), 'Draft added')))} />
            )
          ) : selDevice ? (
            <DevicePanel key={selDevice.id} d={selDevice} data={data} batches={batches} identity={identity} editor={editor} run={run} />
          ) : selCable ? (
            <CablePanel key={selCable.id} projectId={projectId} c={selCable} data={data} batches={batches} identity={identity} editor={editor} store={store} riserBlob={riserBlob} run={run} />
          ) : (
            <Text style={styles.dim}>Pick a draft on the left. Drafts under 0.7 or with a conflict wait in Needs review (D11); nothing is accepted for you.</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

function Chip({ label, on, onPress, dim }: { label: string; on?: boolean; onPress: () => void; dim?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn, dim && !on && styles.dimText]}>{label}</Text>
    </Pressable>
  );
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
          <Text key={i} style={[w.label, [styles.cModel, styles.cName, styles.cCat, styles.cQty, styles.cConf, styles.cSrc, styles.cState][i]]}>
            {h}
          </Text>
        ))}
      </View>
      {rows.map((d) => (
        <Pressable key={d.id} onPress={() => onSelect(d.id)} style={[styles.tr, selected === d.id && styles.trOn]}>
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

function CableTable({ rows, selected, onSelect }: { rows: CableDraftRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <View>
      <View style={styles.thead}>
        {['Code', 'From', 'To', 'To-lvl', 'Conf', 'Src', ''].map((h, i) => (
          <Text key={i} style={[w.label, [styles.cCode, styles.cFrom, styles.cTo, styles.cQty, styles.cConf, styles.cSrc, styles.cState][i]]}>
            {h}
          </Text>
        ))}
      </View>
      {rows.map((c) => (
        <Pressable key={c.id} onPress={() => onSelect(c.id)} style={[styles.tr, selected === c.id && styles.trOn]}>
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
    <Pressable onPress={onPress} style={styles.radio}>
      <Text style={[styles.radioText, on && styles.radioOn]}>
        {on ? '◉' : '○'} {label}
      </Text>
    </Pressable>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <Text style={styles.kv}>
      <Text style={styles.k}>{k} </Text>
      {v}
    </Text>
  );
}

const REJECT_REASONS = ['Already in the baseline (master)', 'Not a device we survey', 'Out of scope floor', 'Duplicate draft'];

function RejectForm({ onReject }: { onReject: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <Btn title="Reject…" small onPress={() => setOpen(true)} />;
  return (
    <View style={styles.form}>
      <Text style={w.label}>Why reject it?</Text>
      <View style={styles.chips}>
        {REJECT_REASONS.map((r) => (
          <Chip key={r} label={r} on={reason === r} onPress={() => setReason(r)} />
        ))}
      </View>
      <TextInput style={w.input} value={reason} onChangeText={setReason} placeholder="Reason" placeholderTextColor="#9aa0a8" />
      <View style={styles.btnRow}>
        <Btn title="Reject" small disabled={!reason.trim()} onPress={() => onReject(reason)} />
        <Btn title="Cancel" small onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}

function DevicePanel({ d, data, batches, identity, editor, run }: { d: DeviceDraftRow; data: DraftReviewData; batches: Batch[] | null; identity: ReturnType<typeof useIdentity>; editor: Editor; run: Run }) {
  const [choice, setChoice] = useState<DeviceChoice>({});
  const [editing, setEditing] = useState(false);
  const blockers = deviceBlockers(d, choice);
  const lvl = (id: string | null) => data.levels.find((l) => l.levelId === id)?.code ?? null;
  return (
    <>
      <Text style={styles.h2}>
        Draft device {d.conflicts.length ? '⚠ conflict' : ''} <Text style={styles.dim}>{STATE_LABEL[d.state]}</Text>
      </Text>
      {d.needs.model ? (
        <View>
          <Text style={w.label}>Model — pick one; nothing is chosen for you (D28)</Text>
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
        <Line k="Level" v={`${d.levelCode ?? 'pool (no level)'}  · basis: ${d.levelBasis ?? '—'}`} />
      )}
      <Line k="Confidence" v={`${pct(d.confidence)}${d.extraction ? ` (${d.extraction})` : ''}`} />
      {d.accessories.length ? <Line k="Accessories" v={d.accessories.map((a) => `${a.model} ×${a.qty ?? '?'}${a.role === 'component' ? ' (component)' : ''}`).join(' · ')} /> : null}
      {d.conflicts.map((c) => (
        <Text key={c} style={styles.warn}>
          ⚠ {CONFLICT_TEXT[c] ?? c}
        </Text>
      ))}
      {d.reviewItemId ? <Text style={styles.warn}>⚑ Source conflict with the master's count (D30) — Accept or Reject settles it.</Text> : null}
      {d.onLevel ? <Text style={styles.dim}>{d.onLevel} device{d.onLevel === 1 ? '' : 's'} of this model already on {lvl(d.levelId)} (the baseline).</Text> : null}
      {d.placed ? <Text style={styles.dim}>{d.placed} placed from this draft.</Text> : null}

      <Text style={w.label}>Source crops</Text>
      <SourceCrops identity={identity} batches={batches} sources={d.sources} />

      {d.state === 'proposed' ? (
        <>
          {blockers.length ? <Text style={styles.dim}>{blockers.join(' ')}</Text> : null}
          <View style={styles.btnRow}>
            <Btn title="Accept" primary small disabled={blockers.length > 0} onPress={() => void run(() => acceptDevice(editor, d, choice), 'Accepted')} />
            <Btn title="Edit…" small onPress={() => setEditing((e) => !e)} />
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
  return (
    <View style={styles.form}>
      <Text style={w.label}>Model</Text>
      <TextInput style={w.input} value={model} onChangeText={setModel} autoCapitalize="characters" autoCorrect={false} />
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
          <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} />
        ))}
      </View>
      <View style={styles.btnRow}>
        <View style={{ width: 90 }}>
          <Text style={w.label}>Qty</Text>
          <TextInput style={w.input} value={qty} onChangeText={setQty} keyboardType="number-pad" />
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
      <Btn title="Save & accept" primary small onPress={() => onSave({ model, category, qty: qty.trim() ? Number(qty) : null, name: name || null, levelId })} />
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
}) {
  const [picking, setPicking] = useState<Side | null>(null);
  const blockers = cableBlockers(c);
  const open = c.state === 'proposed';
  const endLine = (side: Side) => {
    const e = c.ends[side];
    if (!e) return '— not set';
    const real = realEnd(data, e);
    return `${e.label}${e.kind === 'draft_device' ? (real ? `  → ${real.text} (in the baseline)` : '  (draft, not placed yet)') : e.kind === 'placeholder' ? '  (placeholder)' : ''}`;
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
              {c.codeGuess.reason === 'load' ? ' (load circuits) to Fixtures' : ''} ({pct(c.codeGuess.confidence)}, {c.codeGuess.source === 'label' ? 'from the text at the line’s end' : 'the model’s reading'}) — not applied until you pick it.
            </Text>
          ) : null}
          <View style={styles.chips}>
            {data.codes.map((k) => (
              <Chip key={k} label={k === c.codeGuess?.value && c.code !== k ? `${k} ?` : k} on={c.code === k} onPress={() => void run(() => setCableCode(editor, store, data, c.id, k))} />
            ))}
          </View>
          <Text style={styles.dim}>A load-circuit line is the panel’s 120V to Fixtures. Not a cable to survey (a sense feed, something by others)? Reject it with a reason. A 0-10V or 120V line becomes the device’s library row, never a second one.</Text>
        </View>
      ) : open ? (
        <View>
          <Text style={w.label}>Cable code{c.codeEdited ? `  (was ${c.codeWas ?? 'none'})` : ''}</Text>
          <View style={styles.chips}>
            {data.codes.map((k) => (
              <Chip key={k} label={k} on={c.code === k} onPress={() => void run(() => setCableCode(editor, store, data, c.id, k))} />
            ))}
          </View>
          <Text style={styles.dim}>Read wrong? Pick the right code. A To of Fixtures, 120v Power or EBDK panic wire follows the code unless you picked it.</Text>
        </View>
      ) : null}
      <Text style={styles.dim}>
        The riser reads: {c.fromLabel ?? '?'} → {c.toLabel ?? '(nothing)'} {c.toLevelCode ? `· level ${c.toLevelCode}` : ''} · confidence {pct(c.confidence)}
      </Text>
      {(['from', 'to'] as const).map((side) => (
        <View key={side} style={styles.end}>
          <Text style={w.label}>{side === 'from' ? 'From' : 'To'}</Text>
          <Text style={[styles.endText, !c.ends[side] && styles.warn]}>{endLine(side)}</Text>
          {open ? <Btn title={picking === side ? 'Close' : 'Change…'} small onPress={() => setPicking((p) => (p === side ? null : side))} /> : null}
          {picking === side ? <EndpointPicker c={c} side={side} data={data} onPick={(e) => void run(() => setEndpoint(editor, store, c.id, side, e).then(() => setPicking(null)), 'Endpoint set')} /> : null}
        </View>
      ))}
      {c.conflicts.map((k) => (
        <Text key={k} style={styles.warn}>
          ⚠ {CONFLICT_TEXT[k] ?? k}
        </Text>
      ))}
      <Text style={w.label}>Riser crop (the bubble outlined)</Text>
      <SourceCrops identity={identity} batches={batches} sources={c.sources} />
      {open ? (
        <>
          {blockers.length ? <Text style={styles.dim}>{blockers.join(' ')}</Text> : null}
          <View style={styles.btnRow}>
            <Btn title="Confirm endpoint ✓" primary small disabled={blockers.length > 0} onPress={() => void run(() => acceptCable(editor, store, data, c, { confirm: true, riserBlob }).then(cableNote))} />
            <Btn title="Accept unconfirmed" small disabled={blockers.length > 0} onPress={() => void run(() => acceptCable(editor, store, data, c, { confirm: false, riserBlob }).then(cableNote))} />
            <RejectForm onReject={(r) => void run(() => rejectDraft(editor, 'cable', c, r), 'Rejected')} />
          </View>
          <Text style={styles.dim}>Confirm endpoint = you checked both ends against the riser crop (D6). Unconfirmed cables show ⚑ in the cable view.</Text>
        </>
      ) : c.committed ? (
        <Pressable onPress={() => router.push({ pathname: '/cables', params: { project: projectId } })}>
          <Text style={styles.link}>Its cable is made{c.confirmed ? ', endpoints confirmed' : ' (unconfirmed ⚑)'}. Open Cable / riser ▸</Text>
        </Pressable>
      ) : c.state === 'rejected' ? (
        <Btn title="Reopen" small onPress={() => void run(() => reopenDraft(editor, 'cable', c), 'Reopened')} />
      ) : (
        <>
          <Text style={styles.warn}>Accepted — the cable is made once its draft-device end is placed (5 Place devices).</Text>
          <Btn title="Reopen" small onPress={() => void run(() => reopenDraft(editor, 'cable', c), 'Reopened')} />
        </>
      )}
    </>
  );
}

function cableNote(r: { linked: boolean; waiting: boolean }): string {
  if (r.waiting) return 'Accepted — waits for its device to be placed';
  return r.linked ? 'Accepted — the baseline already had this cable; the riser crop is now on it' : 'Accepted — the cable is made';
}

function EndpointPicker({ c, side, data, onPick }: { c: CableDraftRow; side: Side; data: DraftReviewData; onPick: (e: Endpoint | null) => void }) {
  const [q, setQ] = useState('');
  const options = endpointOptions(data, c, side, q).slice(0, 40);
  return (
    <View style={styles.form}>
      <TextInput style={w.input} value={q} onChangeText={setQ} placeholder="Search devices, drafts, placeholders (any level)" placeholderTextColor="#9aa0a8" autoCorrect={false} />
      {options.map((e) => (
        <Pressable key={`${e.kind}:${e.id}`} onPress={() => onPick(e)} style={styles.option}>
          <Text style={styles.optionText}>
            {e.kind === 'device' ? '▣' : e.kind === 'draft_device' ? '◌' : '⌂'} {e.label}
            {e.confidence != null ? `  · ${pct(e.confidence)}` : ''}
          </Text>
        </Pressable>
      ))}
      {options.length === 0 ? <Text style={styles.dim}>Nothing matches. Add a placeholder in Vocabulary, or type to search other levels.</Text> : null}
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
      <Text style={styles.dim}>For a floor surveyed before its BOM and riser are extracted (K12). It is reviewed like any other draft.</Text>
      <Text style={w.label}>Model</Text>
      <TextInput style={w.input} value={model} onChangeText={setModel} autoCapitalize="characters" autoCorrect={false} placeholder="PI1002" placeholderTextColor="#9aa0a8" />
      <Text style={w.label}>Category</Text>
      <View style={styles.chips}>
        {DEVICE_CATEGORIES.map((c) => (
          <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} />
        ))}
      </View>
      <View style={styles.btnRow}>
        <View style={{ width: 90 }}>
          <Text style={w.label}>Qty</Text>
          <TextInput style={w.input} value={qty} onChangeText={setQty} keyboardType="number-pad" />
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
            <Chip key={l.key} label={l.code} on={lvl === l.levelId} onPress={() => setLvl(l.levelId)} />
          ))}
      </View>
      <Btn title="Add draft" primary small disabled={!model.trim() || !category} onPress={() => category && onAdd({ levelId: lvl, model, category, qty: Number(qty), name: name || null })} />
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
      <Text style={styles.dim}>Then pick its two ends and Confirm endpoint, as for a riser cable.</Text>
      <Text style={w.label}>Code</Text>
      <View style={styles.chips}>
        {codes.map((k) => (
          <Chip key={k} label={k} on={code === k} onPress={() => setCode(k)} />
        ))}
      </View>
      <Text style={w.label}>From (as written)</Text>
      <TextInput style={w.input} value={from} onChangeText={setFrom} autoCorrect={false} placeholder="CT02LCPA" placeholderTextColor="#9aa0a8" />
      <Text style={w.label}>To (as written)</Text>
      <TextInput style={w.input} value={to} onChangeText={setTo} autoCorrect={false} placeholder="UFMP4 Level 03" placeholderTextColor="#9aa0a8" />
      <Text style={w.label}>Far end level</Text>
      <View style={styles.chips}>
        <Chip label="same level" on={toLevel === null} onPress={() => setToLevel(null)} />
        {levels
          .filter((l) => l.levelId && l.levelId !== levelId)
          .map((l) => (
            <Chip key={l.key} label={l.code} on={toLevel === l.levelId} onPress={() => setToLevel(l.levelId)} />
          ))}
      </View>
      <Btn title="Add draft" primary small disabled={!code || !from.trim() || !to.trim()} onPress={() => code && onAdd({ levelId, code, fromLabel: from, toLabel: to, toLevelId: toLevel })} />
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
      <Pressable onPress={() => setOpen((o) => !o)}>
        <Text style={styles.h2}>
          Excluded BOM lines ({here.length} here, {all.length} in all) {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      <Text style={styles.dim}>Lines the BOM extraction set aside (services, hardware, parts outside lighting control). Promote one to review it as a device draft (D12).</Text>
      {open
        ? (here.length ? here : all).map((l) => (
            <View key={l.key} style={styles.excluded}>
              <Text style={styles.exText}>
                {l.model ?? l.part_number ?? '?'} ×{l.qty ?? '?'} — {l.description ?? ''} <Text style={styles.dim}>({l.reason}; p.{String(l.source_ref.page ?? '?')} line {String(l.source_ref.line ?? '?')})</Text>
              </Text>
              {promoted.has(l.key) ? (
                <Text style={styles.green}>promoted ✓</Text>
              ) : (
                <Btn title="Promote…" small onPress={() => void run(() => promoteExcluded(editor, projectId, l.batch, l, levelFor(l)), 'Promoted — pick its category and Accept')} />
              )}
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 14, gap: 6 },
  pad: { padding: 20, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  h1: { fontSize: 20, fontWeight: '600' },
  h2: { fontSize: 16, fontWeight: '700', marginTop: 6 },
  counts: { fontSize: 14, color: '#444' },
  levels: { flexGrow: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: '#eef1f5' },
  chipOn: { backgroundColor: '#1565c0' },
  chipText: { fontSize: 13, color: '#333' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  sep: { color: '#bbb' },
  body: { flex: 1, flexDirection: 'row', gap: 12, marginTop: 6 },
  left: { flex: 3 },
  panel: { flex: 2, backgroundColor: '#f8f9fb', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d5d9e0' },
  thead: { flexDirection: 'row', gap: 6, paddingVertical: 4, borderBottomWidth: 1, borderColor: '#d5d9e0' },
  tr: { flexDirection: 'row', gap: 6, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8', alignItems: 'center' },
  trOn: { backgroundColor: '#e3edfb' },
  cModel: { flex: 3, fontSize: 14 },
  cName: { flex: 2, fontSize: 13, color: '#444' },
  cCat: { flex: 2, fontSize: 13, color: '#444' },
  cQty: { width: 44, fontSize: 14 },
  cConf: { width: 44, fontSize: 14 },
  cSrc: { width: 46, fontSize: 13, color: '#555' },
  cState: { width: 92, fontSize: 12 },
  cCode: { width: 50, fontSize: 14, fontWeight: '600' },
  cFrom: { flex: 3, fontSize: 13 },
  cTo: { flex: 4, fontSize: 13 },
  mismatch: { fontSize: 14, color: '#8a5300', paddingVertical: 3 },
  kv: { fontSize: 14 },
  k: { fontWeight: '700', color: '#555' },
  warn: { color: '#b26a00' },
  red: { color: '#c62828' },
  green: { color: '#2e7d32' },
  dim: { fontSize: 13, color: '#777' },
  dimText: { color: '#999' },
  link: { fontSize: 14, color: '#1565c0' },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' },
  form: { gap: 6, padding: 10, borderRadius: 6, backgroundColor: '#fff', borderWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  radio: { paddingVertical: 6 },
  radioText: { fontSize: 15 },
  radioOn: { fontWeight: '700', color: '#1565c0' },
  end: { gap: 4 },
  endText: { fontSize: 15 },
  option: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8' },
  optionText: { fontSize: 14 },
  excluded: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8' },
  exText: { flex: 1, fontSize: 13 },
});
