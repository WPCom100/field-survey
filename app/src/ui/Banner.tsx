/**
 * Banner · Toast · Empty (the board): info / success / warning / danger banners with an optional
 * action, the dark pill toast, the empty state with one action.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Btn } from './Btn';
import { Icon, type IconName } from './icons';
import { color, font, hit, radius, shadow, space } from './tokens';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

export type BannerProps = {
  text: string;
  tone?: BannerTone;
  /** A text button at the right ("Retry"). */
  action?: { label: string; onPress: () => void; testID?: string };
  /** Replaces the tone's icon; `null` draws none. */
  icon?: IconName | null;
  /** On the message text, so a flow's `id` + `text` selector matches one element (the old `Notice`). */
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

const TONE: Record<BannerTone, { bg: string; fg: string; icon: IconName }> = {
  info: { bg: color.primaryTint, fg: color.primary, icon: 'info' },
  success: { bg: color.successTint, fg: color.success, icon: 'check' },
  warning: { bg: color.warningTint, fg: color.warning, icon: 'warning' },
  danger: { bg: color.dangerTint, fg: color.danger, icon: 'error' },
};

export function Banner({ text, tone = 'info', action, icon, testID, style }: BannerProps) {
  const t = TONE[tone];
  const iconName = icon === undefined ? t.icon : icon;
  return (
    <View style={[styles.banner, { backgroundColor: t.bg }, style]} accessibilityRole="alert">
      {iconName ? <Icon name={iconName} size={20} color={t.fg} strokeWidth={tone === 'success' ? 2.4 : 2} /> : null}
      <Text style={styles.bannerText} testID={testID}>
        {text}
      </Text>
      {action ? (
        <Pressable onPress={action.onPress} testID={action.testID} accessibilityRole="button" hitSlop={space.sm} style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
          <Text style={[styles.actionText, { color: t.fg }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export type ToastProps = {
  text: string;
  icon?: IconName | null;
  /** Absolute, bottom centre of its parent, 24 pt up. */
  floating?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/** The dark pill ("Saved"). The screen decides when it shows and for how long. */
export function Toast({ text, icon = 'check', floating, testID, style }: ToastProps) {
  return (
    <View style={[styles.toast, floating && styles.floating, style]} testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite">
      {icon ? <Icon name={icon} size={18} color={color.onPrimary} strokeWidth={2.4} /> : null}
      <Text style={styles.toastText}>{text}</Text>
    </View>
  );
}

export type EmptyProps = {
  text: string;
  icon?: IconName | null;
  /** The one thing to do from here, a secondary button. */
  action?: { label: string; onPress: () => void; testID?: string };
  children?: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function Empty({ text, icon = 'plusCircle', action, children, testID, style }: EmptyProps) {
  return (
    <View style={[styles.empty, style]} testID={testID}>
      {icon ? <Icon name={icon} size={32} color={color.muted} strokeWidth={1.6} /> : null}
      <Text style={styles.emptyText}>{text}</Text>
      {action ? <Btn title={action.label} onPress={action.onPress} testID={action.testID} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: hit.target,
    paddingHorizontal: 14,
    paddingVertical: space.sm,
    borderRadius: radius.control,
  },
  bannerText: { ...font.callout, color: color.text, flex: 1 },
  action: { paddingHorizontal: space.xs, justifyContent: 'center' },
  actionText: { ...font.calloutBold },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: hit.target,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    backgroundColor: color.text,
    alignSelf: 'center',
    ...shadow.toast,
  },
  floating: { position: 'absolute', bottom: space.xl, alignSelf: 'center' },
  toastText: { ...font.calloutBold, color: color.onPrimary },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg, paddingHorizontal: space.lg },
  emptyText: { ...font.callout, color: color.text2, textAlign: 'center' },
});
