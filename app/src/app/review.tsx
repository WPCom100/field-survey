import { LIBRARY_STREAM, Editor, linkPunchDevice, resolutionReason, setPunchEnd, type ResolveChoice, type Store } from '@field-survey/core';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AddDevicePanel } from '../additions/AddDevicePanel';
import { openAppStore } from '../db';
import { flaggedDraftCounts } from '../drafts/model';
import { loadPlacementProgress, type LevelPlacement } from '../placement/model';
import { pickProject } from '../home/currentProject';
import { listProjects } from '../home/data';
import { useCurrentUser } from '../identity/IdentityGate';
import { useTeamNames } from '../identity/useTeamNames';
import { logTo } from '../log';
import {
  kindLabel,
  loadReviewDetail,
  loadReviewList,
  shortStamp,
  type FindingRow,
  type PunchDeviceReview,
  type PunchEndReview,
  type ReviewDetail,
  type ReviewList,
  type ReviewRow,
} from '../review/model';
import { useRulesVersion } from '../rules/useRulesVersion';
import { projectDataKey } from '../sync/dataKey';
import { useIdentityKey, useReload } from '../sync/useReload';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Btn, Chip, FilterLabel, FilterRow, PageHeader, PAGE_GUTTER, color, fieldStyles, font, radius, ring, space, tabular } from '../ui';

const CHOICE_LABEL: Record<ResolveChoice['choice'], string> = { A: 'Choose A', B: 'Choose B', combine: 'Combine', value: 'Set value' };

/**
 * Needs review (T26, Phase 3 §6): open review items by kind and level on the left, the selected
 * item's A/B panel on the right. A sync conflict is closed only by Choose A / Choose B / Combine /
 * a typed value (D98: no Dismiss); each choice writes one Reconcile group with the auto-filled
 * reason (T15). Pin conflicts are resolved on the plan, both pins drawn. The `IN REVIEW` badges
 * clear here at once and on the other iPads on their next pull. `?item=` selects an item;
 * `?project=` names the project (else the one the home last showed, T83).
 *
 * An imported punch row linked to no device (T81, D148) shows the master's Device text with Link
 * to device (a device of the row's level) and Create device (the + Device form, created unplaced);
 * either writes one Reconcile op on `punch_item.device_id` and closes the item. Left unlinked, the
 * item keeps the master's text in the export (D150).
 */
