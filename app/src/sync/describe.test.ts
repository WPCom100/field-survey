import type { SyncStatus } from '@field-survey/core';
import { describe, expect, it } from 'vitest';

import { clock, describeBlobs, describeSync, statusTone } from './describe';

const at = (h: number, m: number) => new Date(2026, 10, 9, h, m, 7).toISOString();

const base: SyncStatus = {
  state: 'idle',
  pendingOps: 0,
  quarantinedOps: 0,
  willReview: 0,
  lastSyncAt: at(14, 5),
  lastServerSeq: {},
  lastError: null,
  lastFailure: null,
  failures: 0,
  nextAttemptAt: null,
  lastCycle: null,
};
const s = (over: Partial<SyncStatus>): SyncStatus => ({ ...base, ...over });
const noBlobs = { photosWaiting: 0, uploadsFailed: 0 };

describe('the status bar copy (T176, the board)', () => {
  it('clock is 24-hour HH:MM in local time', () => {
    expect(clock(at(9, 3))).toBe('09:03');
    expect(clock(at(14, 5))).toBe('14:05');
  });

  it('reads the board lines', () => {
    expect(describeSync(base)).toBe('Synced 14:05');
    expect(describeSync(s({ state: 'syncing' }))).toBe('Syncing…');
    expect(describeSync(s({ state: 'offline', pendingOps: 3, lastSyncAt: at(13, 40) }), describeBlobs({ photosWaiting: 1, uploadsFailed: 0 }))).toBe(
      'Offline · 3 edits waiting · 1 photo waiting · Last synced 13:40',
    );
    expect(describeSync(s({ state: 'error', lastFailure: 'auth', pendingOps: 1 }))).toBe('Sign-in needed to sync · 1 edit waiting · Last synced 14:05');
  });

  it('the other states and counts', () => {
    expect(describeSync(s({ lastSyncAt: null }))).toBe('Not synced yet');
    expect(describeSync(s({ state: 'offline', lastSyncAt: null }))).toBe('Offline');
    expect(describeSync(s({ state: 'no_token', pendingOps: 2 }))).toBe('Not connected · 2 edits waiting');
    expect(describeSync(s({ state: 'error', lastFailure: 'server', lastError: 'HTTP 500' }))).toBe('Sync error: HTTP 500 · Last synced 14:05');
    expect(describeSync(s({ pendingOps: 1, quarantinedOps: 2, willReview: 1 }))).toBe('Synced 14:05 · 1 edit waiting · 2 need attention · 1 will be reviewed');
    expect(describeSync(s({ state: 'syncing', pendingOps: 4 }), '2 photos waiting')).toBe('Syncing… · 4 edits waiting · 2 photos waiting');
    // nothing pending reads "Synced <time>" alone: the flows match 'Synced [^·]*'
    expect(describeSync(base, describeBlobs(noBlobs))).toMatch(/^Synced [^·]*$/);
  });

  it('describeBlobs', () => {
    expect(describeBlobs(noBlobs)).toBeNull();
    expect(describeBlobs({ photosWaiting: 2, uploadsFailed: 1 })).toBe('2 photos waiting · 1 upload failed');
  });

  it('the tint follows offline, waiting, sign-in and errors', () => {
    expect(statusTone(base, noBlobs)).toBe('ok');
    expect(statusTone(s({ state: 'syncing' }), noBlobs)).toBe('busy');
    expect(statusTone(s({ pendingOps: 1 }), noBlobs)).toBe('warn');
    expect(statusTone(base, { photosWaiting: 1, uploadsFailed: 0 })).toBe('warn');
    expect(statusTone(s({ state: 'offline' }), noBlobs)).toBe('warn');
    expect(statusTone(s({ state: 'no_token' }), noBlobs)).toBe('warn');
    expect(statusTone(s({ state: 'error', lastFailure: 'auth' }), noBlobs)).toBe('warn');
    expect(statusTone(s({ state: 'error', lastFailure: 'server' }), noBlobs)).toBe('error');
    expect(statusTone(base, { photosWaiting: 0, uploadsFailed: 1 })).toBe('error');
    expect(statusTone(s({ quarantinedOps: 1 }), noBlobs)).toBe('error');
  });
});
