/**
 * Level assignments (T97, D168): which team names survey which levels. Read from the local
 * `assignment` link rows; every change is an `assignment` `link_add` / `link_remove` op through
 * `Editor` (`Master edit`, reason "Level assignment"), so it works offline and reaches the other
 * iPads on their next sync, where the Levels home's ● and "Assigned to me" and Download assigned
 * levels follow. Anyone on the team may assign; a level may have several people; once a person
 * has any assignment only their levels count for them, with none every in-scope level does (D97).
 * No React or Expo imports: tested in Node over `BetterSqliteDriver`.
 */

import { Editor, type EditContext, type Store } from '@field-survey/core';

import { SetupError } from './model';

export const ASSIGN_CTX: EditContext = { change_type: 'Master edit', reason: 'Level assignment' };

export type AssignmentLevel = {
  id: string;
  code: string;
  inScope: boolean;
  /** User ids assigned to the level, in the order they were assigned. */
  userIds: string[];
};

type Row = Record<string, unknown>;

/** The project's levels in floor order with their assignees. */
export async function loadAssignments(store: Store, projectId: string): Promise<AssignmentLevel[]> {
  const levels = await store.list<Row>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
  const byLevel = new Map<string, string[]>();
  if (levels.length) {
    const rows = await store.list<Row>('assignment', {
      where: `level_id IN (${levels.map(() => '?').join(', ')})`,
      params: levels.map((l) => String(l.id)),
      orderBy: 'assigned_at, user_id',
    });
    for (const a of rows) byLevel.set(String(a.level_id), [...(byLevel.get(String(a.level_id)) ?? []), String(a.user_id)]);
  }
  return levels.map((l) => ({
    id: String(l.id),
    code: String(l.level),
    inScope: l.in_scope !== 0 && l.in_scope !== false,
    userIds: byLevel.get(String(l.id)) ?? [],
  }));
}

/**
 * The people to show as columns: the team list first (in its order), then anyone assigned who is
 * not on it (a name removed from the team keeps its assignments visible, so they can be undone).
 */
export function assigneeColumns(team: ReadonlyArray<{ id: string; name: string }>, levels: AssignmentLevel[]): { id: string; name: string }[] {
  const out = team.map((m) => ({ id: m.id, name: m.name }));
  const seen = new Set(out.map((m) => m.id));
  for (const l of levels) {
    for (const u of l.userIds) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push({ id: u, name: `user …${u.slice(-6)}` });
    }
  }
  return out;
}

/** Assign and unassign as ops; both are no-ops when nothing would change. */
export class AssignmentActions {
  private readonly editor: Editor;

  constructor(
    private readonly store: Store,
    private readonly projectId: string,
    private readonly userId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.editor = new Editor(store, { projectId, userId, now });
  }

  private async level(levelId: string): Promise<AssignmentLevel> {
    const l = (await loadAssignments(this.store, this.projectId)).find((x) => x.id === levelId);
    if (!l) throw new SetupError('Unknown level');
    return l;
  }

  /** Add or remove one person on one level. */
  async set(levelId: string, userId: string, assigned: boolean): Promise<void> {
    if (!userId) throw new SetupError('Pick a person');
    const l = await this.level(levelId);
    if (l.userIds.includes(userId) === assigned) return;
    if (assigned) {
      await this.editor.link('assignment', levelId, { user_id: userId, assigned_by_id: this.userId, assigned_at: this.now() }, ASSIGN_CTX);
    } else {
      await this.editor.unlink('assignment', levelId, { user_id: userId }, ASSIGN_CTX);
    }
  }

  /** "All in scope" / "None" for one person: one op group over every level that changes. */
  async setAll(userId: string, assigned: boolean): Promise<number> {
    if (!userId) throw new SetupError('Pick a person');
    const levels = await loadAssignments(this.store, this.projectId);
    const change = levels.filter((l) => (assigned ? l.inScope && !l.userIds.includes(userId) : l.userIds.includes(userId)));
    const at = this.now();
    await this.editor.group(ASSIGN_CTX, async (g) => {
      for (const l of change) {
        if (assigned) await g.link('assignment', l.id, { user_id: userId, assigned_by_id: this.userId, assigned_at: at });
        else await g.unlink('assignment', l.id, { user_id: userId });
      }
    });
    return change.length;
  }
}
