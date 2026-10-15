import { Link, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useBlobStatus } from '../blobs/useBlobStatus';
import { openAppStore } from '../db';
import { ensureExportFile, localExport, shareExportFile } from '../export/files';
import {
  DATA_TABS,
  FIXED_TABS,
  FLOOR_SECTIONS,
  floorBody,
  floorHeader,
  type FloorSection,
  KIND_LABEL,
  attachJobs,
  busyLine,
  cachedHistory,
  cancelExport,
  diffDetail,
  diffLine,
  downloadedExports,
  exportTime,
  getExport,
  isActive,
  isFinished,
  jobLine,
  levelsTitle,
  listExports,
  loadPreflight,
  preflightLine,
  progressLine,
  rememberHistory,
  runningFrom,
  scopeLine,
  startedBy,
  startExport,
  startGate,
  workbookBody,
  type DataTab,
  type ExportKind,
  type ExportRow,
  type Jobs,
  type Preflight,
} from '../export/model';
import { listProjects } from '../home/data';
import { useIdentity } from '../identity/IdentityGate';
import { getSyncEngine } from '../sync/engine';
import { describeSync, useSyncStatus } from '../sync/useSyncStatus';
import { Btn, Check, Notice, Section } from '../setup/widgets';

type Pane = 'workbook' | 'pdf' | 'history';

/**
 * Export (T31, Phase 3 §11.1). The master workbook is a server job over the server's data (D18,
 * D137): pick levels and tabs, look at the pre-flight, Generate, follow the job, then Share / Save
 * to Files. **D94:** Generate stays disabled until the status reads "Synced" with nothing pending;
 * nothing is ever exported from this iPad's store. History lists every export with its export
 * time; files downloaded once still open offline.
 *
 * T93 (D166): one queued or running export per project and kind, on the server. Opening the
 * screen re-attaches to it from the server's list, whoever started it, and follows its stage and
 * counts; Generate for that kind names it instead; anyone may Cancel it.
 */
