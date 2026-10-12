/**
 * Project setup read model and actions (T41, Phase 3 §3.1): the project's own fields and the
 * levels table (floor order, in scope, numbering-group sharing, split level, "Add range").
 * Reads come from the local store; every change is an op through `Editor` (`Master edit`,
 * reason "Project setup"), so it works offline and syncs like any field edit. No React or
 * Expo imports: tested in Node over `BetterSqliteDriver`.
 *
 * Project *creation* is not here: it happens on the server (`api.ts`, D127).
 */

import { Editor, type EditBatch, type EditContext, type Store } from '@field-survey/core';

export const SETUP_CTX: EditContext = { change_type: 'Master edit', reason: 'Project setup' };
export const DEFAULT_EXPORT_TITLE = 'ETC Lighting Controls Survey';

export type Parties = { ec: string; etc: string; gc: string };
export type ProjectSettings = { export_title: string; disclaimer: string };

export type SetupProject = {
  id: string;
  name: string;
  site: string;
  parties: Parties;
  settings: ProjectSettings;
  copiedFromId: string | null;
};

export type SetupLevel = {
  id: string;
  code: string;
  floorOrder: number;
  inScope: boolean;
  state: 'setup' | 'baseline_locked';
  groupId: string;
  /** The group's label (`06/06M`), derived from its member codes when the row is missing. */
  groupLabel: string;
  /** Another live level uses the same numbering group (D33). */
  shared: boolean;
  splitOfId: string | null;
  splitOfCode: string | null;
  /** Title (or blob tail) of the display sheet; null before T45 uploads one. */
  sheet: string | null;
  /** Devices, punch items, parts, photos and cable ends on the level: once > 0 its numbering group is fixed. */
  records: number;
};

export type ProjectSetup = { project: SetupProject; levels: SetupLevel[] };

type Row = Record<string, unknown>;

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

// ------------------------------------------------------------------- codes

/** `6` → `06`, `6m` → `06M`, `b2` → `B2`: the project's level codes (CLAUDE.md §3). */
export function normLevelCode(code: string): string {
  const c = code.trim().toUpperCase();
  const m = /^(\d+)([A-Z]*)$/.exec(c);
  return m ? m[1]!.padStart(2, '0') + m[2]! : c;
}

/**
 * "Add range…": `09-28` → 09 … 28; `09, 11-12` → 09, 11, 12; a lone code is itself. Only
 * numeric ranges expand (B2-B1 is not a range). Throws `SetupError` on anything else.
 */
export function parseLevelRange(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (m) {
      const [from, to] = [Number(m[1]), Number(m[2])];
      if (to < from) throw new SetupError(`Range ${part}: the end is before the start`);
      if (to - from > 200) throw new SetupError(`Range ${part}: more than 200 levels`);
      for (let n = from; n <= to; n++) out.push(normLevelCode(String(n)));
    } else if (/^[A-Za-z0-9]+$/.test(part)) {
      out.push(normLevelCode(part));
    } else {
      throw new SetupError(`"${part}" is not a level code or a range like 09-28`);
    }
  }
  if (out.length === 0) throw new SetupError('Type a level code or a range like 09-28');
  return [...new Set(out)];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function obj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

export function partiesOf(v: unknown): Parties {
  const o = obj(v);
  return { ec: str(o.ec), etc: str(o.etc), gc: str(o.gc) };
}

export function settingsOf(v: unknown): ProjectSettings {
  const o = obj(v);
  return { export_title: str(o.export_title) || DEFAULT_EXPORT_TITLE, disclaimer: str(o.disclaimer) };
}

// -------------------------------------------------------------------- read

async function liveLevels(store: Store, projectId: string): Promise<Row[]> {
  return store.list<Row>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
}

