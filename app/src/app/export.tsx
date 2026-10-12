import { Link, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useBlobStatus } from '../blobs/useBlobStatus';
import { openAppStore } from '../db';
import { ensureExportFile, localExport, shareExportFile } from '../export/files';
import {
  DATA_TABS,
  FIXED_TABS,
  KIND_LABEL,
  cachedHistory,
  diffDetail,
  diffLine,
  downloadedExports,
  exportTime,
  getExport,
  isFinished,
  jobLine,
  levelsTitle,
  listExports,
  loadPreflight,
  preflightLine,
  rememberHistory,
  scopeLine,
  startExport,
  startGate,
  workbookBody,
  type DataTab,
  type ExportRow,
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
  const [job, setJob] = useState<ExportRow | null>(null);
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

  // Follow the running job.
  const jobId = job?.id;
  const finished = job ? isFinished(job.job_state) : true;
  useEffect(() => {
    if (!jobId || finished) return;
    const t = setInterval(() => {
      getExport(identity, jobId).then(
        (e) => {
          if (!live.current) return;
          setJob(e);
          if (isFinished(e.job_state)) refreshHistory().catch(fail);
        },
        () => undefined,
      );
    }, 2000);
    return () => clearInterval(t);
  }, [identity, jobId, finished, refreshHistory]);

  const gate = startGate(sync);
  const running = job !== null && !finished;
  const chosenLevels = levels === 'all' ? (pre?.levels.length ?? 0) : levels.length;
  const canGenerate = gate.ok && !running && busy === null && tabs.length > 0 && chosenLevels > 0;

  const generate = async () => {
    if (!projectId || !canGenerate) return;
    setError(null);
    setBusy('Asking the server…');
    try {
      setJob(await startExport(identity, workbookBody(projectId, { levels, tabs })));
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
            <Text style={[styles.gate, gate.ok ? styles.gateOk : styles.gateNo]}>{gate.reason}</Text>

            <View style={styles.row}>
              <Btn title="Sync first" onPress={syncFirst} disabled={sync.state === 'syncing'} />
              <Btn title="Generate workbook" primary onPress={() => void generate()} disabled={!canGenerate} />
            </View>
            {busy ? <Text style={styles.hint}>{busy}</Text> : null}
            <Notice text={error} error />

            {job ? <JobCard e={job} onShare={share} downloaded={!!onIpad[job.id]} /> : null}
          </Section>
        ) : null}

        {projectId && pane === 'pdf' ? (
          <Section title="Floor PDF">
            <Text style={styles.hint}>The floor report (cover with the plan, findings, connections, punch list, missing parts, photos) arrives with task T59.</Text>
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
              <JobCard key={e.id} e={e} onShare={share} downloaded={!!onIpad[e.id]} history />
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

function JobCard({ e, onShare, downloaded, history }: { e: ExportRow; onShare: (e: ExportRow) => void; downloaded: boolean; history?: boolean }) {
  const [open, setOpen] = useState(false);
  const diff = diffLine(e);
  const detail = diffDetail(e);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTime}>
        {exportTime(e.created_at)} · {KIND_LABEL[e.kind] ?? e.kind}
      </Text>
      {e.filename ? <Text style={styles.cardFile}>{e.filename}</Text> : null}
      <Text style={styles.cardLine}>{scopeLine(e)}</Text>
      <Text style={[styles.cardLine, e.job_state === 'failed' && styles.failed]}>{jobLine(e)}</Text>
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
  onIpad: { fontSize: 13, color: '#2e7d32' },
});
