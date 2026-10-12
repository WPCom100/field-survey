import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useIdentity } from '../identity/IdentityGate';
import { Btn, ChipPicker, Notice, Section } from './widgets';
import {
  KIND_LABEL,
  fieldLabel,
  getImport,
  initialMapping,
  isFinished,
  jobLine,
  overrides,
  previewWorkbook,
  startImport,
  unmatched,
  type FilePart,
  type ImportBatch,
  type ImportKind,
  type ImportPreview,
  type Mapping,
} from './imports';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NO_PREVIEW: ImportPreview = { name: '', tabs: [], levels: [], images: 0, checks: [] };

/**
 * Setup step 3, Sources → Seed import (T28, Phase 3 §3.2): pick a master or floor workbook from
 * Files, look at the pre-matched column mapping and the checks, import, follow the job, then open
 * Needs review. The server reads the workbook (preview and import), so this needs a connection;
 * nothing is written until Import.
 */
export function SourcesStep({ projectId }: { projectId: string }) {
  const identity = useIdentity();
  const [kind, setKind] = useState<ImportKind>('master_xlsx');
  const [file, setFile] = useState<FilePart | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const pick = useCallback(async () => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: [XLSX], copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    const part: FilePart = { uri: a.uri, name: a.name, type: a.mimeType ?? XLSX };
    setFile(part);
    setPreview(null);
    setBatch(null);
    setBusy('Reading the workbook…');
    try {
      const p = await previewWorkbook(identity, part);
      if (!live.current) return;
      setPreview(p);
      setMapping(initialMapping(p));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [identity]);

  /** Read the workbook again under the chosen mapping: the matches and the checks update. */
  const recheck = async () => {
    if (!file || !preview) return;
    setError(null);
    setBusy('Checking…');
    try {
      const p = await previewWorkbook(identity, file, overrides(preview, mapping));
      if (!live.current) return;
      setPreview(p);
      setMapping(initialMapping(p));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!file || !preview) return;
    setError(null);
    setBusy('Uploading…');
    try {
      setBatch(await startImport(identity, projectId, kind, file, overrides(preview, mapping)));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  // Follow the job until it finishes.
  const batchId = batch?.id;
  const finished = batch ? isFinished(batch.job_state) : true;
  useEffect(() => {
    if (!batchId || finished) return;
    const t = setInterval(() => {
      getImport(identity, batchId).then(
        (b) => live.current && setBatch(b),
        () => undefined,
      );
    }, 2000);
    return () => clearInterval(t);
  }, [identity, batchId, finished]);

  const open = unmatched(preview ?? NO_PREVIEW, mapping);
  const running = batch !== null && !finished;

  return (
    <>
      <Section title="Seed import">
        <Text style={styles.hint}>
          Import a master workbook, or one floor's workbook, as the project's starting records. The server reads the file, so this needs a connection. Rows that do not fit the vocabulary go to Needs review; nothing is locked.
        </Text>
        <View style={styles.row}>
          {(Object.keys(KIND_LABEL) as ImportKind[]).map((k) => (
            <Btn key={k} title={KIND_LABEL[k]} small primary={kind === k} disabled={running} onPress={() => setKind(k)} />
          ))}
        </View>
        <View style={styles.row}>
          <Btn title={file ? 'Choose another file…' : 'Choose workbook…'} onPress={() => void pick().catch(fail)} disabled={busy !== null || running} />
          {file ? <Text style={styles.file}>{file.name}</Text> : null}
        </View>
        {busy ? <Text style={styles.hint}>{busy}</Text> : null}
        <Notice text={error} error />
      </Section>

      {preview ? (
        <>
          <Section title="Checks">
            <Text style={styles.line}>
              {kind === 'floor_xlsx' ? 'Floors in this file' : 'Floors'}: {preview.levels.length ? preview.levels.join(', ') : 'none found'}
              {preview.images ? `  ·  ${preview.images} photos` : ''}
            </Text>
            {preview.tabs.map((t) => (
              <Text key={t.tab} style={[styles.line, !t.found && styles.dim]}>
                {t.found ? `${t.tab}: ${t.rows} rows` : `${t.tab}: not in this workbook (skipped)`}
              </Text>
            ))}
            {open.length ? (
              <Text style={styles.warn}>
                {open.length} column{open.length === 1 ? '' : 's'} not matched: {open.map((o) => `${o.tab} › ${fieldLabel(o.field)}`).join(', ')}. Map them below, or import without.
              </Text>
            ) : (
              <Text style={styles.ok}>Every column is matched.</Text>
            )}
            {preview.checks.slice(0, 12).map((c, i) => (
              <Text key={i} style={styles.check}>
                • {c}
              </Text>
            ))}
            {preview.checks.length > 12 ? <Text style={styles.dim}>…and {preview.checks.length - 12} more</Text> : null}
          </Section>

          <Section title="Column mapping">
            {preview.tabs
              .filter((t) => t.found)
              .map((t) => (
                <View key={t.tab} style={styles.tab}>
                  <Text style={styles.tabTitle}>{t.tab}</Text>
                  <View style={styles.grid}>
                    {t.fields.map((f) => {
                      const value = mapping[t.tab]?.[f.field] || null;
                      return (
                        <View key={f.field} style={styles.cell}>
                          <Text style={[styles.fieldName, !value && styles.warnText]}>{fieldLabel(f.field)}</Text>
                          <ChipPicker
                            value={value}
                            options={t.headers.map((h) => ({ id: h, label: h }))}
                            none="not in this workbook"
                            disabled={running}
                            onPick={(h) => setMapping((m) => ({ ...m, [t.tab]: { ...m[t.tab], [f.field]: h ?? '' } }))}
                          />
                        </View>
                      );
                    })}
                  </View>
                </View>
              ))}
            <View style={styles.row}>
              <Btn title="Re-check with this mapping" disabled={busy !== null || running} onPress={() => void recheck()} />
              <Btn title={`Import ${KIND_LABEL[kind].toLowerCase()}`} primary disabled={busy !== null || running} onPress={() => void run()} />
            </View>
          </Section>
        </>
      ) : null}

      {batch ? (
        <Section title="Import">
          <Text style={[styles.line, batch.job_state === 'failed' && styles.warnText]}>{jobLine(batch)}</Text>
          {batch.job_state === 'done' && batch.stats ? (
            <>
              <Text style={styles.line}>
                {batch.stats.review_items ?? 0} items for Needs review · {batch.stats.findings ?? 0} findings · {batch.stats.unpaired_ends ?? 0} unpaired connection ends
              </Text>
              {(batch.stats.checks_list ?? []).slice(0, 12).map((c, i) => (
                <Text key={i} style={styles.check}>
                  • {c}
                </Text>
              ))}
              <View style={styles.row}>
                <Btn title="Open Needs review" primary onPress={() => router.push('/review')} />
              </View>
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: '#666' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  file: { fontSize: 14, color: '#333' },
  line: { fontSize: 14 },
  dim: { fontSize: 13, color: '#888' },
  ok: { fontSize: 14, color: '#2e7d32' },
  warn: { fontSize: 14, color: '#b26a00' },
  warnText: { color: '#b26a00' },
  check: { fontSize: 13, color: '#555' },
  tab: { gap: 6, marginBottom: 10 },
  tabTitle: { fontSize: 15, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cell: { width: 220, gap: 3 },
  fieldName: { fontSize: 12, color: '#555' },
});
