/**
 * Small pieces shared by the side lists (T19) and the device card (T20). Since T174 (D266) they
 * are the UI system's `Swatch` and `Badge` (`app/src/ui`) under their old names and props; the
 * screens move to the primitives in their own tasks (T175, T177).
 */

import { StyleSheet } from 'react-native';

import { BADGE, Badge, pendingBadge } from '../ui/Badge';
import { Swatch as UiSwatch } from '../ui/Swatch';
import { color, font, radius, tabular } from '../ui/tokens';
import type { Badges } from './lists';
import type { PinStyle } from './pins';

/** Status colour square with its glyph: colour is never the only signal (D64). */
export function Swatch({ fill, hollow, glyph }: PinStyle) {
  return <UiSwatch fill={fill} hollow={hollow} glyph={glyph} />;
}

/** The record badges of Phase 3 §2.3 that a list row or card header can carry. */
export function BadgeStrip({ b }: { b: Badges }) {
  return (
    <>
      {b.isNew ? <Badge {...BADGE.new} /> : null}
      {b.pending > 0 ? <Badge {...pendingBadge(b.pending)} /> : null}
      {b.inReview ? <Badge {...BADGE.inReview} /> : null}
      {b.draft ? <Badge {...BADGE.draft} /> : null}
      {b.deleted ? <Badge {...BADGE.deleted} /> : null}
    </>
  );
}

/**
 * Text styles the card, the editors and the plan still compose themselves (`chipStyles.badge` +
 * `badgeDraft`, `badgePlain`): the system's badge values on a bare `Text`.
 */
export const chipStyles = StyleSheet.create({
  badge: { ...font.badge, color: color.primary, backgroundColor: color.primaryTint, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.badge, overflow: 'hidden' },
  badgeReview: { backgroundColor: color.warningTint, color: color.warning },
  badgeDraft: { backgroundColor: 'transparent', color: color.text2, borderWidth: 1.5, borderColor: color.muted },
  badgeDeleted: { backgroundColor: color.dangerTint, color: color.danger },
  badgePlain: { ...font.badge, ...tabular, color: color.text2, backgroundColor: color.surface2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.badge, overflow: 'hidden' },
  swatch: { width: 22, height: 22, borderRadius: radius.swatch, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  swatchGlyph: { fontSize: 10, fontWeight: '700' },
});
