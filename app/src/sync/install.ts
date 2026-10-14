/**
 * The per-install label (T86, D155): "This iPad: Field 1". Stored as an `install` record whose id
 * is the install id, written through the Editor so it syncs; other iPads read it from their own
 * store. No React or Expo imports, so it is tested in Node.
 */

import { Editor, type Store } from '@field-survey/core';

type InstallRow = { id: string; label: string | null };

/** install id → label, for every labelled install this store knows. */
export async function loadInstallLabels(store: Store): Promise<Map<string, string>> {
  const rows = await store.list<InstallRow>('install');
  const out = new Map<string, string>();
  for (const r of rows) if (r.label) out.set(r.id, r.label);
  return out;
}

/** What names an iPad: its label, else "iPad …<id tail>". */
export function installName(installId: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(installId) ?? `iPad …${installId.slice(-6)}`;
}

/** Save the label typed on the Sync screen. Blank clears it; unchanged writes nothing. */
export async function saveInstallLabel(
  store: Store,
  projectId: string,
  userId: string,
  text: string,
): Promise<'saved' | 'unchanged'> {
  const label = text.trim();
  const editor = new Editor(store, { projectId, userId });
  const ctx = { change_type: 'Correction', reason: 'iPad label' } as const;
  const now = new Date().toISOString();
  const row = await store.get<InstallRow>('install', store.installId);
  if (!row) {
    if (!label) return 'unchanged';
    await editor.create('install', { id: store.installId, label, user_id: userId, updated_at: now }, ctx);
    return 'saved';
  }
  if ((row.label ?? '') === label) return 'unchanged';
  await editor.setFields('install', store.installId, { label: label || null, user_id: userId, updated_at: now }, ctx);
  return 'saved';
}

/**
 * The Levels home's "who is this" line (T87, D160): the signed-in team name and this iPad's label,
 * so a second iPad running under the same name is obvious before anyone goes offline. Unlabelled
 * iPads show the id tail and a hint to name them on the Sync screen.
 */
export function homeIdentityLine(userName: string, installId: string, labels: ReadonlyMap<string, string>): string {
  const labelled = labels.has(installId);
  return `Signed in as ${userName} · This iPad: ${installName(installId, labels)}${labelled ? '' : ' (name it on the Sync screen)'}`;
}
