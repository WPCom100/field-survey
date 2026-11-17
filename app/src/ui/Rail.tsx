/**
 * The icon rail (T177, the "Plan · rail, card, status buttons" board): the plan screen's sidebar,
 * 72 pt wide so the sheet keeps its room. The top button opens the full 240-pt sidebar as an
 * overlay (`docs/ui-plan.md` §6); below it the sidebar's entries as 44-pt icons with their count
 * pills, Sync and the person at the bottom. Same entries, names and targets as `Sidebar`, and the
 * same stack rule: a tap resets to Levels → that section (`useSectionTap`, D280, T188; before it the
 * rail pushed, a second Levels included). Each icon's VoiceOver label is the entry's name; test
 * IDs `rail.<name>` (`rail.menu`, `rail.levels`, `rail.needs-review`, … `rail.sync`, `rail.user`), so they
 * never collide with the overlay's `nav.*`.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './icons';
import { sectionEnabled } from './navStack';
import { NAV_GROUPS, navId, type NavName } from './Sidebar';
import { color, font, hit, radius, space, tabular } from './tokens';
import { useSectionTap } from './useNav';

export const RAIL_WIDTH = 72;

/** `rail.levels`, `rail.cable-riser`, … — the sidebar's IDs under the rail's prefix. */
export const railId = (name: string) => navId(name).replace(/^nav\./, 'rail.');

export type RailProps = {
  /** The section the screen belongs to: drawn active, still opens it. */
  section?: NavName;
  projectId: string | null;
  counts?: { review?: number; lint?: number };
  /** The signed-in person: the initial in the avatar, and the row's spoken label. */
  user: { name: string; label: string };
  /** The top button: show the full sidebar over the screen. */
  onMenu: () => void;
};

export function Rail({ section, projectId, counts, user, onMenu }: RailProps) {
  const go = useSectionTap(projectId);
  return (
    <View style={styles.root}>
      <RailButton icon="sidePanel" label="Show section names" onPress={onMenu} testID="rail.menu" />
      <View style={styles.gap} />
      {NAV_GROUPS.map((g, gi) => (
        <View key={g.title} style={styles.group}>
          {gi > 0 ? <View style={styles.divider} /> : null}
          {g.entries.map((e) => {
            const n = e.count ? counts?.[e.count] : undefined;
            return (
              <RailButton
                key={e.name}
                icon={e.icon}
                label={n ? `${e.name}, ${n}` : e.name}
                count={n}
                active={e.name === section}
                onPress={sectionEnabled(e.name, projectId) ? () => go(e.name) : undefined}
                testID={railId(e.name)}
              />
            );
          })}
        </View>
      ))}
      <View style={styles.flex} />
      <RailButton icon="sync" label="Sync" onPress={() => go('Sync')} testID={railId('Sync')} />
      <Pressable onPress={() => go('Sync')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]} testID="rail.user" accessibilityRole="button" accessibilityLabel={user.label}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{user.name.slice(0, 1).toUpperCase()}</Text>
        </View>
      </Pressable>
    </View>
  );
}

function RailButton({ icon, label, onPress, count, active, testID }: { icon: IconName; label: string; onPress?: () => void; count?: number; active?: boolean; testID: string }) {
  const fg = active ? color.primary : onPress ? color.text2 : color.muted;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.btn, active && styles.active, pressed && !active && styles.pressed]}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} size={22} color={fg} strokeWidth={1.8} />
      {count ? (
        <View style={styles.pill} pointerEvents="none">
          <Text style={styles.pillText}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    width: RAIL_WIDTH,
    backgroundColor: color.surface2,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: color.hairline,
    alignItems: 'center',
    paddingVertical: space.md,
    gap: space.xs,
  },
  gap: { height: space.sm },
  group: { alignItems: 'center', gap: space.xs },
  divider: { width: 32, height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginVertical: space.sm },
  flex: { flex: 1 },
  btn: { width: hit.target, height: hit.target, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  active: { backgroundColor: color.primaryTint },
  pressed: { backgroundColor: color.hairline },
  pill: {
    position: 'absolute',
    top: 0,
    right: -2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { ...font.micro, ...tabular, color: color.text },
  avatar: { width: 28, height: 28, borderRadius: radius.pill, backgroundColor: color.border, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...font.captionBold, color: color.text },
});
