import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useCropFile } from '../crops/useCropFile';
import { ZoomableImage } from '../crops/ZoomableImage';
import type { Identity } from '../identity/api';
import { authHeaders, batchFor, cropUrl, type Batch } from './api';
import type { DraftSource } from './model';
import { PanelHeader, color, font, radius, space } from '../ui';

/**
 * The source crops of a draft (Phase 3 §3.3): one PNG per source — the BOM line, the riser symbol
 * or the wire bubble, outlined in red — rendered by the server from the stored PDF
 * (`GET /imports/{id}/crop`). Needs a connection the first time (a crop once loaded is cached);
 * a crop that does not load says why, with Try again (T129). Tap a crop for a full-screen one with
 * more around it that pinches, pans and double-taps to zoom.
 */
export function SourceCrops({ identity, batches, sources }: { identity: Identity; batches: Batch[] | null; sources: DraftSource[] }) {
  if (!sources.length) return <Text style={styles.dim}>No source on paper (typed in by hand).</Text>;
  if (batches === null) return <Text style={styles.dim}>Source crops need a connection to the server.</Text>;
  return (
    <View style={styles.list}>
      {sources.map((s, i) => (
        <Crop key={`${s.kind}${i}`} identity={identity} batch={batchFor(batches, s)} source={s} />
      ))}
    </View>
  );
}

function Crop({ identity, batch, source }: { identity: Identity; batch: Batch | null; source: DraftSource }) {
  const [big, setBig] = useState(false);
  const uri = cropUrl(identity.serverUrl, batch, source, { px: 800 });
  return (
    <View style={styles.crop}>
      <Text style={styles.label}>{source.label}</Text>
      {!uri ? (
        <Text style={styles.dim}>{batch ? 'No box recorded for this source.' : `The ${source.kind === 'bom' ? 'BOM' : 'riser'} file "${source.file ?? '?'}" is not on the server's import list.`}</Text>
      ) : (
        <CropImage identity={identity} url={uri} label={source.label} onPress={() => setBig(true)} />
      )}
      {big && uri ? <BigCrop identity={identity} batch={batch} source={source} onClose={() => setBig(false)} /> : null}
    </View>
  );
}

function CropImage({ identity, url, label, onPress }: { identity: Identity; url: string; label: string; onPress: () => void }) {
  const crop = useCropFile(url, () => authHeaders(identity));
  if (crop.state === 'failed') return <Failed message={crop.message} retry={crop.retry} />;
  if (crop.state === 'loading') return <Text style={[styles.small, styles.loading]}>Loading crop…</Text>;
  return (
    <Pressable onPress={onPress}>
      <Image source={{ uri: crop.uri }} style={styles.small} resizeMode="contain" accessibilityLabel={`Source crop: ${label}`} />
      <Text style={styles.hint}>Tap to enlarge, with more around it; pinch to zoom</Text>
    </Pressable>
  );
}

function BigCrop({ identity, batch, source, onClose }: { identity: Identity; batch: Batch | null; source: DraftSource; onClose: () => void }) {
  const url = cropUrl(identity.serverUrl, batch, source, { px: 2000, pad: source.kind === 'riser' ? 260 : 60 });
  const crop = useCropFile(url, () => authHeaders(identity));
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.modal}>
        {/* closes to nothing: × at the top right (D280 (5), T191; was a Close button) */}
        <View style={styles.bar}>
          <PanelHeader title={source.label} close={{ onPress: onClose, testID: 'crop.close' }}>
            <Text style={styles.hint}>Pinch to zoom · drag to pan · double-tap to zoom / fit</Text>
          </PanelHeader>
        </View>
        {crop.state === 'ok' ? (
          <ZoomableImage uri={crop.uri} accessibilityLabel={`Source crop: ${source.label}`} />
        ) : crop.state === 'failed' ? (
          <View style={styles.pad}>
            <Failed message={crop.message} retry={crop.retry} />
          </View>
        ) : (
          <Text style={[styles.pad, styles.dim]}>Loading crop…</Text>
        )}
      </View>
    </Modal>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <View style={styles.failed}>
      <Text style={styles.error}>{message}</Text>
      <Pressable style={styles.btn} onPress={retry} hitSlop={4} accessibilityRole="button">
        <Text style={styles.btnText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  crop: { gap: space.xs },
  label: { ...font.captionBold, color: color.text2 },
  small: { width: '100%', height: 170, backgroundColor: color.surface2, borderRadius: radius.swatch },
  loading: { textAlign: 'center', textAlignVertical: 'center', lineHeight: 170, color: color.text3, fontSize: 13 },
  hint: { ...font.caption, color: color.text3 },
  dim: { ...font.caption, color: color.text3 },
  error: { ...font.caption, color: color.danger },
  failed: { gap: 6, padding: space.sm, borderRadius: radius.swatch, backgroundColor: color.dangerTint },
  modal: { flex: 1, backgroundColor: color.surface },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: 10, borderBottomWidth: 1, borderColor: color.hairline },
  pad: { padding: space.lg },
  btn: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.control, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  btnText: { ...font.captionBold, color: color.primary },
});