/** The project and its levels table; null if the project is unknown or deleted. */
export async function loadProjectSetup(store: Store, projectId: string): Promise<ProjectSetup | null> {
  const pr = await store.get<Row>('project', projectId);
  if (!pr || pr.deleted_at) return null;
  const levels = await liveLevels(store, projectId);
  const groups = new Map<string, string>();
  for (const g of await store.list<Row>('numbering_group', { where: 'project_id = ?', params: [projectId] })) {
    groups.set(String(g.id), str(g.label));
  }
  const members = new Map<string, string[]>();
  for (const l of levels) {
    const gid = String(l.numbering_group_id);
    members.set(gid, [...(members.get(gid) ?? []), String(l.level)]);
  }
  const codeById = new Map(levels.map((l) => [String(l.id), String(l.level)]));

  const records = new Map<string, number>();
  const count = async (sql: string) => {
    for (const r of await store.db.query<{ level_id: string; n: number }>(sql, [])) {
      records.set(r.level_id, (records.get(r.level_id) ?? 0) + r.n);
    }
  };
  for (const table of ['device', 'punch_item', 'missing_part', 'photo', 'cable_end']) {
    await count(`SELECT level_id, count(*) AS n FROM ${table} WHERE deleted_at IS NULL AND level_id IS NOT NULL GROUP BY level_id`);
  }

  const sheets = new Map<string, string>();
  const sheetIds = levels.map((l) => l.display_sheet_id).filter((x): x is string => typeof x === 'string');
  if (sheetIds.length) {
    const rows = await store.list<Row>('sheet', {
      where: `id IN (${sheetIds.map(() => '?').join(', ')})`,
      params: sheetIds,
    });
    for (const s of rows) sheets.set(String(s.id), str(s.title) || (typeof s.blob === 'string' ? `…${s.blob.slice(-8)}` : 'sheet'));
  }

  return {
    project: {
      id: projectId,
      name: str(pr.name),
      site: str(pr.site),
      parties: partiesOf(pr.parties),
      settings: settingsOf(pr.settings),
      copiedFromId: typeof pr.copied_from_id === 'string' ? pr.copied_from_id : null,
    },
    levels: levels.map((l, i): SetupLevel => {
      const id = String(l.id);
      const gid = String(l.numbering_group_id);
      const codes = members.get(gid) ?? [];
      const splitOfId = typeof l.split_of_id === 'string' ? l.split_of_id : null;
      return {
        id,
        code: String(l.level),
        floorOrder: typeof l.floor_order === 'number' ? l.floor_order : i + 1,
        inScope: l.in_scope !== 0 && l.in_scope !== false,
        state: l.state === 'baseline_locked' ? 'baseline_locked' : 'setup',
        groupId: gid,
        groupLabel: groups.get(gid) || codes.join('/'),
        shared: codes.length > 1,
        splitOfId,
        splitOfCode: splitOfId ? (codeById.get(splitOfId) ?? null) : null,
        sheet: typeof l.display_sheet_id === 'string' ? (sheets.get(l.display_sheet_id) ?? null) : null,
        records: records.get(id) ?? 0,
      };
    }),
  };
}

// ----------------------------------------------------------------- actions

export type AddLevelInput = {
  code: string;
  inScope?: boolean;
  /** Share this level's numbering group (D33). */
  shareWithLevelId?: string | null;
  /** The level this one is a split of (06M of 06); placed right after it in floor order. */
  splitOfLevelId?: string | null;
};

/** Level and project edits as ops (one group per action). */
export class SetupActions {
  private readonly editor: Editor;

  constructor(
    private readonly store: Store,
    private readonly projectId: string,
    userId: string,
  ) {
    this.editor = new Editor(store, { projectId, userId });
  }

  private async setup(): Promise<ProjectSetup> {
    const s = await loadProjectSetup(this.store, this.projectId);
    if (!s) throw new SetupError('Unknown project');
    return s;
  }

  private static level(s: ProjectSetup, id: string): SetupLevel {
    const l = s.levels.find((x) => x.id === id);
    if (!l) throw new SetupError('Unknown level');
    return l;
  }

  /** Group labels follow their members' codes in floor order (`06/06M`); empty groups keep theirs. */
  private async relabel(g: EditBatch, levels: SetupLevel[], groupOf: (l: SetupLevel) => string): Promise<void> {
    const codes = new Map<string, string[]>();
    for (const l of levels) codes.set(groupOf(l), [...(codes.get(groupOf(l)) ?? []), l.code]);
    for (const [gid, members] of codes) {
      const row = await this.store.get<Row>('numbering_group', gid);
      if (row) await g.setField('numbering_group', gid, 'label', members.join('/'));
    }
  }

  async addLevel(input: AddLevelInput): Promise<string> {
    const s = await this.setup();
    const code = normLevelCode(input.code);
    if (!code) throw new SetupError('Type a level code');
    if (s.levels.some((l) => l.code === code)) throw new SetupError(`Level ${code} already exists`);
    const share = input.shareWithLevelId ? SetupActions.level(s, input.shareWithLevelId) : null;
    const parent = input.splitOfLevelId ? SetupActions.level(s, input.splitOfLevelId) : null;
    let id = '';
    await this.editor.group(SETUP_CTX, async (g) => {
      const groupId = share
        ? share.groupId
        : (await g.create('numbering_group', { project_id: this.projectId, label: code })).id;
      // After its parent when it is a split; else at the end.
      const order = parent ? parent.floorOrder + 1 : (s.levels.at(-1)?.floorOrder ?? 0) + 1;
      if (parent) {
        for (const l of s.levels) if (l.floorOrder >= order) await g.setField('level', l.id, 'floor_order', l.floorOrder + 1);
      }
      id = (
        await g.create('level', {
          project_id: this.projectId,
          level: code,
          floor_order: order,
          numbering_group_id: groupId,
          in_scope: input.inScope ?? true,
          split_of_id: parent?.id ?? null,
          state: 'setup',
        })
      ).id;
      if (share) {
        const next: SetupLevel = { ...share, id, code, floorOrder: order };
        const shifted = s.levels.map((l) => (parent && l.floorOrder >= order ? { ...l, floorOrder: l.floorOrder + 1 } : l));
        await this.relabel(g, [...shifted, next].sort((x, y) => x.floorOrder - y.floorOrder), (l) => l.groupId);
      }
    });
    return id;
  }