export default function NeedsReviewScreen() {
  const params = useLocalSearchParams<{ item?: string; project?: string; kind?: string }>();
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  const names = useTeamNames(store);
  const [projectId, setProjectId] = useState<string | null>(null);
  // this project's pulls and rules runs only (T185, T186)
  const dataKey = projectDataKey(sync, projectId);
  const rulesKey = useRulesVersion(projectId);
  const [kind, setKind] = useState(params.kind ?? 'all');
  const [levelId, setLevelId] = useState<string | null>(null);
  const [sort, setSort] = useState<'oldest' | 'newest'>('oldest');
  const [list, setList] = useState<ReviewList | null>(null);
  const [selected, setSelected] = useState<string | null>(params.item ?? null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    openAppStore().then(
      async (s) => {
        setStore(s);
        // The project the link names, else the one the home last showed (T83), else the first.
        setProjectId(params.project === LIBRARY_STREAM ? LIBRARY_STREAM : pickProject((await listProjects(s)).map((p) => p.id), params.project));
      },
      (e: unknown) => setNote(String(e)),
    );
  }, [params.project]);
  // Back from the plan (a pin conflict resolved there): reload.
  useFocusEffect(useCallback(() => setTick((n) => n + 1), []));

  // T186: a pull or a rules run during a load no longer throws it away (useReload)
  const reloadKey = `${tick}|${dataKey}|${rulesKey}`;
  const library = projectId === LIBRARY_STREAM;
  useReload({
    name: 'review',
    subject: store && projectId ? `${projectId}|${kind}|${levelId ?? ''}|${sort}` : null,
    reloadKey,
    load: () => loadReviewList(store!, projectId!, { kind, levelId, sort }),
    apply: (l) => {
      setList(l);
      // Keep the selection while it is listed; otherwise the first row (an empty list: none).
      setSelected((cur) => (cur && l.rows.some((r) => r.id === cur) ? cur : (l.rows[0]?.id ?? null)));
    },
    fail: (e) => setNote(String(e)),
  });

  // Flagged extraction drafts (D11) wait in Setup → Review drafts; the Extraction tab links there (T44).
  const [drafts, setDrafts] = useState<{ devices: number; cables: number } | null>(null);
  // Devices not on their plan yet (T46, M3 round A-4): one line per level, into its plan's Place devices panel.
  const [toPlace, setToPlace] = useState<LevelPlacement[]>([]);
  useEffect(() => {
    if (!library) return;
    setDrafts(null);
    setToPlace([]);
  }, [library]);
  useReload({
    name: 'review_drafts',
    subject: store && projectId && !library ? projectId : null,
    reloadKey,
    load: () => flaggedDraftCounts(store!, projectId!),
    apply: setDrafts,
    fail: () => undefined,
  });
  useReload({
    name: 'review_place',
    subject: store && projectId && !library ? projectId : null,
    reloadKey,
    load: () => loadPlacementProgress(store!, projectId!),
    apply: (p) => setToPlace(p.levels.filter((l) => l.inScope && l.unplacedDevices + l.draftUnits > 0)),
    fail: () => undefined,
  });

  useEffect(() => {
    if (!selected) setDetail(null);
  }, [selected]);
  useReload({
    name: 'review_detail',
    subject: store && selected ? selected : null,
    reloadKey: useIdentityKey(reloadKey, names),
    load: () => loadReviewDetail(store!, selected!, names),
    apply: setDetail,
    fail: (e) => setNote(String(e)),
  });

  const editor = useMemo(() => (store && projectId ? new Editor(store, { projectId, userId: user.id }) : null), [store, projectId, user.id]);

  const resolve = useCallback(
    async (choice: ResolveChoice) => {
      if (!store || !editor || !detail) return;
      const userName = (id: string) => names.get(id);
      const reason = await resolutionReason(store, detail.item, choice, { userName });
      Alert.alert(CHOICE_LABEL[choice.choice], `Reason (auto-filled):\n${reason}`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Resolve',
          onPress: () => {
            editor.resolve(detail.item.id, choice, { userName }).then(
              (r) => {
                logTo('sync', 'info', 'review_resolved', { item: r.item_id, choice: choice.choice });
                setNote(`Resolved: ${r.reason}`);
                setTick((n) => n + 1);
              },
              (e: unknown) => setNote(`Not resolved: ${String((e as Error)?.message ?? e)}`),
            );
          },
        },
      ]);
    },
    [store, editor, detail, names],
  );

  const linkPunch = useCallback(
    (deviceId: string, deviceLabel: string, confirm: boolean) => {
      if (!editor || !detail) return;
      const run = () =>
        linkPunchDevice(editor, detail.item.id, deviceId, { deviceLabel }).then(
          (r) => {
            logTo('sync', 'info', 'punch_device_linked', { item: detail.item.id, device: deviceId });
            setNote(`Linked: ${r.reason}`);
            setTick((n) => n + 1);
          },
          (e: unknown) => setNote(`Not linked: ${String((e as Error)?.message ?? e)}`),
        );
      if (!confirm) return void run();
      Alert.alert('Link to device', `Link this punch item to ${deviceLabel}? Its Device text then follows the device.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Link', onPress: () => void run() },
      ]);
    },
    [editor, detail],
  );

  const putOnEnd = useCallback(
    (endId: string | null, endLabel: string | null) => {
      if (!editor || !detail) return;
      const run = () =>
        setPunchEnd(editor, detail.item.id, endId, endLabel ? { endLabel } : {}).then(
          (r) => {
            logTo('sync', 'info', 'punch_end_set', { item: detail.item.id, end: endId });
            setNote(r.reason);
            setTick((n) => n + 1);
          },
          (e: unknown) => setNote(`Not changed: ${String((e as Error)?.message ?? e)}`),
        );
      Alert.alert(
        endId ? 'Put on this connection' : 'Keep on the device',
        endId ? `Put this punch item on ${endLabel ?? 'that connection'}? It then stands for that run's item (no second draft there).` : 'Keep this punch item on its device, on no connection?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: endId ? 'Put on' : 'Keep', onPress: () => void run() },
        ],
      );
    },
    [editor, detail],
  );

  const total = list?.tabs.find((t) => t.kind === 'all')?.count ?? 0;
  const extractionLine =
    drafts && drafts.devices + drafts.cables > 0 && (kind === 'all' || kind === 'extraction') && projectId && projectId !== LIBRARY_STREAM ? (
      <Pressable onPress={() => router.push({ pathname: '/setup/[projectId]', params: { projectId, step: 'drafts' } })} style={styles.row}>
        <Text style={styles.rowTitle}>
          Extraction drafts: {drafts.devices} device{drafts.devices === 1 ? '' : 's'} and {drafts.cables} cable{drafts.cables === 1 ? '' : 's'} under 0.7 or in conflict
        </Text>
        <Text style={styles.link}>Open Setup → Review drafts ▸</Text>
      </Pressable>
    ) : null;
  const placeLines =
    kind === 'all' || kind === 'extraction'
      ? toPlace
          .filter((l) => !levelId || l.levelId === levelId)
          .map((l) => (
            <Pressable key={l.levelId} onPress={() => router.push({ pathname: '/plan/[levelId]', params: { levelId: l.levelId, place: '1' } })} style={styles.row} testID={`review.place.${l.code}`}>
              <Text style={styles.rowTitle}>
                Not on the plan, {l.code}: {l.unplacedDevices} device{l.unplacedDevices === 1 ? '' : 's'}
                {l.draftUnits ? ` and ${l.draftUnits} to place from drafts` : ''}
              </Text>
              <Text style={styles.link}>Place on the {l.code} plan ▸</Text>
            </Pressable>
          ))
      : [];
  const draftLine =
    extractionLine || placeLines.length ? (
      <View>
        {extractionLine}
        {placeLines}
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      <PageHeader
        title={`${projectId === LIBRARY_STREAM ? 'App library — needs review' : 'Needs review'} (${total})`}
        caption="Items waiting for a person's decision, by kind and level. Nothing is overwritten while one waits."
        actions={
          projectId === LIBRARY_STREAM ? (
            <Btn kind="tertiary" title="← Library" onPress={() => router.navigate({ pathname: '/library', params: { scope: 'app' } })} />
          ) : (
            <Btn kind="tertiary" title="← Levels" onPress={() => router.dismissTo(projectId ? { pathname: '/', params: { project: projectId } } : '/')} />
          )
        }
      />
      <ScrollView horizontal style={styles.tabs} contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
        {list?.tabs.map((t) => (
          <Chip key={t.kind} label={`${t.label}${t.kind === 'all' ? '' : ` ${t.count}`}`} selected={kind === t.kind} onPress={() => setKind(t.kind)} testID={`review.tab.${t.kind}`} />
        ))}
      </ScrollView>
      <FilterRow style={styles.filters}>
        <FilterLabel text="Level" />
        <Chip small label="All" selected={!levelId} onPress={() => setLevelId(null)} />
        {list?.levels.map((l) => (
          <Chip small key={l.id} label={l.code} selected={levelId === l.id} onPress={() => setLevelId(l.id)} testID={`review.level.${l.code}`} />
        ))}
        <FilterLabel text="Sort" gap />
        <Chip small label={sort === 'oldest' ? 'Oldest first' : 'Newest first'} onPress={() => setSort(sort === 'oldest' ? 'newest' : 'oldest')} />
      </FilterRow>

      <View style={styles.body}>
        <FlatList
          style={styles.list}
          data={list?.rows ?? []}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <Row row={item} selected={item.id === selected} onPress={() => setSelected(item.id)} />}
          ListHeaderComponent={draftLine}
          ListEmptyComponent={
            (list?.findings.length && kind === 'lint') || draftLine ? null : <Text style={styles.empty}>{list ? 'Nothing to review.' : 'Loading…'}</Text>
          }
          ListFooterComponent={
            kind === 'lint' && list?.findings.length ? (
              <View>
                <Text style={styles.sectionHead}>Lint findings ({list.findings.length})</Text>
                <Pressable onPress={() => router.push({ pathname: '/lint', params: projectId ? { project: projectId } : {} })} style={styles.row} testID="review.openLint">
                  <Text style={styles.link}>Open the Lint view to dismiss or fix them ▸</Text>
                </Pressable>
                {list.findings.map((f) => (
                  <FindingItem key={f.id} finding={f} />
                ))}
              </View>
            ) : null
          }
        />
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelBody}>
          {/* the last action's line, above the next item: under its device list it was out of sight (T154) */}
          {note ? (
            <Text style={styles.note} testID="review.note">
              {note}
            </Text>
          ) : null}
          {detail?.punchDevice && store && editor && projectId ? (
            <PunchDevicePanel detail={detail} review={detail.punchDevice} store={store} editor={editor} projectId={projectId} onLink={linkPunch} />
          ) : detail?.punchEnd ? (
            <PunchEndPanel detail={detail} review={detail.punchEnd} canEdit={!!editor} onPut={putOnEnd} />
          ) : detail ? (
            <Panel detail={detail} canEdit={!!editor} onResolve={resolve} />
          ) : (
            <Text style={styles.empty}>Select an item.</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function Row({ row, selected, onPress }: { row: ReviewRow; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.row, selected && styles.rowOn]} testID="review.row">
      <Text style={styles.rowTitle} numberOfLines={1}>
        <Text style={styles.dot}>● </Text>
        {row.subject} · {row.field}
      </Text>
      <Text style={styles.rowSub}>
        {kindLabel(row.kind).toLowerCase()} · {row.levelCode ?? 'no level'} · {shortStamp(row.at)}
        {row.ruling ? ' · ⚑ ruling' : ''}
      </Text>
    </Pressable>
  );
}

