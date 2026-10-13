import * as Updates from 'expo-updates';
import { useEffect, useRef } from 'react';

import { logTo } from '../log';
import { checkEvents, launchEvent, type CheckState, type RunningInfo } from './updates';

/**
 * expo-updates glue (T84, D153). The app starts on the bundle it has; `checkAutomatically:
 * ON_LOAD` fetches in the background and a downloaded update applies on the next cold launch.
 * Nothing here ever calls `reloadAsync`.
 */
export function runningInfo(): RunningInfo {
  return {
    enabled: Updates.isEnabled,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    updateId: Updates.updateId,
    createdAt: Updates.createdAt,
    // Inlined by Metro at publish time (D157); unset in the embedded bundle.
    message: process.env.EXPO_PUBLIC_UPDATE_MESSAGE ?? null,
    isEmergencyLaunch: Updates.isEmergencyLaunch,
    emergencyLaunchReason: Updates.emergencyLaunchReason,
  };
}

export function useUpdateCheckState(): CheckState {
  const u = Updates.useUpdates();
  return {
    isChecking: u.isChecking,
    isDownloading: u.isDownloading,
    isUpdateAvailable: u.isUpdateAvailable,
    isUpdatePending: u.isUpdatePending,
    checkError: u.checkError ?? null,
    downloadError: u.downloadError ?? null,
    lastCheckAt: u.lastCheckForUpdateTimeSinceRestart ?? null,
  };
}

/** The Sync screen's **Check for update**: check, and download when there is one. */
export async function checkAndFetch(): Promise<void> {
  if (!Updates.isEnabled) return;
  try {
    const r = await Updates.checkForUpdateAsync();
    if (r.isAvailable) await Updates.fetchUpdateAsync();
  } catch {
    // The error is in useUpdates() (checkError / downloadError) and shown and logged from there.
  }
}

/** Mounted once in `_layout.tsx`: the launch line, then every check and download result. */
export function useUpdateLog(): void {
  const state = useUpdateCheckState();
  const prev = useRef<CheckState | null>(null);
  useEffect(() => {
    const e = launchEvent(runningInfo());
    logTo('update', e.level, e.event, e.data);
  }, []);
  useEffect(() => {
    const before = prev.current ?? { isChecking: false, isDownloading: false, isUpdateAvailable: false, isUpdatePending: false };
    for (const e of checkEvents(before, state)) logTo('update', e.level, e.event, e.data);
    prev.current = state;
  });
}