  /** "Add range…": every code not yet in the project, each on its own group, out of scope by default (R2f far ends). */
  async addRange(text: string, inScope = false): Promise<string[]> {
    const s = await this.setup();
    const have = new Set(s.levels.map((l) => l.code));
    const codes = parseLevelRange(text).filter((c) => !have.has(c));
    const ids: string[] = [];
    let order = (s.levels.at(-1)?.floorOrder ?? 0) + 1;
    await this.editor.group(SETUP_CTX, async (g) => {
      for (const code of codes) {
        const { id: groupId } = await g.create('numbering_group', { project_id: this.projectId, label: code });
        const { id } = await g.create('level', {
          project_id: this.projectId,
          level: code,
          floor_order: order++,
          numbering_group_id: groupId,
          in_scope: inScope,
          split_of_id: null,
          state: 'setup',
        });
        ids.push(id);
      }
    });
    return ids;
  }

  async setInScope(levelId: string, inScope: boolean): Promise<void> {
    await this.editor.setField('level', levelId, 'in_scope', inScope, SETUP_CTX);
  }

  async setSplitOf(levelId: string, parentId: string | null): Promise<void> {
    const s = await this.setup();
    SetupActions.level(s, levelId);
    if (parentId !== null) {
      const parent = SetupActions.level(s, parentId);
      if (parent.id === levelId) throw new SetupError('A level cannot be a split of itself');
      if (parent.splitOfId === levelId) throw new SetupError(`${parent.code} is already a split of this level`);
    }
    await this.editor.setField('level', levelId, 'split_of_id', parentId, SETUP_CTX);
  }

  /** Move a level one step up or down; floor orders are renumbered 1..n for everyone affected. */
  async move(levelId: string, direction: -1 | 1): Promise<void> {
    const s = await this.setup();
    const i = s.levels.findIndex((l) => l.id === levelId);
    if (i < 0) throw new SetupError('Unknown level');
    const j = i + direction;
    if (j < 0 || j >= s.levels.length) return;
    const order = [...s.levels];
    [order[i], order[j]] = [order[j]!, order[i]!];
    await this.reorder(order.map((l) => l.id));
  }

  /** Drag-to-reorder result: the ids in their new floor order. */
  async reorder(ids: string[]): Promise<void> {
    const s = await this.setup();
    const byId = new Map(s.levels.map((l) => [l.id, l]));
    if (ids.length !== s.levels.length || ids.some((id) => !byId.has(id))) throw new SetupError('Reorder lists every level once');
    await this.editor.group(SETUP_CTX, async (g) => {
      for (const [k, id] of ids.entries()) {
        if (byId.get(id)!.floorOrder !== k + 1) await g.setField('level', id, 'floor_order', k + 1);
      }
      await this.relabel(g, ids.map((id) => byId.get(id)!), (l) => l.groupId);
    });
  }

  /** Share `withLevelId`'s numbering group (D33). Refused once the level has numbered records. */
  async shareNumbering(levelId: string, withLevelId: string): Promise<void> {
    const s = await this.setup();
    const l = SetupActions.level(s, levelId);
    const target = SetupActions.level(s, withLevelId);
    if (l.id === target.id) throw new SetupError('Pick another level to share with');
    if (l.groupId === target.groupId) return;
    if (l.records > 0) throw new SetupError(`${l.code} already has ${l.records} numbered records; its numbering group cannot change`);
    await this.editor.group(SETUP_CTX, async (g) => {
      await g.setField('level', l.id, 'numbering_group_id', target.groupId);
      await this.relabel(g, s.levels, (x) => (x.id === l.id ? target.groupId : x.groupId));
    });
  }

  /** Give a shared level its own numbering group again. Refused once it has numbered records. */
  async separateNumbering(levelId: string): Promise<void> {
    const s = await this.setup();
    const l = SetupActions.level(s, levelId);
    if (!l.shared) return;
    if (l.records > 0) throw new SetupError(`${l.code} already has ${l.records} numbered records; its numbering group cannot change`);
    await this.editor.group(SETUP_CTX, async (g) => {
      const { id: groupId } = await g.create('numbering_group', { project_id: this.projectId, label: l.code });
      await g.setField('level', l.id, 'numbering_group_id', groupId);
      await this.relabel(g, s.levels, (x) => (x.id === l.id ? groupId : x.groupId));
    });
  }

  /** Name, site, parties and export settings (Phase 3 §3.1 step 1). */
  async setProject(values: { name?: string; site?: string; parties?: Partial<Parties>; settings?: Partial<ProjectSettings> }): Promise<void> {
    const s = await this.setup();
    const fields: Row = {};
    if (values.name !== undefined) {
      const name = values.name.trim();
      if (!name) throw new SetupError('The project needs a name');
      fields.name = name;
    }
    if (values.site !== undefined) fields.site = values.site.trim() || null;
    if (values.parties !== undefined) fields.parties = { ...s.project.parties, ...values.parties };
    if (values.settings !== undefined) {
      const next = { ...s.project.settings, ...values.settings };
      fields.settings = { export_title: next.export_title.trim() || DEFAULT_EXPORT_TITLE, disclaimer: next.disclaimer.trim() };
    }
    await this.editor.setFields('project', this.projectId, fields, SETUP_CTX);
  }
}
