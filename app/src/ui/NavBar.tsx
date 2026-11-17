/**
 * The bar at the top of every route (D280, `docs/nav-plan.md` §2.1, T188):
 *
 *   [ ‹ Dashboard ] | Title · caption                       [ the screen's own controls … ]
 *
 * The back slot is the first thing in the bar, top left: one chevron and the name of the screen
 * it returns to, a 44-pt target (`BackButton`); a section opened from the sidebar or the rail has
 * none (`useBack`). A way out is never among the controls at the right. The metrics are the plan
 * toolbar's (T177), which takes the same `BackButton`.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from './icons';
import { color, font, hit, radius, space, tabular } from './tokens';
import type { Back } from './useNav';

/** The bar's height (the plan toolbar's, T177). */
export const NAV_BAR_H = 56;

export type BackButtonProps = {
  /** The screen it returns to, as the sidebar spells it (`backFor`). */
  label: string;
  onPress: () => void;
  /** `<screen>.back` (`plan.back` on the plan). */
  testID: string;
};

/** Chevron + the destination's name, top left of a bar or panel. */
export function BackButton({ label, onPress, testID }: BackButtonProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.back, pressed && styles.pressed]} hitSlop={4} testID={testID} accessibilityRole="button">
      <Icon name="chevronLeft" size={22} color={color.primary} strokeWidth={2.2} />
      <Text style={styles.backText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export type NavBarProps = {
  /** From `useBack()`: none on a section opened from the sidebar or the rail. */
  back: Back | null;
  /** The back button's ID, `<screen>.back`. */
  backTestID: string;
  title: string;
  /** The line under the title. */
  caption?: string | null;
  titleTestID?: string;
  /** The screen's own controls, at the right (never a way out). */
  children?: ReactNode;
};

export function NavBar({ back, backTestID, title, caption, titleTestID, children }: NavBarProps) {
  return (
    <View style={styles.bar}>
      {back ? (
        <>
          <BackButton label={back.label} onPress={back.onPress} testID={backTestID} />
          <View style={styles.rule} />
        </>
      ) : null}
      <View style={[styles.titleBox, !back && styles.titleAlone]}>
        <Text style={styles.title} numberOfLines={1} testID={titleTestID} accessibilityRole="header">
          {title}
        </Text>
        {caption ? (
          <Text style={styles.caption} numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
      </View>
      <View style={styles.spacer} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: NAV_BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.md,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, height: hit.target, paddingLeft: space.xs, paddingRight: space.sm, borderRadius: radius.control, flexShrink: 0, maxWidth: 160 },
  backText: { ...font.body, color: color.primary, flexShrink: 1 },
  pressed: { backgroundColor: color.surface2 },
  rule: { width: StyleSheet.hairlineWidth, height: 24, backgroundColor: color.hairline },
  titleBox: { flexShrink: 1, minWidth: 48, paddingRight: space.xs },
  titleAlone: { paddingLeft: space.md },
  title: { ...font.headline, ...tabular, color: color.text },
  caption: { ...font.caption, lineHeight: 16, color: color.text3 },
  spacer: { flex: 1 },
});
