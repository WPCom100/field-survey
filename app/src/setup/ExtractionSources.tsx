import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { extractionLine, listImports, startExtraction, type Batch, type ExtractionKind } from '../drafts/api';
import { useIdentity } from '../identity/IdentityGate';
import { getImport, isFinished, type FilePart } from './imports';
import { nativeUploadPart } from './upload-native';
import { Btn, Notice, Section } from './widgets';

const PDF = 'application/pdf';
const TITLE: Record<ExtractionKind, string> = { bom: 'BOM', riser: 'Riser' };

/**
 * Setup step 3, Sources → BOM and riser (Phase 3 §3.2, T42 / T43, reachable from the iPad since
 * T44): pick the PDF, the server extracts device drafts (BOM) and device + cable drafts with
 * endpoints read by the Claude API (riser); the drafts arrive with the next sync for step 4.
 * Upload the BOM first, then the riser (it merges into the BOM's drafts, D28). Needs a connection.
 */
export function ExtractionSources({ projectId }: { projectId: string }) {
  const identity = useIdentity();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    listImports(identity, projectId).then(
      (b) => live.current && setBatches(b.filter((x) => x.kind === 'bom' || x.kind === 'riser')),
      (e: unknown) => live.current && setError(`The server's import list could not be read: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [identity, projectId]);
  useEffect(refresh, [refresh]);

  const pick = async (kind: ExtractionKind) => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: [PDF], copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    const part: FilePart = { uri: a.uri, name: a.name, type: a.mimeType ?? PDF };
    setBusy(`Uploading ${a.name}…`);
    try {
      const b = await startExtraction(identity, projectId, kind, nativeUploadPart(part));
      if (live.current) setBatches((list) => [b, ...(list ?? []).filter((x) => x.id !== b.id)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // follow unfinished jobs
  const open = (batches ?? []).filter((b) => !isFinished(b.job_state)).map((b) => b.id).join(',');
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      for (const id of open.split(',')) {
        getImport(identity, id).then(
          (b) => live.current && setBatches((list) => (list ?? []).map((x) => (x.id === b.id ? { ...x, ...b } : x))),
          () => undefined,
        );
      }
    }, 3000);
    return () => clearInterval(t);
  }, [identity, open]);

  const latest = (kind: ExtractionKind) => (batches ?? []).find((b) => b.kind === kind) ?? null;
  return (
    <Section title="BOM and riser">
      <Text style={styles.hint}>
        Upload the BOM first, then the riser. The server reads them into device and cable drafts (the riser's far ends by the Claude API, about 12 minutes); the drafts reach this iPad with the next sync and are reviewed in step 4. Needs a connection.
      </Text>
      {(['bom', 'riser'] as const).map((kind) => {
        const b = latest(kind);
        return (
          <View key={kind} style={styles.row}>
            <Text style={styles.kind}>{TITLE[kind]}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.file}>{b ? (b.files?.[0]?.name ?? '?') : '—'}</Text>
              {b ? <Text style={[styles.line, b.job_state === 'failed' && styles.warn]}>{extractionLine(kind, b)}</Text> : null}
            </View>
            <Btn title={b ? 'Upload another…' : 'Choose PDF…'} small disabled={busy !== null} onPress={() => void pick(kind).catch((e: unknown) => setError(String(e)))} />
          </View>
        );
      })}
      {busy ? <Text style={styles.hint}>{busy}</Text> : null}
      <Notice text={error} error />
      {(batches ?? []).some((b) => b.job_state === 'done') ? (
        <View style={styles.row}>
          <Btn title="Review drafts ▸" primary small onPress={() => router.setParams({ step: 'drafts' })} />
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: '#666' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8' },
  kind: { width: 60, fontSize: 15, fontWeight: '700' },
  file: { fontSize: 14 },
  line: { fontSize: 13, color: '#444' },
  warn: { color: '#b26a00' },
});
