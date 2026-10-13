import { describe, expect, it } from 'vitest';

import { LOG_CATEGORIES } from '../log/format';
import { UPDATE_READY, UP_TO_DATE, checkEvents, describeCheck, describeRunning, launchEvent, plainError, type CheckState, type RunningInfo } from './updates';

const embedded: RunningInfo = {
  enabled: true,
  runtimeVersion: '9099e69eb64098fcd84a679da8c358001f39da71',
  channel: 'production',
  isEmbeddedLaunch: true,
  updateId: null,
  createdAt: null,
  message: null,
};
const fromUpdate: RunningInfo = {
  ...embedded,
  isEmbeddedLaunch: false,
  updateId: '01a13303-59ed-7916-86dd-8433fa642efa',
  createdAt: new Date('2026-10-13T02:07:00.077Z'),
  message: 'T84: Over-the-air JS updates',
};
const idle: CheckState = { isChecking: false, isDownloading: false, isUpdateAvailable: false, isUpdatePending: false };
const iso = (d: Date) => d.toISOString();

describe('describeRunning', () => {
  it('says embedded for the JS the build shipped with', () => {
    expect(describeRunning(embedded)).toEqual({
      runtime: 'runtime 9099e69e · channel production',
      running: 'embedded (the JS this build shipped with)',
    });
  });

  it('shows the short update id, date and message for a downloaded update', () => {
    expect(describeRunning(fromUpdate, iso).running).toBe('update 01a13303 · 2026-10-13T02:07:00.077Z · T84: Over-the-air JS updates');
  });

  it('leaves the message out when the publish did not set one', () => {
    expect(describeRunning({ ...fromUpdate, message: '  ' }, iso).running).toBe('update 01a13303 · 2026-10-13T02:07:00.077Z');
  });

  it('names Metro in a development build', () => {
    const r = describeRunning({ ...embedded, enabled: false, channel: null });
    expect(r.runtime).toBe('runtime 9099e69e · updates off in this build');
    expect(r.running).toBe('from the development server (Metro)');
  });

  it('flags an emergency launch', () => {
    expect(describeRunning({ ...embedded, isEmergencyLaunch: true, emergencyLaunchReason: 'crash' }).running).toMatch(/emergency launch: crash$/);
  });
});

describe('describeCheck', () => {
  it('is empty before any check', () => {
    expect(describeCheck(idle)).toBeNull();
  });
  it('reports progress', () => {
    expect(describeCheck({ ...idle, isChecking: true })).toBe('Checking for an update…');
    expect(describeCheck({ ...idle, isUpdateAvailable: true, isDownloading: true })).toBe('Downloading the update…');
  });
  it('says the update applies on the next launch, never restarts', () => {
    expect(describeCheck({ ...idle, isUpdateAvailable: true, isUpdatePending: true, lastCheckAt: new Date() })).toBe(UPDATE_READY);
    expect(UPDATE_READY).toBe('Update ready — restarts next launch');
  });
  it('says up to date after a check that found nothing', () => {
    expect(describeCheck({ ...idle, lastCheckAt: new Date() })).toBe(UP_TO_DATE);
  });
  it('gives a plain one-line error offline', () => {
    const e = new Error('The Internet connection appears to be offline.\n  at native stack');
    expect(describeCheck({ ...idle, checkError: e })).toBe('Could not check for an update: The Internet connection appears to be offline.');
    expect(describeCheck({ ...idle, isUpdateAvailable: true, downloadError: new Error('timed out') })).toBe('Could not download the update: timed out');
  });
  it('a pending update outranks a later failed check', () => {
    expect(describeCheck({ ...idle, isUpdatePending: true, checkError: new Error('offline') })).toBe(UPDATE_READY);
  });
});

describe('log events', () => {
  it('has an update category', () => {
    expect(LOG_CATEGORIES).toContain('update');
  });

  it('logs embedded vs update id and the runtime version at launch', () => {
    expect(launchEvent(embedded)).toEqual({
      level: 'info',
      event: 'launch',
      data: { runtime: embedded.runtimeVersion, channel: 'production', enabled: true, embedded: true },
    });
    expect(launchEvent(fromUpdate).data).toMatchObject({ embedded: false, update: fromUpdate.updateId, created: '2026-10-13T02:07:00.077Z', message: fromUpdate.message });
    expect(launchEvent({ ...embedded, isEmergencyLaunch: true, emergencyLaunchReason: 'x' }).level).toBe('warn');
  });

  it('logs every finished check, once', () => {
    const t1 = new Date('2026-10-13T10:00:00Z');
    const t2 = new Date('2026-10-13T11:00:00Z');
    expect(checkEvents(idle, { ...idle, lastCheckAt: t1 })).toEqual([{ level: 'info', event: 'check', data: { result: 'up_to_date' } }]);
    expect(checkEvents({ ...idle, lastCheckAt: t1 }, { ...idle, lastCheckAt: new Date(t1) })).toEqual([]);
    expect(checkEvents({ ...idle, lastCheckAt: t1 }, { ...idle, lastCheckAt: t2, isUpdateAvailable: true })[0]!.data).toEqual({ result: 'available' });
  });

  it('logs errors and the download', () => {
    const err = new Error('offline');
    expect(checkEvents(idle, { ...idle, checkError: err })).toEqual([{ level: 'warn', event: 'check', data: { result: 'error', error: 'offline' } }]);
    expect(checkEvents({ ...idle, checkError: err }, { ...idle, checkError: err })).toEqual([]);
    expect(checkEvents({ ...idle, isDownloading: true }, { ...idle, isUpdatePending: true })).toEqual([
      { level: 'info', event: 'downloaded', data: { result: 'ready_next_launch' } },
    ]);
    expect(checkEvents(idle, { ...idle, downloadError: new Error('x') })[0]!.event).toBe('download');
  });

  it('plainError copes with odd values', () => {
    expect(plainError(null)).toBe('unknown error');
    expect(plainError(new Error(''))).toBe('unknown error');
  });
});
