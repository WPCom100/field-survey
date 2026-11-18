/**
 * The riser crop under the end editor in the cable view (T39, Phase 3 §5; T106). A cable made from
 * a riser draft carries `riser_ref = {blob, file, page, bbox}` (D191): the riser PDF kept by its
 * import batch, opened in the plan's PDF viewer on that page and focused on the bubble, which is
 * outlined. The bbox is in the page's display frame (the riser is drawn on `/Rotate 270` pages), so
 * it goes through `displayRectToPage` with the rotation the viewer reports. A ref accepted offline
 * has no blob yet: it is found by file name from the project's imports (`GET /imports`). The PDF is
 * fetched on demand by the blob queue like a sheet (⤓ Download). The `{sheet, bbox}` form (D180)
 * still opens that sheet's blob, though nothing writes it. It never edits.
 *
 * T129: PDFKit pinches and pans the riser natively; the outline follows on the UI thread (the
 * plan's viewport worklet, D106) instead of a re-render per frame, ⤢ Enlarge opens it full screen,
 * and a riser that does not load says why (no connection, timeout, the server's status, no upload
 * of that name) with Try again.
 */

import type { BlobQueue, Store } from '@field-survey/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import Pdf, { type PdfRef } from 'react-native-pdf';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { getBlobFiles } from '../blobs/queue';
import { failureText } from '../crops/model';
import { listImports, riserBlobFor } from '../drafts/api';
import { useIdentity } from '../identity/IdentityGate';
import { pdfNativeTag, useUiViewport } from '../plan/uiViewport';
import {
  displayRectToPage,
  nativeFocusRect,
  pageRectToSheet,
  pageRectToView,
  rotationOf,
  sheetRectToPage,
  sheetToView,
  type Affine,
  type PdfViewport,
  type Rect,
} from '../plan/viewport';
import { Btn, PanelHeader, color, font, radius, space } from '../ui';
import { riserBlobOf, type RiserRef } from './model';

const PAD = 0.15; // margin around a sheet-form bbox, as a share of its size
const RISER_PAD = 120; // points around a riser bubble: enough of the line to see where it goes (as the review crop)

type Source = { blob: string | null; page: number; title: string | null };
type Problem = { problem: string };

const grow = (b: Rect, dx: number, dy: number): Rect => ({ x: b.x - dx, y: b.y - dy, width: b.width + 2 * dx, height: b.height + 2 * dy });

