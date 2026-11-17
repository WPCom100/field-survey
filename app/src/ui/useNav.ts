/**
 * The stack rule's two hooks (D280, T188) over `navStack.ts`: what a sidebar or rail tap does, and
 * the back button of the screen they are called in.
 */

import { router, useNavigation } from 'expo-router';
import { useCallback, useState } from 'react';

import { backFor, sectionTap, type NavState, type Section } from './navStack';

/** A sidebar or rail tap: reset the Stack to Levels → `section` (never a push). */
export function useSectionTap(projectId: string | null): (section: Section) => void {
  const navigation = useNavigation();
  return useCallback(
    (section: Section) => {
      const next = sectionTap(navigation.getState() as NavState | undefined, section, projectId);
      // the reset keeps the Levels home's key (not remounted); see `sectionTap`
      if (next) navigation.reset(next as Parameters<typeof navigation.reset>[0]);
    },
    [navigation, projectId],
  );
}

export type Back = { label: string; onPress: () => void };

/** History back; with nothing under the screen, the Levels home replaces it. */
export const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * This screen's back button, read once when it mounts (what is under a mounted screen never
 * changes: a section tap replaces the screen itself): `null` for a section opened from the sidebar
 * or the rail, else the label naming the screen under it and history back.
 */
export function useBack(): Back | null {
  const navigation = useNavigation();
  const [label] = useState(() => {
    const state = navigation.getState() as NavState | undefined;
    return backFor(state, state?.index ?? 0);
  });
  return label === null ? null : { label, onPress: goBack };
}
