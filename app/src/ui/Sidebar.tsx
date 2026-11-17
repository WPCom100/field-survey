/**
 * The sidebar (T176, the "Levels · the shell" board): 240 pt, the project button (→ Projects, where
 * the project is switched, refreshed or created), the Survey and Project groups with icons and the
 * Needs review / Lint count pills, then Sync and the signed-in person at the bottom. The names are
 * PLAN §5's (D266 (1)); the test IDs are T149's `nav.<name>`. A tap resets the Stack to Levels → that
 * section (`useSectionTap`, D280, T188), never a push.
 */

import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './icons';
import { sectionEnabled, type NavName, type Section } from './navStack';
import { useSectionTap } from './useNav';
import { color, font, hit, radius, space, tabular } from './tokens';

export type { NavName };

type Entry = { name: NavName; icon: IconName; count?: 'review' | 'lint' };

/** The two groups, in the board's order. */
export const NAV_GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Survey',
    entries: [
      { name: 'Levels', icon: 'levels' },
      { name: 'Needs review', icon: 'review', count: 'review' },
      { name: 'Cable / riser', icon: 'cable' },
      { name: 'Dashboard', icon: 'dashboard' },
    ],
  },
  {
    title: 'Project',
    entries: [
      { name: 'Rulings', icon: 'rulings' },
      { name: 'Lint', icon: 'lint', count: 'lint' },
      { name: 'Export', icon: 'export' },
      { name: 'Setup', icon: 'setup' },
      { name: 'Vocabulary', icon: 'vocabulary' },
      { name: 'Library', icon: 'library' },
    ],
  },
];

/** Sidebar test IDs for the Maestro flows (T149): `nav.levels`, `nav.cable-riser`, `nav.needs-review`, … `nav.sync`. */
export const navId = (name: string) => `nav.${name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}`;

export type SidebarProps = {
  /** The screen the sidebar sits on (drawn active, takes no tap). */
  active?: NavName;
  /** The section the screen belongs to (the plan is under Levels): drawn active, still opens it (T177). */
  section?: NavName;
  /** Called before an entry navigates (the plan closes its sidebar overlay, T177). */
  onNavigate?: () => void;
  /** The project the entries open; none = they are drawn dim and take no tap. */
  projectId: string | null;
  projectName: string | null;
  counts?: { review?: number; lint?: number };
  /** The signed-in person: the name, the line under it (this iPad), and the row's spoken label. */
  user: { name: string; sub: string; label: string };
  /** Under the groups, above Sync (the demo links in development builds). */
  extra?: ReactNode;
};

export function Sidebar({ active, section, onNavigate, projectId, projectName, counts, user, extra }: SidebarProps) {
  const tap = useSectionTap(projectId);
  const go = (section: Section) => {
    onNavigate?.();
    tap(section);
  };
  return (
    <View style={styles.root}>
      <Pressable onPress={() => go('Projects')} style={({ pressed }) => [styles.project, pressed && styles.pressed]} testID="nav.projects" accessibilityRole="button" accessibilityHint="Switch, refresh or create a project">
        <View style={styles.projectText}>
          <Text style={styles.projectName} numberOfLines={1}>
            {projectName ?? 'No project'}
          </Text>
          <Text style={styles.projectCaption}>Projects</Text>
        </View>
        <Icon name="chevronRight" size={18} color={color.text2} />
      </Pressable>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {NAV_GROUPS.map((g) => (
          <View key={g.title}>
            <Text style={styles.group} accessibilityRole="header">
              {g.title}
            </Text>
            {g.entries.map((e) => (
              <NavItem
                key={e.name}
                name={e.name}
                icon={e.icon}
                enabled={sectionEnabled(e.name, projectId)}
                active={e.name === active}
                current={e.name === section}
                onGo={go}
                count={e.count ? counts?.[e.count] : undefined}
              />
            ))}
          </View>
        ))}
        {extra}
      </ScrollView>

      <View style={styles.bottom}>
        <NavItem name="Sync" icon="sync" enabled active={active === 'Sync'} onGo={go} />
        <Pressable onPress={() => go('Sync')} style={({ pressed }) => [styles.item, styles.user, pressed && styles.pressed]} testID="nav.user" accessibilityRole="button" accessibilityLabel={user.label}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{user.name.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.userText}>
            <Text style={styles.userName} numberOfLines={1}>
              {user.name}
            </Text>
            <Text style={styles.userSub} numberOfLines={2}>
              {user.sub}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function NavItem({ name, icon, enabled, active, current, onGo, count }: { name: NavName; icon: IconName; enabled: boolean; active: boolean; current?: boolean; onGo: (section: Section) => void; count?: number }) {
  const lit = active || !!current;
  const fg = lit ? color.primary : enabled ? color.text : color.text3;
  const body = (
    <>
      <Icon name={icon} size={20} color={fg} strokeWidth={1.8} />
      <Text style={[styles.itemText, { color: fg }, lit && styles.itemTextActive]} numberOfLines={1}>
        {name}
      </Text>
      {count ? (
        <View style={styles.pill}>
          <Text style={styles.pillText}>{count}</Text>
        </View>
      ) : null}
    </>
  );
  if (active || !enabled) {
    return (
      <View style={[styles.item, active && styles.itemActive]} testID={navId(name)} accessibilityState={{ selected: active, disabled: !enabled }}>
        {body}
      </View>
    );
  }
  return (
    <Pressable onPress={() => onGo(name)} style={({ pressed }) => [styles.item, current && styles.itemActive, pressed && styles.pressed]} testID={navId(name)} accessibilityRole="link">
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { width: 240, backgroundColor: color.surface2, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.hairline, padding: space.md },
  project: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  projectText: { flex: 1, minWidth: 0 },
  projectName: { ...font.headline, color: color.text },
  projectCaption: { ...font.micro, fontWeight: '400', color: color.text3 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: space.sm },
  group: { ...font.caption, color: color.text3, paddingTop: space.lg, paddingBottom: space.xs, paddingHorizontal: space.md },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: hit.target, paddingHorizontal: space.md, borderRadius: radius.control },
  itemActive: { backgroundColor: color.primaryTint },
  pressed: { backgroundColor: color.hairline },
  itemText: { ...font.callout, color: color.text, flex: 1 },
  itemTextActive: { fontWeight: '600' },
  pill: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { ...font.caption, ...tabular, color: color.text2 },
  bottom: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline, paddingTop: space.sm, marginTop: space.sm },
  user: { paddingVertical: space.xs },
  avatar: { width: 24, height: 24, borderRadius: radius.pill, backgroundColor: color.border, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...font.captionBold, color: color.text },
  userText: { flex: 1, minWidth: 0 },
  userName: { ...font.callout, color: color.text },
  userSub: { ...font.caption, color: color.text3 },
});
