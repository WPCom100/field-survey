import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useCropFile } from '../crops/useCropFile';
import { ZoomableImage } from '../crops/ZoomableImage';
import type { Identity } from '../identity/api';
import { authHeaders, batchFor, cropUrl, type Batch } from './api';
import type { DraftSource } from './model';

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
  const crop = useCropFile(url, authHeaders(identity));
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
  const crop = useCropFile(url, authHeaders(identity));
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.modal}>
        <View style={styles.bar}>
          <Text style={styles.barTitle} numberOfLines={1}>
            {source.label}
          </Text>
          <Text style={styles.hint}>Pinch to zoom · drag to pan · double-tap to zoom / fit</Text>
          <Pressable style={[styles.btn, styles.push]} onPress={onClose} accessibilityRole="button">
            <Text style={styles.btnText}>Close</Text>
          </Pressable>
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
      </GestureHandlerRootView>
    </Modal>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <View style={styles.failed}>
      <Text style={styles.error}>{message}</Text>
      <Pressable style={styles.btn} onPress={retry} accessibilityRole="button">
        <Text style={styles.btnText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  crop: { gap: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#555' },
  small: { width: '100%', height: 170, backgroundColor: '#f3f5f8', borderRadius: 4 },
  loading: { textAlign: 'center', textAlignVertical: 'center', lineHeight: 170, color: '#888', fontSize: 13 },
  hint: { fontSize: 11, color: '#888' },
  dim: { fontSize: 13, color: '#888' },
  error: { fontSize: 13, color: '#b71c1c' },
  failed: { gap: 6, padding: 8, borderRadius: 4, backgroundColor: '#fdf1f1' },
  modal: { flex: 1, backgroundColor: '#fff' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 24, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d6d9de' },
  barTitle: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: '#333' },
  pad: { padding: 16 },
  push: { marginLeft: 'auto' },
  btn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnText: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
});
