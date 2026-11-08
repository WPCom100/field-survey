/** Buttons (the "Tokens and components" board): 44 pt, four kinds, small, loading, icon slot. */

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, font, hit, hitSlopTo, radius, space } from './tokens';

export type BtnKind = 'primary' | 'secondary' | 'tertiary' | 'destructive';

export type BtnProps = {
  title: string;
  onPress: () => void;
  /** `secondary` (bordered, white) unless said otherwise. */
  kind?: BtnKind;
  /** 36 pt with `hitSlop` to 44; 13-pt label. */
  small?: boolean;
  /** A spinner takes the icon slot and the button stops taking taps. */
  loading?: boolean;
  disabled?: boolean;
  /** An `Icon` (or any node) before the title. */
  icon?: ReactNode;
  /** `<screen>.<element>`: what a Maestro flow taps (T149). */
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

const FILL: Record<BtnKind, { bg: string; pressed: string; text: string; border?: string }> = {
  primary: { bg: color.primary, pressed: color.primaryPressed, text: color.onPrimary },
  secondary: { bg: color.surface, pressed: color.surface2, text: color.text, border: color.border },
  tertiary: { bg: 'transparent', pressed: color.primaryTint, text: color.primary },
  destructive: { bg: color.danger, pressed: color.danger, text: color.onPrimary },
};

export function Btn({ title, onPress, kind = 'secondary', small, loading, disabled, icon, testID, accessibilityLabel, style }: BtnProps) {
  const f = FILL[kind];
  const off = disabled || loading;
  const filled = kind === 'primary' || kind === 'destructive';
  const textColor = off && filled ? color.text3 : f.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      hitSlop={small ? hitSlopTo(hit.small) : 0}
      style={({ pressed }) => [
        styles.btn,
        small && styles.small,
        { backgroundColor: pressed && !off ? f.pressed : f.bg },
        f.border ? { borderWidth: 1, borderColor: f.border } : null,
        off && (filled ? styles.offFilled : styles.offPlain),
        pressed && kind === 'destructive' && !off && styles.destructivePressed,
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={textColor} /> : icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={[styles.text, small && styles.textSmall, { color: textColor }]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: hit.target,
    paddingHorizontal: 18,
    borderRadius: radius.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
  },
  small: { height: hit.small, paddingHorizontal: space.md },
  text: { ...font.calloutBold },
  textSmall: { fontSize: 13, lineHeight: 18 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  offFilled: { backgroundColor: color.border },
  offPlain: { opacity: 0.45 },
  destructivePressed: { opacity: 0.85 },
});
