import { Store } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { ensureDemoLevel } from '../plan/demo';
import { listProjects } from '../home/data';
import { homeIdentityLine, installName, loadInstallLabels, saveInstallLabel } from './install';

describe('install label (D155)', () => {
  it('creates, renames and clears the label as ops, and names unlabelled installs by tail', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: 'aaaa-bbbbbb', search: 'like' });
    await ensureDemoLevel(store);
    const [p] = await listProjects(store);
    const user = 'u1';
    expect(await saveInstallLabel(store, p!.id, user, '  ')).toBe('unchanged');
    expect(await saveInstallLabel(store, p!.id, user, ' Field 1 ')).toBe('saved');
    expect((await loadInstallLabels(store)).get('aaaa-bbbbbb')).toBe('Field 1');
    expect(await saveInstallLabel(store, p!.id, user, 'Field 1')).toBe('unchanged');
    expect(await saveInstallLabel(store, p!.id, user, 'Field 2')).toBe('saved');
    expect((await loadInstallLabels(store)).get('aaaa-bbbbbb')).toBe('Field 2');
    const ops = await store.db.query<{ n: number }>(`SELECT count(*) AS n FROM outbox WHERE op_id IN (SELECT op_id FROM op WHERE entity_kind = 'install')`);
    expect(ops[0]!.n).toBeGreaterThanOrEqual(2);
    await saveInstallLabel(store, p!.id, user, '');
    const labels = await loadInstallLabels(store);
    expect(labels.size).toBe(0);
    expect(installName('xxxx-123456', labels)).toBe('iPad …123456');
    expect(installName('xxxx-123456', new Map([['xxxx-123456', 'Field 1']]))).toBe('Field 1');
  });

  it('the Levels home names the team member and this iPad (T87)', () => {
    const labels = new Map([['i-111111', 'Field 1']]);
    expect(homeIdentityLine('Landry', 'i-111111', labels)).toBe('Signed in as Landry · This iPad: Field 1');
    expect(homeIdentityLine('Landry', 'i-abcdef', labels)).toBe('Signed in as Landry · This iPad: iPad …abcdef (name it on the Sync screen)');
  });
});
