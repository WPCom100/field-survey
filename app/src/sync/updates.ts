/**
 * Over-the-air JS updates (T84, D153): the text the Sync screen's Install section shows and the
 * log events written under the `update` category. Pure, no Expo imports, tested in Node; the
 * screen and `_layout.tsx` feed it what `expo-updates` / `useUpdates()` report.
 *
 * The EAS Update manifest carries no publish message (checked against a real manifest in T84),
 * so the message is baked into the bundle at publish time as `EXPO_PUBLIC_UPDATE_MESSAGE` (D157).
 */

/** What `expo-updates` says about the JS that is running now. */
export interface RunningInfo {
  /** `Updates.isEnabled`: false in a development build loading from Metro. */
  enabled: boolean;
  runtimeVersion: string | null;
  channel: string | null;
  isEmbeddedLaunch: boolean;
  updateId: string | null;
  createdAt: Date | null;
  /** `EXPO_PUBLIC_UPDATE_MESSAGE` as inlined into this bundle; empty for embedded builds. */
  message: string | null;
  isEmergencyLaunch?: boolean;
  emergencyLaunchReason?: string | null;
}

/** The parts of `useUpdates()` the check line depends on. */
export interface CheckState {
  isChecking: boolean;
  isDownloading: boolean;
  isUpdateAvailable: boolean;
  isUpdatePending: boolean;
  checkError?: Error | null;
  downloadError?: Error | null;
  lastCheckAt?: Date | null;
}

export const UPDATE_READY = 'Update ready — restarts next launch';
export const UP_TO_DATE = 'Up to date';

const short = (id: string | null | undefined, n = 8) => (id ? id.slice(0, n) : '—');

/** First line of an error, without the native module's prefix noise. */
export function plainError(e: Error | null | undefined): string {
  const msg = (e?.message ?? String(e ?? 'unknown error')).split('\n')[0]!.trim();
  return msg || 'unknown error';
}

export interface InstallLines {
  /** "runtime 9099e69e · channel production" */
  runtime: string;
  /** "embedded (the JS this build shipped with)" or "update 01a13303 · <date> · T84: …" */
  running: string;
}

export function describeRunning(r: RunningInfo, formatDate: (d: Date) => string = (d) => d.toLocaleString()): InstallLines {
  if (!r.enabled) {
    return {
      runtime: `runtime ${short(r.runtimeVersion)} · updates off in this build`,
      running: 'from the development server (Metro)',
    };
  }
  const runtime = `runtime ${short(r.runtimeVersion)} · channel ${r.channel || '—'}`;
  let running: string;
  if (r.isEmbeddedLaunch || !r.updateId) {
    running = 'embedded (the JS this build shipped with)';
  } else {
    const parts = [`update ${short(r.updateId)}`];
    if (r.createdAt) parts.push(formatDate(r.createdAt));
    if (r.message?.trim()) parts.push(r.message.trim());
    running = parts.join(' · ');
  }
  if (r.isEmergencyLaunch) running += ` · emergency launch: ${r.emergencyLaunchReason || 'the downloaded update failed to start'}`;
  return { runtime, running };
}

/** The line under **Check for update**; null before anything has been checked. */
export function describeCheck(s: CheckState): string | null {
  if (s.isChecking) return 'Checking for an update…';
  if (s.isDownloading) return 'Downloading the update…';
  if (s.isUpdatePending) return UPDATE_READY;
  if (s.downloadError) return `Could not download the update: ${plainError(s.downloadError)}`;
  if (s.checkError) return `Could not check for an update: ${plainError(s.checkError)}`;
  if (s.isUpdateAvailable) return 'Update available — downloading on the next check';
  if (s.lastCheckAt) return UP_TO_DATE;
  return null;
}

export interface UpdateLogEvent {
  level: 'info' | 'warn';
  event: string;
  data?: Record<string, unknown>;
}

/** The launch line `_layout.tsx` writes once. */
export function launchEvent(r: RunningInfo): UpdateLogEvent {
  const data: Record<string, unknown> = {
    runtime: r.runtimeVersion,
    channel: r.channel,
    enabled: r.enabled,
    embedded: r.isEmbeddedLaunch,
  };
  if (!r.isEmbeddedLaunch && r.updateId) {
    data.update = r.updateId;
    data.created = r.createdAt?.toISOString() ?? null;
    if (r.message) data.message = r.message;
  }
  if (r.isEmergencyLaunch) {
    data.emergency = r.emergencyLaunchReason ?? true;
    return { level: 'warn', event: 'launch', data };
  }
  return { level: 'info', event: 'launch', data };
}

/**
 * Log events for one `useUpdates()` change: every finished check (automatic at launch or the
 * button) and every download outcome. `prev` is the state from the previous render.
 */
export function checkEvents(prev: CheckState, next: CheckState): UpdateLogEvent[] {
  const out: UpdateLogEvent[] = [];
  const checked = next.lastCheckAt && next.lastCheckAt.getTime() !== prev.lastCheckAt?.getTime();
  if (checked) out.push({ level: 'info', event: 'check', data: { result: next.isUpdateAvailable ? 'available' : 'up_to_date' } });
  if (next.checkError && next.checkError !== prev.checkError) out.push({ level: 'warn', event: 'check', data: { result: 'error', error: plainError(next.checkError) } });
  if (next.isUpdatePending && !prev.isUpdatePending) out.push({ level: 'info', event: 'downloaded', data: { result: 'ready_next_launch' } });
  if (next.downloadError && next.downloadError !== prev.downloadError) out.push({ level: 'warn', event: 'download', data: { result: 'error', error: plainError(next.downloadError) } });
  return out;
}
