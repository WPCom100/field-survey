/**
 * Record badges (Phase 3 §2.3, the board): the words the flows assert — NEW · ↑n · IN REVIEW ·
 * DRAFT · DELETED · ⚑ R3a · 📷 n waiting — tinted, 22 pt, radius 6; `↑n` and `📷 n` tabular.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, font, radius, tabular } from './tokens';

export type BadgeTone = 'primary' | 'neutral' | 'warning' | 'danger' | 'success' | 'draft';

export type BadgeProps = {
  text: string;
  tone?: BadgeTone;
  /** Tabular numerals (`↑3`, `📷 2 waiting`). */
  tabular?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

const TONE: Record<BadgeTone, { bg: string; text: string; dashed?: boolean }> = {
  primary: { bg: color.primaryTint, text: color.primary },
  neutral: { bg: color.surface2, text: color.text2 },
  warning: { bg: color.warningTint, text: color.warning },
  danger: { bg: color.dangerTint, text: color.danger },
  success: { bg: color.successTint, text: color.success },
  draft: { bg: 'transparent', text: color.text2, dashed: true },
};

export function Badge({ text, tone = 'neutral', tabular: tab, testID, style }: BadgeProps) {
  const t = TONE[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }, t.dashed && styles.dashed, style]} testID={testID} accessible accessibilityLabel={text}>
      <Text style={[styles.text, { color: t.text }, tab && tabular]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** The fixed-word badges, so a screen never respells one. */
export const BADGE = {
  new: { text: 'NEW', tone: 'primary' },
  inReview: { text: 'IN REVIEW', tone: 'warning' },
  draft: { text: 'DRAFT', tone: 'draft' },
  deleted: { text: 'DELETED', tone: 'danger' },
} as const satisfies Record<string, Pick<BadgeProps, 'text' | 'tone'>>;

/** `↑n`: edits of this record waiting in the outbox. */
export function pendingBadge(n: number): BadgeProps {
  return { text: `↑${n}`, tone: 'neutral', tabular: true };
}

/** `⚑ R3a`: the rule a proposal cites. */
export function ruleBadge(rule: string): BadgeProps {
  return { text: `⚑ ${rule}`, tone: 'neutral' };
}

/** `📷 n waiting`: photos of this record not yet uploaded. */
export function photosBadge(n: number): BadgeProps {
  return { text: `📷 ${n} waiting`, tone: 'neutral', tabular: true };
}

const styles = StyleSheet.create({
  badge: {
    height: 22,
    paddingHorizontal: 8,
    borderRadius: radius.badge,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  dashed: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.muted },
  text: { ...font.badge },
});
