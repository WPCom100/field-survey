/**
 * A row of photo thumbnails (T20 card, T65 end editor): number, ✎ markup, ↑ waiting. A photo
 * shared by several records shows on each of them; its links are seen and changed in the caption
 * sheet's Linked picker, not listed under the thumbnail (D134).
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
});
