/**
 * The riser crop under the end editor in the cable view (T39, Phase 3 §5; T106). A cable made from
 * a riser draft carries `riser_ref = {blob, file, page, bbox}` (D191): the riser PDF kept by its
 * import batch, opened in the plan's PDF viewer on that page and focused on the bubble, which is
 * outlined. The bbox is in the page's display frame (the riser is drawn on `/Rotate 270` pages), so
 * it goes through `displayRectToPage` with the rotation the viewer reports. A ref accepted offline
 * has no blob yet: it is found by file name from the project's imports (`GET /imports`). The PDF is
 * fetched on demand by the blob queue like a sheet (⤓ Download). The `{sheet, bbox}` form (D180)
 * still opens that sheet's blob, though nothing writes it. Pinch to look around; it never edits.
 */

import type { BlobQueue, Store } from '@field-survey/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Pdf, { type PdfRef } from 'react-native-pdf';

import { getBlobFiles } from '../blobs/queue';
import { listImports, riserBlobFor } from '../drafts/api';
import { useIdentity } from '../identity/IdentityGate';
import { displayRectToPage, nativeFocusRect, pageRectToView, rotationOf, sheetRectToPage, type PdfViewport, type Rect } from '../plan/viewport';
import { riserBlobOf, type RiserRef } from './model';

const PAD = 0.15; // margin around a sheet-form bbox, as a share of its size
const RISER_PAD = 120; // points around a riser bubble: enough of the line to see where it goes (as the review crop)

type Source = { blob: string | null; page: number; title: string | null };

const grow = (b: Rect, dx: number, dy: number): Rect => ({ x: b.x - dx, y: b.y - dy, width: b.width + 2 * dx, height: b.height + 2 * dy });

export function RiserCrop({ store, projectId, riser, blobs }: { store: Store; projectId: string | null; riser: RiserRef | null; blobs: Pick<BlobQueue, 'ensureLocal'> | null }) {
  const identity = useIdentity();
  const [source, setSource] = useState<Source | null | 'missing' | 'unresolved'>(null);
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState<'busy' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mark, setMark] = useState<Rect | null>(null);
  const pdfRef = useRef<PdfRef>(null);
  const focused = useRef(false);

  useEffect(() => {
    let live = true;
    focused.current = false;
    setSource(null);
    setMark(null);
    setError(null);
    setFetching(null);
    if (!riser) return;
    if (riser.kind === 'sheet') {
      store.get<Record<string, unknown>>('sheet', riser.sheetId).then(
        (s) => live && setSource(s ? { blob: typeof s.blob === 'string' ? s.blob : null, page: typeof s.page === 'number' ? s.page : 1, title: typeof s.title === 'string' ? s.title : null } : 'missing'),
        (e: unknown) => live && setError(String(e)),
      );
    } else {
      const title = `${riser.file ?? 'Riser'} p.${riser.page}`;
      if (riser.blob) setSource({ blob: riser.blob, page: riser.page, title });
      else if (!projectId) setSource('unresolved');
      else
        listImports(identity, projectId).then(
          (batches) => {
            if (!live) return;
            const blob = riserBlobOf(riser, (file) => riserBlobFor(batches, file));
            setSource(blob ? { blob, page: riser.page, title } : 'unresolved');
          },
          () => live && setSource('unresolved'),
        );
    }
    return () => {
      live = false;
    };
  }, [store, riser, identity, projectId, tick]);

  // `tick` re-reads the cache after ⤓ Download (and retries an unresolved blob).
  const uri = useMemo(() => {
    if (!source || typeof source === 'string' || !source.blob) return null;
    const files = getBlobFiles();
    const f = files.file(files.pathFor(source.blob, 'sheet'));
    return f.exists ? f.uri : null;
  }, [source, tick]);

  const download = useCallback(() => {
    if (!blobs || !source || typeof source === 'string' || !source.blob) return;
    setFetching('busy');
    blobs.ensureLocal(source.blob, 'sheet').then(
      (path) => {
        setFetching(path ? null : 'Not downloaded: no connection to the server (or the riser is not uploaded yet).');
        setTick((n) => n + 1);
      },
      (e: unknown) => setFetching(`Not downloaded: ${String(e)}`),
    );
  }, [blobs, source]);

  const onViewport = useCallback(
    (vp: PdfViewport) => {
      if (!riser || !source || typeof source === 'string') return;
      if (vp.page !== source.page - 1) return; // the viewer reports page 1 before it turns to ours
      const rotation = rotationOf(vp);
      const b = riser.bbox;
      const box = riser.kind === 'blob' ? displayRectToPage(vp, rotation, b) : sheetRectToPage(vp, b);
      if (riser.kind === 'blob') setMark(pageRectToView(vp, box));
      if (focused.current) return;
      focused.current = true;
      const around = riser.kind === 'blob' ? grow(box, RISER_PAD, RISER_PAD) : grow(box, box.width * PAD, box.height * PAD);
      const f = nativeFocusRect(rotation, around);
      pdfRef.current?.focusRect(f.x, f.y, f.width, f.height, false);
    },
    [riser, source],
  );

  let body: ReactNode;
  if (!riser) body = <Text style={styles.muted}>No riser crop for this cable: it was not made from a riser draft (Setup → Review drafts).</Text>;
  else if (error) body = <Text style={styles.error}>{error}</Text>;
  else if (source === 'missing') body = <Text style={styles.muted}>The riser sheet this cable points to is not on this iPad.</Text>;
  else if (source === 'unresolved')
    body = (
      <View style={styles.gap}>
        <Text style={styles.muted}>The riser PDF ({riser.kind === 'blob' ? (riser.file ?? 'no file name') : 'sheet'}) could not be found: the server is not reachable, or no riser upload of that name is in this project.</Text>
        <Pressable style={styles.btn} onPress={() => setTick((n) => n + 1)}>
          <Text style={styles.btnText}>Try again</Text>
        </Pressable>
      </View>
    );
  else if (!source) body = <Text style={styles.muted}>Loading…</Text>;
  else if (!uri)
    body = (
      <View style={styles.gap}>
        <Text style={styles.muted}>Riser not downloaded.</Text>
        {blobs && source.blob ? (
          <Pressable style={styles.btn} onPress={download} disabled={fetching === 'busy'}>
            <Text style={styles.btnText}>{fetching === 'busy' ? 'Downloading…' : '⤓ Download riser'}</Text>
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
          page={source.page}
          fitPolicy={2}
          minScale={1}
          maxScale={32}
          spacing={0}
          enableAnnotationRendering={false}
          enableTextSelection={false}
          onViewportChanged={onViewport}
          onError={(e) => setError(`The riser could not be opened: ${String((e as Error)?.message ?? e)}`)}
        />
        {mark ? <View pointerEvents="none" style={[styles.mark, { left: mark.x - 3, top: mark.y - 3, width: mark.width + 6, height: mark.height + 6 }]} /> : null}
      </View>
    );

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Riser crop{source && typeof source !== 'string' && source.title ? ` · ${source.title}` : ''}</Text>
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
  mark: { position: 'absolute', borderWidth: 2, borderColor: '#d32f2f', borderRadius: 2 },
  btn: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
});