function FindingItem({ finding: f }: { finding: FindingRow }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>
        <Text style={styles.dot}>● </Text>
        {f.lintId} · {f.subject}
      </Text>
      <Text style={styles.finding}>{f.message}</Text>
      <Text style={styles.rowSub}>finding · {f.levelCode ?? 'no level'}</Text>
      {f.levelId ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/plan/[levelId]', params: { levelId: f.levelId!, ...(f.deviceId ? { device: f.deviceId } : {}) } })
          }
        >
          <Text style={styles.link}>Open {f.deviceId ? 'the device card' : 'the level'} on the plan ▸</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Panel({ detail: d, canEdit, onResolve }: { detail: ReviewDetail; canEdit: boolean; onResolve: (c: ResolveChoice) => void }) {
  const [combine, setCombine] = useState<string | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    setCombine(null);
    setValue('');
  }, [d.item.id]);

  const head = (
    <Text style={styles.panelTitle}>
      {kindLabel(d.item.kind)} — {d.row.subject} · {d.row.field}
    </Text>
  );
  if (d.item.kind !== 'sync_conflict') {
    const subj = d.item.subject;
    const draft = subj && (subj.entity_kind === 'draft_device' || subj.entity_kind === 'draft_cable') ? subj.entity_id : null;
    return (
      <>
        {head}
        <Text style={styles.sub}>
          {draft
            ? 'Settled in Setup → Review drafts (T44): Accept with the count you choose, or Reject to keep the baseline.'
            : `${kindLabel(d.item.kind)} items are reviewed in Setup (their screens come with the setup tasks). Listed here so nothing is missed.`}
        </Text>
        {draft ? (
          <Pressable onPress={() => router.push({ pathname: '/setup/[projectId]', params: { projectId: d.item.project_id, step: 'drafts', draft } })}>
            <Text style={styles.link}>Open in Review drafts ▸</Text>
          </Pressable>
        ) : null}
      </>
    );
  }
  const was = d.fields.some((f) => f.was !== null);
  const openOnPlan = (review: boolean) => {
    if (!d.row.levelId) return;
    router.push({
      pathname: '/plan/[levelId]',
      params: { levelId: d.row.levelId, ...(d.row.deviceId ? { device: d.row.deviceId } : {}), ...(review ? { review: d.item.id } : {}) },
    });
  };

  return (
    <>
      {head}
      {d.item.state !== 'open' ? <Text style={styles.sub}>This item is {d.item.state}.</Text> : null}
      <View style={styles.sides}>
        <Side letter="A" title="A (official now)" side={d.a} values={d.fields.map((f) => [f.label, f.a])} solid />
        <Side letter="B" title="B" side={d.b} values={d.fields.map((f) => [f.label, f.b])} />
      </View>
      {was ? (
        <Text style={styles.sub}>
          was: {d.fields.map((f) => `${d.fields.length > 1 ? `${f.label} ` : ''}${f.was ?? '?'}`).join(' · ')} — the value before both edits
        </Text>
      ) : null}
      {d.item.ruling ? <Text style={styles.flag}>⚑ A ruling lost to a field edit here</Text> : null}

      {d.resolvable ? (
        <>
          {d.pins ? (
            <Btn title="Resolve on the plan ▸ (A solid, B dashed)" onPress={() => openOnPlan(true)} disabled={!d.row.levelId} />
          ) : null}
          <View style={styles.btnRow}>
            <Btn kind="primary" title="Choose A" onPress={() => onResolve({ choice: 'A' })} disabled={!canEdit} testID="review.choose.A" />
            <Btn kind="primary" title="Choose B" onPress={() => onResolve({ choice: 'B' })} disabled={!canEdit} testID="review.choose.B" />
            {d.choices.includes('combine') ? (
              <Btn title={combine === null ? 'Combine ▸' : 'Combine ▾'} onPress={() => setCombine(combine === null ? (d.combine ?? '') : null)} disabled={!canEdit} />
            ) : null}
          </View>
          {combine !== null ? (
            <View style={styles.block}>
              <Text style={styles.sub}>Combined text (pre-filled "A; B", A first — edit as needed)</Text>
              <TextInput style={styles.input} value={combine} onChangeText={setCombine} multiline />
              <Btn kind="primary" title="Save combined" disabled={!combine.trim()} onPress={() => onResolve({ choice: 'combine', text: combine })} />
            </View>
          ) : null}
          {d.choices.includes('value') ? (
            <View style={styles.btnRow}>
              <TextInput style={[styles.input, styles.valueInput]} placeholderTextColor={color.text3} value={value} onChangeText={setValue} keyboardType="numeric" placeholder="Value" />
              <Btn
                kind="primary"
                title="Set value"
                disabled={!canEdit || !Number.isFinite(Number(value)) || value.trim() === ''}
                onPress={() => onResolve({ choice: 'value', value: Number(value) })}
              />
            </View>
          ) : null}
          <Text style={styles.sub}>No dismiss: a sync conflict is closed by a choice (D98). The reason is filled in for you.</Text>
        </>
      ) : null}
      {d.row.levelId ? (
        <Pressable onPress={() => openOnPlan(false)}>
          <Text style={styles.link}>Context: open {d.row.deviceId ? 'the device card' : 'the level'} on the plan ▸</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/** The room part of a master Device text (`UFMP4 - BH OBS RM 47` → `BH OBS RM 47`), for the form. */
function roomOf(master: string): string {
  const i = master.indexOf(' - ');
  return i >= 0 ? master.slice(i + 3).trim() : '';
}

function PunchDevicePanel(props: {
  detail: ReviewDetail;
  review: PunchDeviceReview;
  store: Store;
  editor: Editor;
  projectId: string;
  onLink: (deviceId: string, deviceLabel: string, confirm: boolean) => void;
}) {
  const { detail: d, review: r } = props;
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setFilter('');
    setCreating(false);
  }, [d.item.id]);
  const open = d.item.state === 'open';
  const q = filter.trim().toLowerCase();
  const shown = q ? r.devices.filter((x) => `${x.label} ${x.text ?? ''} ${x.category ?? ''}`.toLowerCase().includes(q)) : r.devices;
  const linked = r.linkedTo ? r.devices.find((x) => x.id === r.linkedTo) : null;

  return (
    <>
      <Text style={styles.panelTitle}>Punch item without a device — {r.levelCode}</Text>
      <Text style={styles.value}>{r.punch}</Text>
      <View style={styles.side}>
        <Text style={styles.sub}>Device, as the master wrote it</Text>
        <Text style={styles.value}>{r.master || '(blank)'}</Text>
      </View>
      {!open ? (
        <Text style={styles.sub}>
          This item is {d.item.state}
          {linked ? `: linked to ${linked.label}${linked.text ? ` · ${linked.text}` : ''}` : ''}.
        </Text>
      ) : creating ? (
        <View style={styles.form}>
          <AddDevicePanel
            store={props.store}
            editor={props.editor}
            projectId={props.projectId}
            levelId={r.levelId}
            levelCode={r.levelCode}
            sheetId={null}
            at={null}
            title="Create device for this punch item"
            defaults={{ drawingPosition: null, room: roomOf(r.master) || null }}
            onCancel={() => setCreating(false)}
            onCategory={() => {}}
            onAdded={(id) => {
              setCreating(false);
              props.onLink(id, `${r.levelCode}-? (new)`, false);
            }}
          />
        </View>
      ) : (
        <>
          <Text style={styles.sub}>
            Link it to the device it is about, or create that device. Once linked, its Device text follows the device (renames included). A row
            that is really about a room or several devices can stay unlinked: the export then keeps the master&apos;s text.
          </Text>
          <View style={styles.btnRow}>
            <Btn title="Create device ▸" onPress={() => setCreating(true)} testID="review.createDevice" />
          </View>
          <Text style={styles.sideTitle}>Link to a device on {r.levelCode}</Text>
          <TextInput testID="review.filter" style={styles.input} placeholderTextColor={color.text3} value={filter} onChangeText={setFilter} placeholder="Filter: ID, model, room" autoCorrect={false} autoCapitalize="none" />
          {shown.length === 0 ? <Text style={styles.sub}>No device matches.</Text> : null}
          {shown.map((x) => (
            <Pressable key={x.id} onPress={() => props.onLink(x.id, x.label, true)} style={styles.pick} accessibilityRole="button" testID={`review.link.${x.label}`}>
              <Text style={styles.pickId}>{x.label}</Text>
              <Text style={styles.pickText} numberOfLines={1}>
                {x.text ?? x.category ?? ''}
              </Text>
            </Pressable>
          ))}
        </>
      )}
    </>
  );
}

function PunchEndPanel(props: { detail: ReviewDetail; review: PunchEndReview; canEdit: boolean; onPut: (endId: string | null, endLabel: string | null) => void }) {
  const { detail: d, review: r } = props;
  const open = d.item.state === 'open';
  const linked = r.linkedTo ? r.ends.find((x) => x.id === r.linkedTo) : null;
  const what = r.codes.length ? r.codes.join(' / ') : 'cable';
  return (
    <>
      <Text style={styles.panelTitle}>Cable item without its connection — {r.levelCode}</Text>
      <Text style={styles.value}>{r.punch}</Text>
      <View style={styles.side}>
        <Text style={styles.sub}>On device</Text>
        <Text style={styles.value}>{r.device}</Text>
      </View>
      {!open ? (
        <Text style={styles.sub}>
          This item is {d.item.state}
          {linked ? `: on ${linked.label}${linked.to ? ` · ${linked.to}` : ''}` : d.item.resolution?.choice === 'keep' ? ': kept on the device' : ''}.
        </Text>
      ) : (
        <>
          <Text style={styles.sub}>
            The import could not tell which {what} connection of this device the item is about. Put it on one: the rules then treat it as that run&apos;s item and draft no
            second one there. An item about two runs goes on one of them; the other run gets its own Run draft on the card. Or keep it on the device.
          </Text>
          <Text style={styles.sideTitle}>Put on a {what} connection</Text>
          {r.ends.length === 0 ? <Text style={styles.sub}>This device has no {what} connection. Keep it on the device, or add the connection on the card and come back.</Text> : null}
          {r.ends.map((x) => (
            <Pressable key={x.id} onPress={() => props.onPut(x.id, x.label)} style={styles.pick} accessibilityRole="button" disabled={!props.canEdit} testID={`review.put.${x.label}`}>
              <Text style={styles.pickId}>{x.label}</Text>
              <Text style={styles.pickText} numberOfLines={1}>
                {[x.code, x.to].filter(Boolean).join(' · ')}
              </Text>
            </Pressable>
          ))}
          <View style={styles.btnRow}>
            <Btn title="Keep on the device" onPress={() => props.onPut(null, null)} disabled={!props.canEdit} testID="review.keep" />
          </View>
        </>
      )}
    </>
  );
}

function Side(props: { letter: string; title: string; side: ReviewDetail['a']; values: [string, string][]; solid?: boolean }) {
  return (
    <View style={[styles.side, !props.solid && styles.sideB]}>
      <Text style={styles.sideTitle}>{props.title}</Text>
      <Text style={styles.sub}>
        {props.side ? `${props.side.who} · ${shortStamp(props.side.when)}` : '—'}
        {'\n'}
        {props.side?.install ?? ''}
      </Text>
      {props.values.map(([label, v]) => (
        <Text key={label} style={styles.value}>
          {props.values.length > 1 ? <Text style={styles.sub}>{label}: </Text> : null}
          {v}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  link: { ...font.callout, color: color.primary },
  tabs: { flexGrow: 0, marginTop: space.md },
  chips: { gap: space.sm, alignItems: 'center', paddingHorizontal: PAGE_GUTTER },
  filters: { paddingBottom: space.md },
  body: {
    flex: 1,
    flexDirection: 'row',
    marginHorizontal: PAGE_GUTTER,
    marginBottom: space.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  list: { width: '42%', flexGrow: 0, borderRightWidth: 1, borderRightColor: color.hairline },
  panel: { flex: 1 },
  panelBody: { padding: space.lg, gap: space.md },
  row: { paddingVertical: space.md, paddingHorizontal: space.lg, borderBottomWidth: 1, borderBottomColor: color.hairline, gap: 2 },
  rowOn: { backgroundColor: color.primaryTint },
  rowTitle: { ...font.calloutBold, color: color.text },
  rowSub: { ...font.caption, color: color.text3 },
  dot: { color: ring.review },
  sectionHead: { ...font.captionBold, color: color.text2, paddingVertical: space.sm, paddingHorizontal: space.lg, backgroundColor: color.surface2 },
  finding: { ...font.callout, color: color.text },
  empty: { ...font.callout, color: color.text3, padding: space.lg },
  panelTitle: { ...font.headline, color: color.text },
  sides: { flexDirection: 'row', gap: space.md },
  side: { flex: 1, borderWidth: 2, borderColor: color.muted, borderRadius: radius.control, padding: space.md, gap: 6 },
  sideB: { borderStyle: 'dashed' },
  sideTitle: { ...font.calloutBold, color: color.text },
  value: { ...font.body, color: color.text },
  sub: { ...font.caption, color: color.text3 },
  flag: { ...font.calloutBold, color: color.danger },
  btnRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  block: { gap: space.sm },
  input: fieldStyles.input,
  valueInput: { width: 120 },
  note: { ...font.callout, color: color.success },
  form: { height: 620, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, overflow: 'hidden' },
  pick: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44, paddingVertical: space.sm, paddingHorizontal: space.sm, borderBottomWidth: 1, borderBottomColor: color.hairline },
  pickId: { ...font.calloutBold, ...tabular, color: color.text, minWidth: 72 },
  pickText: { ...font.callout, color: color.text2, flex: 1 },
});
