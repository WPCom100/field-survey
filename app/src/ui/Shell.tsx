/**
 * The shell (D280, `docs/nav-plan.md` §2.2, T188): the sidebar on the Levels home, the 72-pt rail on
 * every other screen with its top button opening the full sidebar over the screen; the screen to
 * the right. A wrapper each route renders (not a route-group layout): the routes, their names
 * (which `backFor` reads) and their files stay where they are, and a section switch does not slide
 * the rail because a section on Levels appears with no transition (`transitionFor`, set in the root
 * layout's Stack).
 *
 * The children are the rest of the screen's root row: its main column, and anything it lays over
 * the whole screen (the plan's popovers, measured from the screen's left edge, rail included).
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { NavName } from './navStack';
import { Rail } from './Rail';
import { Sidebar } from './Sidebar';
import { color, shadow } from './tokens';

/** What the sidebar and the rail show: the open project, its count pills, the signed-in person. */
export type ShellNav = {
  projectId: string | null;
  projectName: string | null;
  counts: { review?: number; lint?: number };
  /** The name, the line under it (this iPad), and the row's spoken label. */
  user: { name: string; sub: string; label: string };
};

export type ShellProps = {
  /** The Levels home: the 240-pt sidebar, its own entry drawn active and taking no tap. */
  sidebar?: boolean;
  /** The section the screen belongs to (the plan is under Levels): drawn active. */
  section?: NavName;
  /** None: no sidebar or rail (the demo plan). */
  nav: ShellNav | null;
  /** Before the rail's top button opens the sidebar over the screen (the plan closes its popovers). */
  onMenu?: () => void;
  /** Under the sidebar's groups (the demo links in development builds). */
  extra?: ReactNode;
  children: ReactNode;
};

export function Shell({ sidebar, section, nav, onMenu, extra, children }: ShellProps) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.root}>
      {!nav ? null : sidebar ? (
        <Sidebar active={section} projectId={nav.projectId} projectName={nav.projectName} counts={nav.counts} user={nav.user} extra={extra} />
      ) : (
        <Rail
          section={section}
          projectId={nav.projectId}
          counts={nav.counts}
          user={nav.user}
          onMenu={() => {
            onMenu?.();
            setOpen(true);
          }}
        />
      )}
      {children}
      {/* the rail's top button: the full sidebar over the screen (docs/ui-plan.md §6) */}
      {open && nav && !sidebar ? (
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} testID="rail.scrim" accessibilityLabel="Close the sidebar" />
          <View style={styles.overlaySidebar}>
            <Sidebar section={section} projectId={nav.projectId} projectName={nav.projectName} counts={nav.counts} user={nav.user} extra={extra} onNavigate={() => setOpen(false)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: color.bg },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: `${color.text}40` },
  overlaySidebar: { position: 'absolute', top: 0, bottom: 0, left: 0, flexDirection: 'row', ...shadow.card },
});
