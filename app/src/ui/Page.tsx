/**
 * The shell's page pattern for a screen without a board (`docs/ui-plan.md` §4, T179): the title
 * (display) with a caption under it and the actions at the right; filters as chip rows under it,
 * each group named by a caption label.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, font, space } from './tokens';

export type PageHeaderProps = {
  /** The screen's name, with its counts where the screen shows them (`Lint (3 open · 0 dismissed)`). */
  title: string;
  caption?: string | null;
  /** Buttons at the right, the one primary action last (the section screens use `NavBar` since T189, D282). */
  actions?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function PageHeader({ title, caption, actions, style }: PageHeaderProps) {
  return (
    <View style={[styles.header, style]}>
      <View style={styles.text}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

/** A row of filter groups: `FilterLabel` + chips, wrapping. */
export function FilterRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.filters, style]}>{children}</View>;
}

/** A filter group's name; `gap` puts space before every group but the first. */
export function FilterLabel({ text, gap }: { text: string; gap?: boolean }) {
  return <Text style={[styles.filterLabel, gap && styles.filterGap]}>{text}</Text>;
}

/** The page's side padding, so a screen's body lines up with its header. */
export const PAGE_GUTTER = space.xl;

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.lg,
    paddingHorizontal: PAGE_GUTTER,
    paddingTop: space.lg,
  },
  text: { flex: 1, minWidth: 280, gap: 2 },
  title: { ...font.display, color: color.text },
  caption: { ...font.caption, color: color.text3 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  filters: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: PAGE_GUTTER, paddingTop: space.md },
  filterLabel: { ...font.captionBold, color: color.text2 },
  filterGap: { marginLeft: space.md },
});
