/** Small pieces shared by the side lists (T19) and the device card (T20). */

import { StyleSheet, Text, View } from 'react-native';

import type { Badges } from './lists';
import type { PinStyle } from './pins';

/** Status colour square with its glyph: colour is never the only signal (D64). */
export function Swatch({ fill, hollow, glyph }: PinStyle) {
  return (
    <View style={[styles.swatch, hollow ? { borderColor: fill, backgroundColor: '#fff' } : { backgroundColor: fill, borderColor: fill }]}>
      <Text style={[styles.swatchGlyph, { color: hollow ? fill : '#fff' }]}>{glyph}</Text>
    </View>
  );
}

/** The record badges of Phase 3 §2.3 that a list row or card header can carry. */
export function BadgeStrip({ b }: { b: Badges }) {
  return (
    <>
      {b.isNew ? <Text style={styles.badge}>NEW</Text> : null}
      {b.pending > 0 ? <Text style={styles.badgePlain}>↑{b.pending}</Text> : null}
      {b.inReview ? <Text style={[styles.badge, styles.badgeReview]}>IN REVIEW</Text> : null}
      {b.draft ? <Text style={[styles.badge, styles.badgeDraft]}>DRAFT</Text> : null}
      {b.deleted ? <Text style={[styles.badge, styles.badgeDeleted]}>DELETED</Text> : null}
    </>
  );
}

export const chipStyles = StyleSheet.create({
  badge: { fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: '#1565c0', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  badgeReview: { backgroundColor: '#e65100' },
  badgeDraft: { backgroundColor: '#6a1b9a' },
  badgeDeleted: { backgroundColor: '#b71c1c' },
  badgePlain: { fontSize: 11, color: '#555', borderWidth: 1, borderColor: '#c9ccd1', paddingHorizontal: 4, borderRadius: 3 },
  swatch: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatchGlyph: { fontSize: 10, fontWeight: '700' },
});
const styles = chipStyles;
