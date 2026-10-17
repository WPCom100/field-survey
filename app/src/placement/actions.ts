/**
 * Place devices (T46, Phase 3 §3.4, D205): put an unplaced item's pin on the plan, and flag a draft
 * not on this sheet. Every edit is an op through the `Editor` (`Master edit`, setup work); no React
 * or Expo imports, tested in Node.
 *
 * - A **device** of the baseline gets its pin, with the confirmed Drawing Position, Room and panel
 *   tag (only the fields that change), in one group.
 * - A **draft unit** becomes a device in one group: `baseline_ref_id` = the draft (a pooled draft
 *   counts down by counting them), the level of the sheet, the type and role from `typeForDraft`
 *   (T115, D204 (5)) — a model the library lacks becomes a draft project type carrying the draft's
 *   role (as a field addition, D55) — no `display_id` (the server numbers it, D93 / D118), and the
 *   draft's accessories per unit. Then the accepted cable drafts waiting on it become cables
 *   (`commitWaitingCables`, D193 (3)).
 */

import { OpError, type EditContext, type Editor, type Op, type Store } from '@field-survey/core';

import { commitWaitingCables } from '../drafts/actions';
import type { DraftAccessory, UnplacedDevice, UnplacedDraft, UnplacedItem } from './model';

export const PLACE_REASON = 'Place devices';
const ctx = (what: string): EditContext => ({ change_type: 'Master edit', reason: `${PLACE_REASON}: ${what}` });

export type PlaceInput = {
  /** The level whose plan it is placed on (a pooled draft takes it). */
  levelId: string;
  sheetId: string;
  at: { x: number; y: number };
  drawingPosition?: string | null;
  room?: string | null;
  /** The panel tag (`CT06LCPA`); left out for roles without one. */
  panelName?: string | null;
};

export type PlaceResult = { deviceId: string; created: boolean; cablesMade: number; ops: Op[] };

const str = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * An accessory's quantity per placed device: the draft line's quantity is for all its units (a
 * BOM line `1IFP ×120` under `PI1002 ×120`), so it is divided when it divides evenly; otherwise
 * the expected quantity is left empty for the surveyor to count.
 */
export function perUnit(acc: Pick<DraftAccessory, 'qty'>, units: number): number | null {
  if (acc.qty == null) return null;
  if (units <= 1) return acc.qty;
  return acc.qty % units === 0 ? acc.qty / units : null;
}

/** Put the item on the plan. Throws `OpError` before writing when there is nothing left to place. */
export async function placeItem(editor: Editor, store: Store, item: UnplacedItem, input: PlaceInput, opts: { riserBlob?: string | null } = {}): Promise<PlaceResult> {
  if (!Number.isFinite(input.at.x) || !Number.isFinite(input.at.y)) throw new OpError('Tap the plan where the device is.');
  return item.kind === 'device' ? placeDevice(editor, store, item, input) : placeDraft(editor, store, item, input, opts);
}

async function placeDevice(editor: Editor, store: Store, item: UnplacedDevice, input: PlaceInput): Promise<PlaceResult> {
  const row = await store.get<Record<string, unknown>>('device', item.deviceId);
  if (!row || row.deleted_at) throw new OpError('That device is no longer on this iPad.');
  const changes: Record<string, unknown> = { pin: { sheet: input.sheetId, x: round(input.at.x), y: round(input.at.y) } };
  const was = (k: string) => (typeof row[k] === 'string' && (row[k] as string).trim() ? (row[k] as string).trim() : null);
  const put = (k: string, v: string | null | undefined) => {
    if (v === undefined) return;
    const now = str(v);
    if (now !== was(k)) changes[k] = now;
  };
  put('drawing_position', input.drawingPosition);
  put('room_location', input.room);
  put('panel_name', input.panelName);
  const ops = await editor.group(ctx(item.label), async (g) => {
    await g.setFields('device', item.deviceId, changes);
  });
  return { deviceId: item.deviceId, created: false, cablesMade: 0, ops };
}

async function placeDraft(editor: Editor, store: Store, item: UnplacedDraft, input: PlaceInput, opts: { riserBlob?: string | null }): Promise<PlaceResult> {
  if (item.remaining < 1) throw new OpError(`Every unit of ${item.title} is placed already.`);
  if (item.levelId && item.levelId !== input.levelId) throw new OpError(`${item.title} belongs to another level; place it on that level's plan.`);
  const draft = await store.get<Record<string, unknown>>('draft_device', item.draftId);
  if (!draft || draft.deleted_at || (draft.state !== 'accepted' && draft.state !== 'edited')) throw new OpError('That draft is no longer accepted on this iPad.');
  const model = item.model ?? item.name;
  if (!model) throw new OpError('The draft has no model: edit it in Review drafts first.');
  let deviceId = '';
  const ops = await editor.group(ctx(item.title), async (g) => {
    let libraryTypeId = item.libraryTypeId;
    if (!libraryTypeId) {
      // a model the library lacks: a draft type of this project, for review (D55), with the draft's role
      const t = await g.create('library_type', {
        project_id: editor.projectId,
        model,
        category: item.deviceCategory,
        ...(item.role !== 'other' ? { role: item.role } : {}),
        state: 'draft',
        created_by_id: editor.userId,
      });
      libraryTypeId = t.id;
    }
    const d = await g.create('device', {
      level_id: input.levelId,
      category: item.deviceCategory,
      device: model,
      panel_name: str(input.panelName),
      room_location: str(input.room),
      drawing_position: str(input.drawingPosition),
      pin: { sheet: input.sheetId, x: round(input.at.x), y: round(input.at.y) },
      origin: 'baseline',
      found_on_site: false,
      baseline_ref_id: item.draftId,
      library_type_id: libraryTypeId,
    });
    deviceId = d.id;
    for (const a of item.accessories) {
      await g.create('accessory', {
        device_id: d.id,
        model: a.model,
        expected_qty: perUnit(a, item.qty),
        source_ref: { ...(a.sourceRef ?? {}), draft: item.draftId, role: a.role },
      });
    }
  });
  const cablesMade = await commitWaitingCables(editor, store, editor.projectId, { riserBlob: opts.riserBlob ?? null });
  return { deviceId, created: true, cablesMade, ops };
}

/** Flag (or unflag) a draft as not on this sheet: it leaves the list for the Flagged section. */
export async function flagNotOnSheet(editor: Editor, item: UnplacedDraft, flag: boolean): Promise<Op | null> {
  return editor.setField('draft_device', item.draftId, 'not_on_sheet', flag, ctx(`${flag ? 'not on this sheet' : 'back on the list'}: ${item.title}`));
}
