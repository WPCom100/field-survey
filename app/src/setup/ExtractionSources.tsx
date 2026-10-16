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
const JSON_MIME = 'application/json';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TITLE: Record<ExtractionKind, string> = { bom: 'BOM', riser: 'Riser', davinci: 'DaVinci' };

/** The two files a DaVinci import takes, told apart by name: `library.json` and the mapping `.xlsx`. */
export function splitDavinciFiles(files: readonly FilePart[]): { library: FilePart | null; categories: FilePart | null; stray: string[] } {
  let library: FilePart | null = null;
  let categories: FilePart | null = null;
  const stray: string[] = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.json')) library = f;
    else if (name.endsWith('.xlsx')) categories = f;
    else stray.push(f.name);
  }
  return { library, categories, stray };
}

/**
 * Setup step 3, Sources → BOM and riser (Phase 3 §3.2, T42 / T43, reachable from the iPad since
 * T44): pick the PDF, the server extracts device drafts (BOM) and device + cable drafts with
 * endpoints read by the Claude API (riser); the drafts arrive with the next sync for step 4.
 * Upload the BOM first, then the riser (it merges into the BOM's drafts, D28). Needs a connection.
 * The DaVinci library (T111) is uploaded here too, filed under this project: it seeds the **app**
 * library's device types as drafts, and this project's vocabulary takes the port protocols that
 * have no cable code (as `cable_code` drafts).
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
      (b) => live.current && setBatches(b.filter((x) => x.kind === 'bom' || x.kind === 'riser' || x.kind === 'davinci')),
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

  const pickDavinci = async () => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: [JSON_MIME, XLSX, 'public.json', 'public.item'], copyToCacheDirectory: true, multiple: true });
    if (res.canceled || !res.assets.length) return;
    const parts = res.assets.map((a): FilePart => ({ uri: a.uri, name: a.name, type: a.mimeType ?? (a.name.toLowerCase().endsWith('.xlsx') ? XLSX : JSON_MIME) }));
    const { library, categories, stray } = splitDavinciFiles(parts);
    if (!library) {
      setError(`Pick DaVinci's library.json${stray.length ? ` (not ${stray.join(', ')})` : ''}, with DaVinci_categories.xlsx the first time.`);
      return;
    }
    setBusy(`Uploading ${library.name}${categories ? ` and ${categories.name}` : ''}…`);
    try {
      const b = await startExtraction(identity, projectId, 'davinci', nativeUploadPart(library), categories ? { categories: nativeUploadPart(categories) } : {});
      if (live.current) setBatches((list) => [b, ...(list ?? []).filter((x) => x.id !== b.id)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const latest = (kind: ExtractionKind) => (batches ?? []).find((b) => b.kind === kind) ?? null;
  const davinci = latest('davinci');
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
      <Text style={[styles.hint, styles.gap]}>
        <Text style={styles.kind}>DaVinci library. </Text>
        Seeds the app library (every project) with ETC's product types as drafts: pick DaVinci's library.json from Files (DaVinci writes it to its AppData folder at launch; copy it to iCloud Drive first) and, the first time or after you regroup the categories, DaVinci_categories.xlsx with it. Re-running on a newer file updates the drafts; accepted types are left alone.
      </Text>
      <View style={styles.row}>
        <Text style={styles.kind}>{TITLE.davinci}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.file}>{davinci ? (davinci.files ?? []).map((f) => f.name).join(' + ') || '?' : '—'}</Text>
          {davinci ? <Text style={[styles.line, davinci.job_state === 'failed' && styles.warn]}>{extractionLine('davinci', davinci)}</Text> : null}
        </View>
        <Btn title={davinci ? 'Upload again…' : 'Choose files…'} small disabled={busy !== null} onPress={() => void pickDavinci().catch((e: unknown) => setError(String(e)))} />
      </View>
      {busy ? <Text style={styles.hint}>{busy}</Text> : null}
      <Notice text={error} error />
      {(batches ?? []).some((b) => b.job_state === 'done' && b.kind !== 'davinci') ? (
        <View style={styles.row}>
          <Btn title="Review drafts ▸" primary small onPress={() => router.setParams({ step: 'drafts' })} />
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, color: '#666' },
  gap: { marginTop: 10 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e3e5e8' },
  kind: { width: 60, fontSize: 15, fontWeight: '700' },
  file: { fontSize: 14 },
  line: { fontSize: 13, color: '#444' },
  warn: { color: '#b26a00' },
});
