/** Chips (the board): filter · selected · vocabulary; 40 pt (32 small) with `hitSlop` to 44, pill. */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { color, font, hit, hitSlopTo, radius, space } from './tokens';

export type ChipProps = {
  label: string;
  onPress?: () => void;
  /** Tinted with the accent and bold: an active filter, the picked value. */
  selected?: boolean;
  /** 32 pt for dense rows (an inline picker's options). */
  small?: boolean;
  /** A node before the label (an `Icon`, a `Swatch`). */
  icon?: ReactNode;
  disabled?: boolean;
  /** `<screen>.<element>`: what a Maestro flow taps (T149). */
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function Chip({ label, onPress, selected, small, icon, disabled, testID, accessibilityLabel, style }: ChipProps) {
  const h = small ? 32 : hit.chip;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      hitSlop={hitSlopTo(h)}
      style={({ pressed }) => [
        styles.chip,
        { height: h },
        small && styles.small,
        selected && styles.selected,
        pressed && !disabled && (selected ? styles.selectedPressed : styles.pressed),
        disabled && styles.off,
        style,
      ]}
    >
      {icon ?? null}
      <Text style={[styles.text, small && styles.textSmall, selected && styles.textSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignSelf: 'flex-start',
  },
  small: { paddingHorizontal: 10 },
  selected: { backgroundColor: color.primaryTint, borderColor: color.primaryTint },
  pressed: { backgroundColor: color.surface2 },
  selectedPressed: { opacity: 0.8 },
  off: { opacity: 0.45 },
  text: { ...font.callout, color: color.text },
  textSmall: { ...font.caption },
  textSelected: { color: color.primary, fontWeight: '600' },
});
