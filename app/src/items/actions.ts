/**
 * Edits of the punch item / missing part editor (T162, D254): one `Field survey` op (or one group)
 * per tap through `Editor` (D45, D83, D96), never a table write. No React or Expo imports: tested
 * in Node.
 */

import { OpError, vocab, type Editor, type Op } from '@field-survey/core';

import { FIELD_SURVEY } from '../card/actions';

export type ItemKind = 'punch' | 'part';

/** The table of each kind. */
export const ITEM_TABLE = { punch: 'punch_item', part: 'missing_part' } as const satisfies Record<ItemKind, string>;

/** The iPad's own calendar date, `YYYY-MM-DD`: a surveyor closing an item at 8 pm closes it today, not tomorrow (UTC). */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Tracking status tap: the status and Date closed as one group (PLAN §4: one field group) —
 * `Closed` stamps today, `Open` / `In progress` clear it. Tapping the status the item already has
 * writes nothing (an item with no status reads `Open`).
 */
export async function setTrackingStatus(editor: Editor, id: string, status: vocab.TrackingStatus, today: string = localDate()): Promise<Op[]> {
  if (!(vocab.TRACKING_STATUS as readonly string[]).includes(status)) throw new OpError(`Not a tracking status: ${status}`);
  const before = await editor.store.get<Record<string, unknown>>('punch_item', id);
  if (!before) throw new OpError('This punch item is not on this iPad.');
  if (before.deleted_at) throw new OpError('This punch item is deleted.');
  if ((before.tracking_status ?? 'Open') === status) return [];
  return editor.setFields('punch_item', id, { tracking_status: status, date_closed: status === 'Closed' ? today : null }, FIELD_SURVEY);
}

/** Part status tap. One op, or none when the part already has it (no status reads `Needed`). */
export async function setPartStatus(editor: Editor, id: string, status: vocab.PartStatus): Promise<Op | null> {
  if (!(vocab.PART_STATUS as readonly string[]).includes(status)) throw new OpError(`Not a part status: ${status}`);
  const before = await editor.store.get<Record<string, unknown>>('missing_part', id);
  if (!before) throw new OpError('This part is not on this iPad.');
  if ((before.part_status ?? 'Needed') === status) return null;
  return editor.setField('missing_part', id, 'part_status', status, FIELD_SURVEY);
}

/** Owner chip (`EC` · `ETC` · `EC/ETC`). One op, or none if unchanged. */
export async function setItemOwner(editor: Editor, kind: ItemKind, id: string, owner: vocab.Owner): Promise<Op | null> {
  if (!(vocab.OWNER as readonly string[]).includes(owner)) throw new OpError(`Not an owner: ${owner}`);
  return editor.setField(ITEM_TABLE[kind], id, 'owner', owner, FIELD_SURVEY);
}

/** Notes as committed from the box (or a chip): trimmed, empty → none. One op, or none if unchanged. */
export function setItemNotes(editor: Editor, kind: ItemKind, id: string, text: string): Promise<Op | null> {
  const t = text.trim();
  return editor.setField(ITEM_TABLE[kind], id, 'notes', t === '' ? null : t, FIELD_SURVEY);
}
