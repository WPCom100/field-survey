/**
 * A screen on the shell (D280, `docs/nav-plan.md` §2, T189, T190): the rail at the left (its top
 * button opens the full sidebar over the screen), then the screen's column: the `NavBar` (back top
 * left only when the screen was opened from another screen, named after it; the title and the
 * screen's own controls), the screen's one-line description under it, and the screen.
 *
 * The sections (Needs review, Lint, Rulings, Dashboard, Cable / riser, Export, Vocabulary, the
 * project's Library, Sync, Setup) render it with their project; the app-level screens (Projects,
 * New project, Rule defaults, the app library and its Needs review, T190) with no section and no
 * project of their own, so the rail serves the project the Levels home last showed, its entries
 * dim while there is none. The rail's count pills and the person's row load here (`useShell`).
 */

import type { Store } from '@field-survey/core';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { openAppStore } from '../db';
import { useCurrentUser } from '../identity/IdentityGate';
import { projectDataKey, syncDataKey } from '../sync/dataKey';
import { useSyncStatus } from '../sync/useSyncStatus';
import { NavBar, PAGE_GUTTER, Shell, color, font, space, useBack, type NavName } from '../ui';
import { pickProject } from './currentProject';
import { listProjects } from './data';
import { useShell } from './useShell';

export type SectionScreenProps = {
  /** The sidebar entry drawn active; none on the app-level screens. */
  section?: NavName;
  /**
   * The project the screen shows (the rail's pills, its entries' `?project=`); null: none open.
   * Left out (the app-level screens): the project the Levels home last showed, if any.
   */
  projectId?: string | null;
  title: string;
  /** The short line under the title in the bar (the Dashboard's "as of sync …", Export's project). */
  caption?: string | null;
  titleTestID?: string;
  /** `<screen>.back`: the bar's back button, shown when the screen was opened from another screen. */
  backTestID: string;
  /** The screen's own controls at the bar's right (never a way out). */
  actions?: ReactNode;
  /** What the screen is for, one line under the bar (the page header's caption before T189). */
  intro?: string | null;
  children: ReactNode;
};

export function SectionScreen({ section, projectId, title, caption, titleTestID, backTestID, actions, intro, children }: SectionScreenProps) {
  const user = useCurrentUser();
  const sync = useSyncStatus();
  const [store, setStore] = useState<Store | null>(null);
  useEffect(() => {
    openAppStore().then(setStore, (e: unknown) => console.warn('[shell] store', e));
  }, []);
  const remembered = useRememberedProject(projectId === undefined ? store : null, syncDataKey(sync));
  const shown = projectId === undefined ? remembered : projectId;
  const shell = useShell(store, shown, user, projectDataKey(sync, shown));
  const back = useBack();
  return (
    <Shell section={section} nav={{ projectId: shown, ...shell }}>
      <View style={styles.column}>
        <NavBar back={back} backTestID={backTestID} title={title} caption={caption} titleTestID={titleTestID}>
          {actions}
        </NavBar>
        {intro ? <Text style={styles.intro}>{intro}</Text> : null}
        {children}
      </View>
    </Shell>
  );
}

/** The project the Levels home last showed (else the first on the iPad, else none); `store` null: not asked. */
function useRememberedProject(store: Store | null, reloadKey: string): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!store) return;
    let live = true;
    listProjects(store).then(
      (list) => {
        if (live) setId(pickProject(list.map((p) => p.id)));
      },
      (e: unknown) => console.warn('[shell] projects', e),
    );
    return () => {
      live = false;
    };
  }, [store, reloadKey]);
  return id;
}

const styles = StyleSheet.create({
  column: { flex: 1, backgroundColor: color.bg },
  intro: { ...font.caption, color: color.text3, paddingHorizontal: PAGE_GUTTER, paddingTop: space.md },
});
