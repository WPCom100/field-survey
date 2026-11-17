/**
 * The way out of a panel inside a screen (D280 (5), `docs/nav-plan.md` §2.3, T188; the panels move
 * onto it in T191):
 *
 * - a panel that replaced another panel (the end editor over the card or the list, the item editor,
 *   the rulings preview over its form): `‹ <where it returns>` at its top left (`BackButton`);
 * - a panel or overlay that closes to nothing (the device card, the crops, the photo viewer): `×`
 *   at its top right.
 *
 * A form's Cancel is not here: it sits left of the primary button at the bottom right.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from './icons';
import { BackButton } from './NavBar';
import { color, font, hit, radius, space } from './tokens';

export type PanelHeaderProps = {
  /** The panel it returns to (`end.back`, `item.back`, `rulings.back`). */
  back?: { label: string; onPress: () => void; testID: string };
  title?: string | null;
  /** `×` at the top right: the panel closes to nothing (`card.close`, `riser.close`). */
  close?: { onPress: () => void; testID: string; label?: string };
  /** Controls left of `×` (the card's ⋯ menu). */
  children?: ReactNode;
};

export function PanelHeader({ back, title, close, children }: PanelHeaderProps) {
  return (
    <View style={styles.head}>
      {back ? <BackButton label={back.label} onPress={back.onPress} testID={back.testID} /> : null}
      <View style={styles.titleBox}>
        {title ? (
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
      </View>
      {children}
      {close ? (
        <Pressable onPress={close.onPress} testID={close.testID} accessibilityRole="button" accessibilityLabel={close.label ?? 'Close'} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Icon name="close" size={22} color={color.text2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: hit.target },
  titleBox: { flex: 1, minWidth: 0 },
  title: { ...font.headline, color: color.text },
  close: { width: hit.target, height: hit.target, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: color.hairline },
});
