/**
 * Card · Row · Section (the board): a 12-pt card on `surface`, 48/52-pt rows with hairlines, a
 * collapsible section with a count. The section is controlled (`open` + `onToggle`) when the
 * screen remembers its state (the device card, D266 §6), uncontrolled otherwise.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from './icons';
import { color, font, hit, radius, shadow, space, tabular } from './tokens';

export type CardProps = {
  children: ReactNode;
  /** No padding: the card holds rows edge to edge. */
  flush?: boolean;
  /** The popover / dialog shadow. */
  raised?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Card({ children, flush, raised, style, testID }: CardProps) {
  return (
    <View style={[styles.card, flush && styles.flush, raised && styles.raised, style]} testID={testID}>
      {children}
    </View>
  );
}

export type RowProps = {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** The accent tint: the row whose card or editor is open. */
  selected?: boolean;
  /** No hairline above (the first row of a card). */
  first?: boolean;
  /** 48 for a one-line row, 52 (default) for a title with a sub-line. */
  minHeight?: 48 | 52 | number;
  /** A muted chevron at the right end; on by default for a tappable row. */
  chevron?: boolean;
  /** `<screen>.<element>`: what a Maestro flow taps; a Pressable row is one element whose text is all its children's. */
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function Row({ children, onPress, onLongPress, selected, first, minHeight = 52, chevron, testID, accessibilityLabel, style }: RowProps) {
  const showChevron = chevron ?? !!onPress;
  const inner = (
    <>
      {children}
      {showChevron ? <Icon name="chevronRight" size={20} color={color.muted} /> : null}
    </>
  );
  const base = [styles.row, { minHeight }, !first && styles.hairline, selected && styles.selected, style];
  if (!onPress && !onLongPress) {
    return (
      <View style={base} testID={testID}>
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [...base, pressed && !selected && styles.pressed]}
    >
      {inner}
    </Pressable>
  );
}

/** A row's two-line middle: title (headline) over a caption; takes the free width. */
export function RowText({ title, sub, muted, style }: { title: string; sub?: string | null; muted?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.rowText, style]}>
      <Text style={[styles.rowTitle, muted && { color: color.text3 }]} numberOfLines={1}>
        {title}
      </Text>
      {sub ? (
        <Text style={styles.rowSub} numberOfLines={2}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

export type SectionProps = {
  title: string;
  /** Shown after the title in the caption colour: a number (`Connections 4`) or a summary (`3 · 1 draft`). */
  count?: number | string | null;
  children: ReactNode;
  /** Controlled open state; with `onToggle` the header toggles it. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** Uncontrolled start state (open unless said otherwise). */
  defaultOpen?: boolean;
  /** Always open, no chevron (Status, Notes, the address rows on the card). */
  fixed?: boolean;
  /** A node at the right of the header (an Add button, a badge). */
  right?: ReactNode;
  /** `<screen>.<element>` on the header; the body is `<testID>.body`. */
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function Section({ title, count, children, open, onToggle, defaultOpen = true, fixed, right, testID, style }: SectionProps) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = fixed ? true : open ?? own;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setOwn(next);
    onToggle?.(next);
  };
  // The header's label is its title and count as one string (`Punch items 3 · 1 draft`): what
  // VoiceOver reads and what a Maestro flow copies or matches. No `accessibilityState` here — iOS
  // reports a state as the element's value, and Maestro takes a value as the element's text.
  const label = count != null ? `${title} ${count}` : title;
  const header = (
    <>
      {fixed ? null : <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={20} color={color.muted} />}
      <Text style={styles.sectionTitle} numberOfLines={1}>
        {title}
      </Text>
      {count != null ? <Text style={styles.sectionCount}>{count}</Text> : null}
      <View style={styles.sectionSpacer} />
      {right ?? null}
    </>
  );
  return (
    <View style={style}>
      {fixed ? (
        <View style={styles.sectionHead} testID={testID} accessibilityLabel={label}>
          {header}
        </View>
      ) : (
        <Pressable
          onPress={toggle}
          style={({ pressed }) => [styles.sectionHead, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={isOpen ? 'Folds the section' : 'Opens the section'}
          testID={testID}
        >
          {header}
        </Pressable>
      )}
      {isOpen ? <View testID={testID && `${testID}.body`}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingVertical: space.lg,
    paddingHorizontal: 20,
    gap: space.md,
  },
  flush: { paddingVertical: 0, paddingHorizontal: 0, gap: 0, overflow: 'hidden' },
  raised: { ...shadow.card, borderColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  hairline: { borderTopWidth: 1, borderTopColor: color.hairline },
  selected: { backgroundColor: color.primaryTint },
  pressed: { backgroundColor: color.surface2 },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { ...font.headline, color: color.text },
  rowSub: { ...font.caption, color: color.text3 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: hit.target, paddingHorizontal: space.lg },
  sectionTitle: { ...font.headline, color: color.text, flexShrink: 1 },
  sectionCount: { ...font.callout, ...tabular, color: color.text3 },
  sectionSpacer: { flex: 1 },
});
