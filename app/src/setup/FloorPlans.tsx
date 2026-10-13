import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { useIdentity } from '../identity/IdentityGate';
import { syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import { getImport, isFinished, type FilePart, type ImportBatch } from './imports';
import { nativeUploadPart } from './upload-native';
import { loadLevelSheets, sheetJobLine, startSheetImport, type LevelSheets, type SheetKind } from './sheets';
import { Btn, Notice, Section } from './widgets';

const PDF = 'application/pdf';

/**
 * Setup step 3, Sources → Floor plans (T45, Phase 3 §3.2): per level, the display sheet
 * (composite) and the source sheets. Choose… picks a PDF from Files and uploads it; the server
 * reads the grid bubbles, rooms, tags and boundaries and the sheet arrives with the next sync,
 * when the row shows the grid summary ("auto ✓ 3 sets"). Calibration by hand is on the plan
 * itself (⌗ Grid), where the bubbles can be tapped.
 */
export function FloorPlans({ projectId }: { projectId: string }) {
  const identity = useIdentity();
  const reloadKey = syncDataKey(useSyncStatus()); // a pull brought the new sheet row (T67)
  const [levels, setLevels] = useState<LevelSheets[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<{ levelId: string; kind: SheetKind; name: string; batch: ImportBatch }[]>([]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    openAppStore()
      .then((store) => loadLevelSheets(store, projectId))
      .then((l) => active && setLevels(l), (e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [projectId, reloadKey, jobs]);

  const pick = useCallback(
    async (levelId: string, code: string, kind: SheetKind) => {
      setError(null);
      const res = await DocumentPicker.getDocumentAsync({ type: [PDF], copyToCacheDirectory: true, multiple: false });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      const part: FilePart = { uri: a.uri, name: a.name, type: a.mimeType ?? PDF };
      setBusy(`Uploading ${a.name} for ${code}…`);
      try {
        const batch = await startSheetImport(identity, projectId, levelId, kind, nativeUploadPart(part));
        if (!live.current) return;
        setJobs((j) => [{ levelId, kind, name: a.name, batch }, ...j.filter((o) => o.batch.id !== batch.id)]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [identity, projectId],
  );

  // Follow unfinished jobs.
  const open = jobs.filter((j) => !isFinished(j.batch.job_state)).map((j) => j.batch.id);
  const openKey = open.join(',');
  useEffect(() => {
    if (!openKey) return;
    const t = setInterval(() => {
      for (const id of openKey.split(',')) {
        getImport(identity, id).then(
          (b) => live.current && setJobs((j) => j.map((o) => (o.batch.id === b.id ? { ...o, batch: b } : o))),
          () => undefined,
        );
      }
    }, 2000);
    return () => clearInterval(t);
  }, [identity, openKey]);

  return (
    <Section title="Floor plans">
      <Text style={styles.hint}>
        One display sheet (the level's composite) and any number of source sheets per level, as PDF. The server reads the grid bubbles, room codes, panel tags and the source-sheet boundaries; the sheet reaches every iPad with the next sync. Needs a connection.
      </Text>
      <View style={styles.head}>
        <Text style={[styles.cLvl, styles.label]}>Lvl</Text>
        <Text style={[styles.cDisplay, styles.label]}>Display sheet (composite)</Text>
        <Text style={[styles.cGrid, styles.label]}>Grid</Text>
        <Text style={[styles.cSource, styles.label]}>Source sheets</Text>
      </View>
      {levels === null ? <Text style={styles.hint}>Loading…</Text> : null}
      {levels?.map((l) => (
        <View key={l.levelId} style={styles.row}>
          <Text style={styles.cLvl}>{l.code}</Text>
          <View style={styles.cDisplay}>
            <Text style={styles.cell} numberOfLines={1}>
              {l.display ? `${l.display.title ?? 'sheet'}${l.display.cached ? '' : ' (not downloaded yet)'}` : '—'}
            </Text>
            <Btn title={l.display ? 'Replace…' : 'Choose…'} small disabled={busy !== null} onPress={() => void pick(l.levelId, l.code, 'display').catch((e: unknown) => setError(String(e)))} />
          </View>
          <View style={styles.cGrid}>
            {l.display ? (
              <>
                <Text style={[styles.cell, l.display.grid.startsWith('needs') || l.display.grid.startsWith('no grid') ? styles.warn : styles.ok]}>{l.display.grid}</Text>
                <Btn title="Open plan ▸" small onPress={() => router.push({ pathname: '/plan/[levelId]', params: { levelId: l.levelId } })} />
              </>
            ) : (
              <Text style={styles.dim}>—</Text>
            )}
          </View>
          <View style={styles.cSource}>
            <Text style={styles.cell} numberOfLines={2}>
              {l.sources.length ? l.sources.map((s) => s.title ?? `p.${s.page}`).join(', ') : '—'}
            </Text>
            <Btn title="Add…" small disabled={busy !== null} onPress={() => void pick(l.levelId, l.code, 'source').catch((e: unknown) => setError(String(e)))} />
          </View>
        </View>
      ))}
      {levels && levels.length === 0 ? <Text style={styles.hint}>No levels yet — add them in step 2.</Text> : null}
      {busy ? <Text style={styles.hint}>{busy}</Text> : null}
      <Notice text={error} error />
      {jobs.map((j) => (
        <Text key={j.batch.id} style={[styles.job, j.batch.job_state === 'failed' && styles.warn]}>
          {levels?.find((l) => l.levelId === j.levelId)?.code ?? ''} {j.kind}: {j.name} — {sheetJobLine(j.batch)}
        </Text>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: '#666' },
  label: { fontSize: 12, color: '#555', fontWeight: '700' },
  head: { flexDirection: 'row', gap: 8, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8' },
  cLvl: { width: 48, fontSize: 15, fontWeight: '700' },
  cDisplay: { flex: 3, gap: 4 },
  cGrid: { flex: 2, gap: 4 },
  cSource: { flex: 3, gap: 4 },
  cell: { fontSize: 14 },
  dim: { fontSize: 14, color: '#888' },
  ok: { color: '#2e7d32' },
  warn: { color: '#b26a00' },
  job: { fontSize: 13, color: '#333' },
});