export function RiserCrop({ store, projectId, riser, blobs }: { store: Store; projectId: string | null; riser: RiserRef | null; blobs: Pick<BlobQueue, 'fetchLocal'> | null }) {
  const identity = useIdentity();
  const [source, setSource] = useState<Source | null | 'missing' | Problem>(null);
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState<'busy' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState(false);

  useEffect(() => {
    let live = true;
    setSource(null);
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
      const file = riser.file ?? 'no file name';
      if (riser.blob) setSource({ blob: riser.blob, page: riser.page, title });
      else if (!projectId) setSource({ problem: `The riser PDF (${file}) is not known on this iPad yet and no project is open to look it up.` });
      else
        listImports(identity, projectId).then(
          (batches) => {
            if (!live) return;
            const blob = riserBlobOf(riser, (f) => riserBlobFor(batches, f));
            setSource(blob ? { blob, page: riser.page, title } : { problem: `No finished riser upload named "${file}" is in this project on the server (Setup → riser).` });
          },
          (e: unknown) => live && setSource({ problem: failureText(`The riser upload list (to find ${file})`, e) }),
        );
    }
    return () => {
      live = false;
    };
  }, [store, riser, identity, projectId, tick]);

  // `tick` re-reads the cache after ⤓ Download (and retries an unresolved blob).
  const uri = useMemo(() => {
    if (!source || typeof source === 'string' || 'problem' in source || !source.blob) return null;
    const files = getBlobFiles();
    const f = files.file(files.pathFor(source.blob, 'sheet'));
    return f.exists ? f.uri : null;
  }, [source, tick]);

  const download = useCallback(() => {
    if (!blobs || !source || typeof source === 'string' || 'problem' in source || !source.blob) return;
    setFetching('busy');
    blobs.fetchLocal(source.blob, 'sheet').then(
      (got) => {
        setFetching(got.path ? null : failureText('The riser PDF', got.failure));
        setTick((n) => n + 1);
      },
      (e: unknown) => setFetching(failureText('The riser PDF', e)),
    );
  }, [blobs, source]);

  const onPdfError = useCallback((e: unknown) => setError(`The riser could not be opened: ${String((e as Error)?.message ?? e)}`), []);

  let body: ReactNode;
  if (!riser) body = <Text style={styles.muted}>No riser crop for this cable.</Text>;
  else if (error) body = <Text style={styles.error}>{error}</Text>;
  else if (source === 'missing') body = <Text style={styles.muted}>The riser sheet this cable points to is not on this iPad.</Text>;
  else if (source && 'problem' in source)
    body = (
      <View style={styles.gap}>
        <Text style={styles.error} testID="riser.problem">{source.problem}</Text>
        <Btn title="Try again" small onPress={() => setTick((n) => n + 1)} testID="riser.retry" />
      </View>
    );
  else if (!source) body = <Text style={styles.muted}>Loading…</Text>;
  else if (!uri)
    body = (
      <View style={styles.gap}>
        <Text style={styles.muted} testID="riser.missing">Riser not downloaded.</Text>
        {blobs && source.blob ? (
          <Btn
            title={fetching === 'busy' ? 'Downloading…' : fetching ? '⤓ Try again' : '⤓ Download riser'}
            small
            onPress={download}
            disabled={fetching === 'busy'}
            testID="riser.download"
          />
        ) : null}
        {fetching && fetching !== 'busy' ? <Text style={styles.error}>{fetching}</Text> : null}
      </View>
    );
  else
    body = (
      <View style={styles.gap}>
        {big ? (
          <Text style={styles.muted}>Shown full screen.</Text>
        ) : (
          <View style={styles.frame}>
            <RiserPdf uri={uri} page={source.page} riser={riser} onError={onPdfError} />
          </View>
        )}
        <Btn title="⤢ Enlarge" small onPress={() => setBig(true)} testID="riser.enlarge" />
      </View>
    );

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Riser crop{source && typeof source !== 'string' && 'title' in source && source.title ? ` · ${source.title}` : ''}</Text>
      {body}
      {big && uri && riser && source && typeof source !== 'string' && !('problem' in source) ? (
        <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={() => setBig(false)}>
          <View style={styles.modal}>
            {/* closes to nothing: × at the top right (D280 (5), T191; was a Close button) */}
            <View style={styles.bar}>
              <PanelHeader title={`Riser crop${source.title ? ` · ${source.title}` : ''}`} close={{ onPress: () => setBig(false), testID: 'riser.close' }} />
            </View>
            <RiserPdf uri={uri} page={source.page} riser={riser} onError={onPdfError} />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

/** The riser page in PDFKit, focused on the bubble, the outline following pinch and pan on the UI thread. */
function RiserPdf({ uri, page, riser, onError }: { uri: string; page: number; riser: RiserRef; onError: (e: unknown) => void }) {
  const pdfRef = useRef<PdfRef>(null);
  const focused = useRef(false);
  const matrix = useSharedValue<Affine | null>(null);
  const shownPage = useSharedValue(-1);
  const mark = useSharedValue<Rect | null>(null); // sheet coordinates of the outlined bubble
  const { attach, setFromJs } = useUiViewport(matrix, shownPage);

  const onViewport = useCallback(
    (vp: PdfViewport) => {
      attach(pdfNativeTag(pdfRef.current));
      setFromJs(sheetToView(vp));
      shownPage.value = vp.page;
      if (vp.page !== page) return; // both 1-based (T134); the viewer reports page 1 before it turns to ours
      const rotation = rotationOf(vp);
      const b = riser.bbox;
      const box = riser.kind === 'blob' ? displayRectToPage(vp, rotation, b) : sheetRectToPage(vp, b);
      if (riser.kind === 'blob') mark.value = pageRectToSheet(vp, box);
      if (focused.current) return;
      focused.current = true;
      const around = riser.kind === 'blob' ? grow(box, RISER_PAD, RISER_PAD) : grow(box, box.width * PAD, box.height * PAD);
      const f = nativeFocusRect(rotation, around);
      pdfRef.current?.focusRect(f.x, f.y, f.width, f.height, false);
    },
    [attach, setFromJs, shownPage, mark, riser, page],
  );

  const markStyle = useAnimatedStyle(() => {
    const m = matrix.value;
    const r = mark.value;
    if (!m || !r || shownPage.value !== page) return { opacity: 0 };
    const v = pageRectToView(m, r);
    return { opacity: 1, left: v.x - 3, top: v.y - 3, width: v.width + 6, height: v.height + 6 };
  });

  return (
    <View style={styles.pdfBox}>
      <Pdf
        ref={pdfRef}
        style={styles.pdf}
        source={{ uri, cache: true }}
        page={page}
        fitPolicy={2}
        minScale={1}
        maxScale={32}
        spacing={0}
        enableAnnotationRendering={false}
        enableTextSelection={false}
        onViewportChanged={onViewport}
        onError={onError}
      />
      <Animated.View pointerEvents="none" style={[styles.mark, markStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: space.sm, marginTop: space.sm, padding: 10, gap: 6, borderRadius: radius.card, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface },
  title: { ...font.calloutBold, color: color.text },
  muted: { ...font.caption, color: color.text3 },
  error: { ...font.caption, color: color.danger },
  gap: { gap: 6 },
  frame: { height: 220, borderRadius: radius.swatch, overflow: 'hidden', borderWidth: 1, borderColor: color.border },
  pdfBox: { flex: 1, overflow: 'hidden' },
  pdf: { flex: 1, backgroundColor: color.bg },
  // the bubble's outline over the riser page
  mark: { position: 'absolute', borderWidth: 2, borderColor: color.danger, borderRadius: 2 },
  modal: { flex: 1, backgroundColor: color.surface },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: color.hairline },
});