export default function ExportScreen() {
  const identity = useIdentity();
  const sync = useSyncStatus();
  const blobs = useBlobStatus();
  const { project: wanted } = useLocalSearchParams<{ project?: string }>();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [pane, setPane] = useState<Pane>('workbook');
  const [pre, setPre] = useState<Preflight | null>(null);
  const [levels, setLevels] = useState<string[] | 'all'>('all');
  const [tabs, setTabs] = useState<DataTab[]>([...DATA_TABS]);
  const [floorLevel, setFloorLevel] = useState<string | null>(null);
  const [sections, setSections] = useState<FloorSection[]>(FLOOR_SECTIONS.map((s) => s.key));
  const [jobs, setJobs] = useState<Jobs>({});
  const [now, setNow] = useState(() => Date.now());
  const setJob = (e: ExportRow) => setJobs((cur) => ({ ...cur, [e.kind]: e }));
  const [history, setHistory] = useState<ExportRow[]>([]);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [onIpad, setOnIpad] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const fail = (e: unknown) => live.current && setError(e instanceof Error ? e.message : String(e));

  // Project: the one asked for, else the first on the iPad.
  useEffect(() => {
    (async () => {
      const store = await openAppStore();
      const list = await listProjects(store);
      const p = list.find((x) => x.id === wanted) ?? list[0];
      if (!p || !live.current) return;
      setProjectId(p.id);
      setProjectName(p.name);
    })().catch(fail);
  }, [wanted]);

  // Pre-flight from the local store; refreshed after each sync.
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const store = await openAppStore();
      const p = await loadPreflight(store, projectId);
      if (live.current) setPre(p);
    })().catch(fail);
  }, [projectId, sync.lastSyncAt, sync.pendingOps]);

  /** History: the server's list when reachable (cached), else the last cached list (D94). */
  const refreshHistory = useCallback(async () => {
    if (!projectId) return;
    const store = await openAppStore();
    setOnIpad(await downloadedExports(store));
    try {
      const rows = await listExports(identity, projectId);
      await rememberHistory(store, projectId, rows);
      if (!live.current) return;
      setHistory(rows);
      setJobs((cur) => attachJobs(cur, rows));
      setHistoryNote(null);
    } catch {
      const rows = await cachedHistory(store, projectId);
      if (!live.current) return;
      setHistory(rows);
      setHistoryNote('Not connected: showing the list from the last time this iPad reached the server. Files marked "on this iPad" still open.');
    }
  }, [identity, projectId]);

  useEffect(() => {
    refreshHistory().catch(fail);
  }, [refreshHistory]);

  // Follow every queued or running export of the project (this iPad's or anyone's, T93).
  const following = (Object.values(jobs) as ExportRow[]).filter(isActive).map((e) => e.id).join(',');
  useEffect(() => {
    if (!following) return;
    const ids = following.split(',');
    const t = setInterval(() => {
      setNow(Date.now());
      for (const id of ids) {
        getExport(identity, id).then(
          (e) => {
            if (!live.current) return;
            setJob(e);
            if (isFinished(e.job_state)) refreshHistory().catch(fail);
          },
          () => undefined,
        );
      }
    }, 2000);
    return () => clearInterval(t);
  }, [identity, following, refreshHistory]);

  const gate = startGate(sync);
  const xlsxJob = jobs.xlsx ?? null;
  const pdfJob = jobs.floor_pdf ?? null;
  const chosenLevels = levels === 'all' ? (pre?.levels.length ?? 0) : levels.length;
  const canGenerate = gate.ok && !isActive(xlsxJob) && busy === null && tabs.length > 0 && chosenLevels > 0;
  const floor = pre?.levels.find((l) => l.code === floorLevel) ?? pre?.levels[0];
  const canGeneratePdf = gate.ok && !isActive(pdfJob) && busy === null && sections.length > 0 && !!floor;
  const gateLine = (j: ExportRow | null) => (isActive(j) ? busyLine(j) : gate.reason);
  const gateOk = (j: ExportRow | null) => gate.ok && !isActive(j);

  /** Generate refused because one is already queued or running: show that one instead. */
  const start = async (body: Parameters<typeof startExport>[1]) => {
    try {
      setJob(await startExport(identity, body));
    } catch (e) {
      const other = runningFrom(e);
      if (!other) throw e;
      if (live.current) setJob(other);
    }
  };

  const cancel = (e: ExportRow) => {
    const go = () => {
      cancelExport(identity, e.id).then((row) => {
        if (!live.current) return;
        setJob(row);
        if (isFinished(row.job_state)) refreshHistory().catch(fail);
      }, fail);
    };
    Alert.alert(`Cancel this ${KIND_LABEL[e.kind as ExportKind] ?? 'export'}?`, `Started by ${e.created_by ?? 'someone'}. Anyone can start it again afterwards.`, [
      { text: 'Keep it running', style: 'cancel' },
      { text: 'Cancel export', style: 'destructive', onPress: go },
    ]);
  };

  const generatePdf = async () => {
    if (!projectId || !floor || !canGeneratePdf) return;
    setError(null);
    setBusy('Asking the server…');
    try {
      await start(floorBody(projectId, floor.code, sections));
    } catch (e) {
      fail(e);
    } finally {
      if (live.current) setBusy(null);
    }
  };
  const toggleSection = (k: FloorSection) =>
    setSections((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : FLOOR_SECTIONS.map((s) => s.key).filter((x) => x === k || cur.includes(x))));

  const generate = async () => {
    if (!projectId || !canGenerate) return;
    setError(null);
    setBusy('Asking the server…');
    try {
      await start(workbookBody(projectId, { levels, tabs }));
    } catch (e) {
      fail(e);
    } finally {
      if (live.current) setBusy(null);
    }
  };

  const syncFirst = () => {
    getSyncEngine()
      .then((e) => e.requestSync())
      .catch(fail);
  };

  const share = async (e: ExportRow) => {
    setError(null);
    try {
      const have = await localExport(e);
      if (!have) setBusy(`Downloading ${e.filename ?? 'the file'}…`);
      const file = have ?? (await ensureExportFile(identity, e));
      if (live.current) setBusy(null);
      setOnIpad(await downloadedExports(await openAppStore()));
      await shareExportFile(file);
    } catch (err) {
      if (live.current) setBusy(null);
      fail(err);
    }
  };

  const toggleLevel = (code: string) => {
    const all = pre?.levels.map((l) => l.code) ?? [];
    const cur = levels === 'all' ? all : levels;
    const next = cur.includes(code) ? cur.filter((c) => c !== code) : all.filter((c) => c === code || cur.includes(c));
    setLevels(next.length === all.length ? 'all' : next);
  };
  const toggleTab = (t: DataTab) => setTabs((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : DATA_TABS.filter((x) => x === t || cur.includes(x))));

  return (
    <View style={styles.root}>
      <View style={styles.nav}>
        <Text style={styles.brand}>Export</Text>
        <Text style={styles.project}>{projectName}</Text>
        {(['workbook', 'pdf', 'history'] as Pane[]).map((p) => (
          <Pressable key={p} onPress={() => setPane(p)} style={[styles.navItem, pane === p && styles.navActive]}>
            <Text style={styles.navText}>{p === 'workbook' ? KIND_LABEL.xlsx : p === 'pdf' ? KIND_LABEL.floor_pdf : 'History'}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Link href={projectId ? { pathname: '/', params: { project: projectId } } : '/'} style={styles.back}>
          ← Levels
        </Link>
      </View>

      <ScrollView style={styles.main} contentContainerStyle={styles.mainContent}>
        <View style={styles.statusRow}>
          <Text style={styles.status}>{describeSync(sync)}</Text>
          <Text style={styles.statusHint}>Exports run on the server and need a connection; edits never do.</Text>
        </View>
        {!projectId ? <Text style={styles.hint}>No project on this iPad yet.</Text> : null}

        {projectId && pane === 'workbook' ? (
          <Section title="Master workbook">
            <Text style={styles.label}>Levels</Text>
            <View style={styles.chips}>
              <Chip label="All in scope" on={levels === 'all'} onPress={() => setLevels('all')} />
              {pre?.levels.map((l) => (
                <Chip key={l.id} label={l.code} on={levels === 'all' || levels.includes(l.code)} onPress={() => toggleLevel(l.code)} />
              ))}
            </View>
            <Text style={styles.hint}>Row 2 of every tab: "{levelsTitle(pre?.levels ?? [], levels)}"</Text>

            <Text style={styles.label}>Tabs</Text>
            <View style={styles.chips}>
              {FIXED_TABS.map((t) => (
                <Text key={t} style={styles.fixed}>
                  ☑ {t}
                </Text>
              ))}
              {DATA_TABS.map((t) => (
                <Check key={t} label={t} value={tabs.includes(t)} onChange={() => toggleTab(t)} />
              ))}
            </View>
            <Text style={styles.hint}>Summary and Lists are always included; a Summary table is left out with its tab. There is no Change Log tab (history stays in the app).</Text>

            <Text style={styles.label}>Pre-flight</Text>
            <Text style={styles.value}>{pre ? preflightLine(pre, sync.pendingOps, blobs.photosWaiting) : '…'}</Text>
            {!!pre?.lint && !!projectId ? (
              <Link href={{ pathname: '/review', params: { project: projectId, kind: 'lint' } }} style={styles.back}>
                See the {pre.lint} lint finding{pre.lint === 1 ? '' : 's'} ▸
              </Link>
            ) : null}
            <Text style={[styles.gate, gateOk(xlsxJob) ? styles.gateOk : styles.gateNo]}>{gateLine(xlsxJob)}</Text>

            <View style={styles.row}>
              <Btn title="Sync first" onPress={syncFirst} disabled={sync.state === 'syncing'} />
              <Btn title="Generate workbook" primary onPress={() => void generate()} disabled={!canGenerate} />
            </View>
            {busy ? <Text style={styles.hint}>{busy}</Text> : null}
            <Notice text={error} error />

            {xlsxJob ? <JobCard e={xlsxJob} now={now} onShare={share} onCancel={cancel} downloaded={!!onIpad[xlsxJob.id]} /> : null}
          </Section>
        ) : null}

        {projectId && pane === 'pdf' ? (
          <Section title="Floor PDF">
            <Text style={styles.label}>Level</Text>
            <View style={styles.chips}>
              {pre?.levels.map((l) => (
                <Chip key={l.id} label={l.code} on={floor?.code === l.code} onPress={() => setFloorLevel(l.code)} />
              ))}
            </View>
            <Text style={styles.label}>Include</Text>
            <View style={styles.chips}>
              {FLOOR_SECTIONS.map((s) => (
                <Check key={s.key} label={s.label} value={sections.includes(s.key)} onChange={() => toggleSection(s.key)} />
              ))}
            </View>
            <Text style={styles.hint}>Header: "{floorHeader(floor)}" — the survey date only, no company name.</Text>
            <Text style={styles.hint}>Findings are the devices whose status is not Installed, untested, several per page with a plan crop and photos. Everyone's ink is drawn on the plan.</Text>

            <Text style={styles.label}>Pre-flight</Text>
            <Text style={styles.value}>{pre ? preflightLine(pre, sync.pendingOps, blobs.photosWaiting) : '…'}</Text>
            {!!pre?.lint && !!projectId ? (
              <Link href={{ pathname: '/review', params: { project: projectId, kind: 'lint' } }} style={styles.back}>
                See the {pre.lint} lint finding{pre.lint === 1 ? '' : 's'} ▸
              </Link>
            ) : null}
            <Text style={[styles.gate, gateOk(pdfJob) ? styles.gateOk : styles.gateNo]}>{gateLine(pdfJob)}</Text>
            <View style={styles.row}>
              <Btn title="Sync first" onPress={syncFirst} disabled={sync.state === 'syncing'} />
              <Btn title="Generate PDF" primary onPress={() => void generatePdf()} disabled={!canGeneratePdf} />
            </View>
            {busy ? <Text style={styles.hint}>{busy}</Text> : null}
            <Notice text={error} error />
            {pdfJob ? <JobCard e={pdfJob} now={now} onShare={share} onCancel={cancel} downloaded={!!onIpad[pdfJob.id]} /> : null}
          </Section>
        ) : null}

        {projectId && pane === 'history' ? (
          <Section title="History">
            <View style={styles.row}>
              <Btn title="Refresh" small onPress={() => void refreshHistory().catch(fail)} />
            </View>
            <Notice text={historyNote} />
            {busy ? <Text style={styles.hint}>{busy}</Text> : null}
            <Notice text={error} error />
            {history.length === 0 ? <Text style={styles.hint}>No exports yet.</Text> : null}
            {history.map((e) => (
              <JobCard key={e.id} e={jobs[e.kind]?.id === e.id ? jobs[e.kind]! : e} now={now} onShare={share} onCancel={cancel} downloaded={!!onIpad[e.id]} history />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function JobCard({
  e,
  now,
  onShare,
  onCancel,
  downloaded,
  history,
}: {
  e: ExportRow;
  now: number;
  onShare: (e: ExportRow) => void;
  onCancel: (e: ExportRow) => void;
  downloaded: boolean;
  history?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const diff = diffLine(e);
  const detail = diffDetail(e);
  const progress = progressLine(e, now);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTime}>
        {exportTime(e.created_at)} · {KIND_LABEL[e.kind] ?? e.kind}
      </Text>
      {e.filename ? <Text style={styles.cardFile}>{e.filename}</Text> : null}
      <Text style={styles.cardLine}>{scopeLine(e)}</Text>
      {e.created_by ? <Text style={styles.cardLine}>Started by {startedBy(e)}</Text> : null}
      {progress ? (
        <Text style={styles.progress}>{progress}</Text>
      ) : (
        <Text style={[styles.cardLine, e.job_state === 'failed' && styles.failed]}>{jobLine(e)}</Text>
      )}
      {isActive(e) && !e.cancel_requested_at ? (
        <View style={styles.row}>
          <Btn title="Cancel export" small onPress={() => onCancel(e)} />
        </View>
      ) : null}
      {diff ? (
        <Pressable onPress={() => setOpen(!open)} disabled={!detail.length}>
          <Text style={styles.cardLine}>
            {diff}
            {detail.length ? (open ? ' ▾' : ' ▸') : ''}
          </Text>
        </Pressable>
      ) : null}
      {open ? detail.map((d) => <Text key={d} style={styles.detail}>{d}</Text>) : null}
      {e.stats?.images_missing ? <Text style={styles.cardLine}>⚠ {e.stats.images_missing} Photo Log picture(s) were not on the server yet</Text> : null}
      {e.job_state === 'done' ? (
        <View style={styles.row}>
          <Btn title="Open in… / Share / Save to Files" small primary={!history} onPress={() => onShare(e)} />
          {downloaded ? <Text style={styles.onIpad}>✓ on this iPad</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#ffffff' },
  nav: { width: 220, backgroundColor: '#f3f5f8', borderRightWidth: 1, borderRightColor: '#d5d9e0', padding: 12, paddingTop: 48, gap: 2 },
  brand: { fontSize: 20, fontWeight: '700', color: '#1f3864' },
  project: { fontSize: 13, color: '#5a6270', marginBottom: 12 },
  navItem: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 6 },
  navActive: { backgroundColor: '#dde5f2' },
  navText: { fontSize: 15, color: '#1b2430' },
  back: { fontSize: 15, color: '#1f5fbf', paddingVertical: 10 },
  main: { flex: 1 },
  mainContent: { padding: 20, paddingTop: 48, gap: 12 },
  statusRow: { gap: 2 },
  status: { fontSize: 15, fontWeight: '600', color: '#1b2430' },
  statusHint: { fontSize: 13, color: '#5a6270' },
  label: { fontSize: 13, fontWeight: '700', color: '#5a6270', marginTop: 10 },
  value: { fontSize: 15, color: '#1b2430' },
  hint: { fontSize: 13, color: '#5a6270' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: '#b8c0cc', backgroundColor: '#ffffff' },
  chipOn: { backgroundColor: '#1f3864', borderColor: '#1f3864' },
  chipText: { fontSize: 14, color: '#1b2430' },
  chipTextOn: { fontSize: 14, color: '#ffffff' },
  fixed: { fontSize: 15, color: '#8a919c', paddingVertical: 8, paddingRight: 8 },
  gate: { fontSize: 14, marginTop: 6 },
  gateOk: { color: '#2e7d32' },
  gateNo: { color: '#b26a00' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
  card: { borderWidth: 1, borderColor: '#d5d9e0', borderRadius: 8, padding: 12, gap: 3, marginTop: 10 },
  cardTime: { fontSize: 14, fontWeight: '700', color: '#1b2430' },
  cardFile: { fontSize: 14, color: '#1b2430' },
  cardLine: { fontSize: 13, color: '#3a4250' },
  detail: { fontSize: 12, color: '#5a6270', marginLeft: 12 },
  failed: { color: '#c62828' },
  progress: { fontSize: 14, fontWeight: '600', color: '#1f3864' },
  onIpad: { fontSize: 13, color: '#2e7d32' },
});
