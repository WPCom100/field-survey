/**
 * A row of photo thumbnails (T20 card, T65 end editor): number, ✎ markup, ↑ waiting, and the
 * photo's other links ("🔗 06M-05 · C-07", D128) so a photo shared by several records says so.
 */

import { Image, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import type { CardPhoto } from '../card/model';

export function PhotoStrip(props: {
  photos: readonly CardPhoto[];
  resolveBlobUri: (sha: string, kind: 'thumb' | 'image') => string | null;
  onOpen?: (photoId: string) => void;
}) {
  if (!props.photos.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photos}>
      {props.photos.map((p) => {
        const uri = p.thumb ? props.resolveBlobUri(p.thumb, 'thumb') : null;
        return (
          <Pressable key={p.id} style={styles.photo} onPress={() => props.onOpen?.(p.id)} disabled={!props.onOpen}>
            {uri ? <Image source={{ uri }} style={styles.photoImg} /> : <Text style={styles.photoNum}>📷</Text>}
            <Text style={styles.photoLabel} numberOfLines={1}>
              {p.label}
              {p.markup ? ' ✎' : ''}
              {p.waiting ? ' ↑' : ''}
            </Text>
            {p.links.length ? (
              <Text style={styles.photoLinks} numberOfLines={2}>
                🔗 {p.links.join(' · ')}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  photos: { gap: 6 },
  photo: { width: 72, alignItems: 'center' },
  photoImg: { width: 64, height: 64, borderRadius: 4, backgroundColor: '#ddd' },
  photoNum: { width: 64, height: 64, borderRadius: 4, backgroundColor: '#e3e5e8', textAlign: 'center', lineHeight: 64, fontSize: 20 },
  photoLabel: { fontSize: 11, color: '#555' },
  photoLinks: { fontSize: 10, color: '#1565c0', textAlign: 'center' },
});
