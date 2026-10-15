/**
 * The riser crop under the end editor in the cable view (T39, Phase 3 §5): the riser sheet named by
 * `cable.riser_ref{sheet, bbox}` (D180), opened in the plan's PDF viewer and focused on the bbox
 * (sheet coordinates, `plan/viewport.ts`). Pinch to look around; it never edits anything. Shows
 * why there is no crop when the cable has no riser reference (nothing writes one before T43) or the
 * sheet is not on this iPad, with a download button for the latter.
 */

import type { BlobQueue, Store } from '@field-survey/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Pdf, { type PdfRef } from 'react-native-pdf';

import { getBlobFiles } from '../blobs/queue';
import { sheetRectToPage, type PdfViewport } from '../plan/viewport';
import type { RiserRef } from './model';

const PAD = 0.15; // margin around the bbox, as a share of its size

type Sheet = { blob: string | null; page: number; title: string | null };

export function RiserCrop({ store, riser, blobs }: { store: Store; riser: RiserRef | null; blobs: Pick<BlobQueue, 'ensureLocal'> | null }) {
  const [sheet, setSheet] = useState<Sheet | null | 'missing'>(null);
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState<'busy' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<PdfRef>(null);
  const focused = useRef(false);

  useEffect(() => {
    let live = true;
    focused.current = false;
    setSheet(null);
    if (!riser) return;
    store.get<Record<string, unknown>>('sheet', riser.sheetId).then(
      (s) => live && setSheet(s ? { blob: typeof s.blob === 'string' ? s.blob : null, page: typeof s.page === 'number' ? s.page : 1, title: typeof s.title === 'string' ? s.title : null } : 'missing'),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [store, riser]);

  // `tick` re-reads the cache after "Download riser sheet".
  const uri = useMemo(() => {
    if (!sheet || sheet === 'missing' || !sheet.blob) return null;
    const files = getBlobFiles();
    const f = files.file(files.pathFor(sheet.blob, 'sheet'));
    return f.exists ? f.uri : null;
  }, [sheet, tick]);

  const download = useCallback(() => {
    if (!blobs || !sheet || sheet === 'missing' || !sheet.blob) return;
    setFetching('busy');
    blobs.ensureLocal(sheet.blob, 'sheet').then(
      (path) => {
        setFetching(path ? null : 'Not downloaded: no connection to the server (or the sheet is not uploaded yet).');
        setTick((n) => n + 1);
      },
      (e: unknown) => setFetching(`Not downloaded: ${String(e)}`),
    );
  }, [blobs, sheet]);

  const onViewport = useCallback(
    (vp: PdfViewport) => {
      if (focused.current || !riser) return;
      focused.current = true;
      const b = riser.bbox;
      const p = sheetRectToPage(vp, { x: b.x - b.width * PAD, y: b.y - b.height * PAD, width: b.width * (1 + 2 * PAD), height: b.height * (1 + 2 * PAD) });
      pdfRef.current?.focusRect(p.x, p.y, p.width, p.height, false);
    },
    [riser],
  );

  let body: ReactNode;
  if (!riser) body = <Text style={styles.muted}>No riser crop for this cable: the riser has not been extracted for it (riser extraction, T43).</Text>;
  else if (error) body = <Text style={styles.error}>{error}</Text>;
  else if (sheet === 'missing') body = <Text style={styles.muted}>The riser sheet this cable points to is not on this iPad.</Text>;
  else if (!sheet) body = <Text style={styles.muted}>Loading…</Text>;
  else if (!uri)
    body = (
      <View style={styles.gap}>
        <Text style={styles.muted}>Riser sheet not downloaded.</Text>
        {blobs && sheet.blob ? (
          <Pressable style={styles.btn} onPress={download} disabled={fetching === 'busy'}>
            <Text style={styles.btnText}>{fetching === 'busy' ? 'Downloading…' : '⤓ Download riser sheet'}</Text>
          </Pressable>
        ) : null}
        {fetching && fetching !== 'busy' ? <Text style={styles.muted}>{fetching}</Text> : null}
      </View>
    );
  else
    body = (
      <View style={styles.frame}>
        <Pdf
          ref={pdfRef}
          style={styles.pdf}
          source={{ uri, cache: true }}
          page={sheet.page}
          fitPolicy={2}
          minScale={1}
          maxScale={32}
          spacing={0}
          enableAnnotationRendering={false}
          enableTextSelection={false}
          onViewportChanged={onViewport}
          onError={(e) => setError(`The riser sheet could not be opened: ${String((e as Error)?.message ?? e)}`)}
        />
      </View>
    );

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Riser crop{sheet && sheet !== 'missing' && sheet.title ? ` · ${sheet.title}` : ''}</Text>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 8, marginTop: 8, padding: 10, gap: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de' },
  title: { fontSize: 14, fontWeight: '700', color: '#333' },
  muted: { fontSize: 12, color: '#777' },
  error: { fontSize: 13, color: '#b71c1c' },
  gap: { gap: 6 },
  frame: { height: 220, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: '#c9ccd1' },
  pdf: { flex: 1, backgroundColor: '#f4f5f7' },
  btn: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
});
