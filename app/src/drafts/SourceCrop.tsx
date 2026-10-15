import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Identity } from '../identity/api';
import { authHeaders, batchFor, cropUrl, type Batch } from './api';
import type { DraftSource } from './model';

/**
 * The source crops of a draft (Phase 3 §3.3): one PNG per source — the BOM line, the riser symbol
 * or the wire bubble, outlined in red — rendered by the server from the stored PDF
 * (`GET /imports/{id}/crop`). Needs a connection; tap a crop for a larger one.
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
  const [failed, setFailed] = useState(false);
  const uri = cropUrl(identity.serverUrl, batch, source, { px: big ? 1600 : 800, pad: big ? (source.kind === 'riser' ? 260 : 60) : undefined });
  return (
    <View style={styles.crop}>
      <Text style={styles.label}>{source.label}</Text>
      {!uri ? (
        <Text style={styles.dim}>{batch ? 'No box recorded for this source.' : `The ${source.kind === 'bom' ? 'BOM' : 'riser'} file "${source.file ?? '?'}" is not on the server's import list.`}</Text>
      ) : failed ? (
        <Text style={styles.dim}>The crop could not be loaded.</Text>
      ) : (
        <Pressable onPress={() => setBig((b) => !b)}>
          <Image
            source={{ uri, headers: authHeaders(identity) }}
            style={big ? styles.big : styles.small}
            resizeMode="contain"
            onError={() => setFailed(true)}
            accessibilityLabel={`Source crop: ${source.label}`}
          />
          <Text style={styles.hint}>{big ? 'Tap for smaller' : 'Tap for larger, with more around it'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  crop: { gap: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#555' },
  small: { width: '100%', height: 170, backgroundColor: '#f3f5f8', borderRadius: 4 },
  big: { width: '100%', height: 420, backgroundColor: '#f3f5f8', borderRadius: 4 },
  hint: { fontSize: 11, color: '#888' },
  dim: { fontSize: 13, color: '#888' },
});
