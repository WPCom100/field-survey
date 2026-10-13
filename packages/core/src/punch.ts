/**
 * A punch item's Device text (D148, D150, D151) and the Needs review action that links an imported
 * punch item to a device (T81).
 *
 * The Device text is **derived from the linked device** wherever it is shown, so a rename or a
 * new tag shows at once with no op on the punch item. An item linked to no device keeps the
 * master's wording (`punch_item.device_text`, e.g. the room or `All devices`). Mirrors
 * `default_device_text` / `punch_device_text` in `server/app/jobs/export_xlsx.py`.
 *
 * The seed import raises a `review_item(lint)` with `lint_id = import.punch_device_unmatched` for
 * every Punch List row it could not link to one device. Linking it (to an existing device or one
 * just created with the + Device form) is one `Reconcile` group: the `set` on
 * `punch_item.device_id`, then the item's `resolution`, `resolved_by_id`, `resolved_at` and
 * `state = resolved`.
 */

import type { Editor } from './editor';
import type { Op } from './op';
import { ReviewError, getReviewItem, officialHead, type Resolution, type ReviewItem } from './review';

/** `review_item.subject.lint_id` of an imported punch row linked to no device. */
export const PUNCH_DEVICE_LINT = 'import.punch_device_unmatched';

/** Named by their device alone (D136, D151); so is any device with a panel name. */
const NAME_ONLY_CATEGORIES: readonly string[] = ['Relay panel', 'Equipment rack', 'NSPS'];

/** The device columns the text is built from. */
export type DeviceForText = {
  display_id?: unknown;
  device?: unknown;
  type?: unknown;
  category?: unknown;
  panel_name?: unknown;
  room_location?: unknown;
};

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * `PI1002 S3 - Corridor …` for a station or sensor (model, tag, room), `UFMP4 - BH OBS RM 47` for
 * a Foundry panel without a panel name; `CTB2LCPB` for a named panel, `EBDK (CTB2LCPB)` for an
 * EBDK, the model alone for a rack or NSPS. Null when the device has nothing to show.
 */
export function defaultDeviceText(dev: DeviceForText | null | undefined): string | null {
  if (!dev) return null;
  let name = s(dev.device) || s(dev.type) || s(dev.category);
  const category = s(dev.category);
  const panel = s(dev.panel_name);
  if (category === 'EBDK') return panel ? `EBDK (${panel})` : name || null;
  if (NAME_ONLY_CATEGORIES.includes(category) || panel) return name || null;
  const id = s(dev.display_id);
  const tail = id.includes('-') ? id.slice(id.indexOf('-') + 1) : '';
  if (/^[SD]\d+$/.test(tail)) name = `${name} ${tail}`.trim();
  const room = s(dev.room_location);
  if (room) name = name ? `${name} - ${room}` : room;
  return name || null;
}

/** The Device text of a punch item: its device's, else the master's stored wording (D150). */
export function punchDeviceText(punch: { device_text?: unknown }, dev: DeviceForText | null | undefined): string | null {
  return dev ? defaultDeviceText(dev) : s(punch.device_text) || null;
}

/** An open "link this punch item to a device" review item. */
export function isPunchDeviceItem(item: Pick<ReviewItem, 'kind' | 'subject'>): boolean {
  return item.kind === 'lint' && item.subject?.entity_kind === 'punch_item' && (item.subject as { lint_id?: string }).lint_id === PUNCH_DEVICE_LINT;
}

export interface LinkPunchResult {
  reason: string;
  /** Every op applied: the punch item's `device_id`, then the review item's fields. */
  ops: Op[];
}

/**
 * Link the punch item of a `import.punch_device_unmatched` review item to `deviceId` and close the
 * item, as one `Reconcile` group. `deviceLabel` names the device in the reason ("06M-S3",
 * "06M-? (new)").
 */
export async function linkPunchDevice(
  editor: Editor,
  itemId: string,
  deviceId: string,
  opts: { deviceLabel: string; now?: () => string },
): Promise<LinkPunchResult> {
  const store = editor.store;
  const item = await getReviewItem(store, itemId);
  if (!item || item.deleted_at) throw new ReviewError(`Unknown review item ${itemId}`);
  if (!isPunchDeviceItem(item)) throw new ReviewError('Not a punch item waiting for its device');
  if (item.state !== 'open') throw new ReviewError(`Review item ${itemId} is already ${item.state}`);
  const punchId = item.subject.entity_id;
  const punch = await store.get<Record<string, unknown>>('punch_item', punchId);
  if (!punch) throw new ReviewError('That punch item is not on this iPad');
  const dev = await store.get<Record<string, unknown>>('device', deviceId);
  if (!dev || dev.deleted_at) throw new ReviewError('That device is not on this iPad');
  if (dev.level_id !== punch.level_id) throw new ReviewError('The device is on another level than the punch item');

  const master = s(punch.device_text);
  const reason = `Review: linked punch item to ${opts.deviceLabel}${master ? ` (master: "${master}")` : ''}`;
  const head = async (id: string, field: string) => (await officialHead(store, id, field))?.op_id ?? null;
  const ops = await editor.group({ change_type: 'Reconcile', reason }, async (g) => {
    const set = await g.reconcileSet('punch_item', punchId, 'device_id', deviceId, await head(punchId, 'device_id'));
    const resolution: Resolution = {
      choice: 'link',
      value: deviceId,
      reason,
      reconcile_op_ids: [set.op_id],
      rejected_op_ids: [],
      superseded_op_ids: [],
    };
    await g.reconcileSet('review_item', itemId, 'resolution', resolution, await head(itemId, 'resolution'));
    await g.reconcileSet('review_item', itemId, 'resolved_by_id', editor.userId, await head(itemId, 'resolved_by_id'));
    await g.reconcileSet('review_item', itemId, 'resolved_at', (opts.now ?? (() => new Date().toISOString()))(), await head(itemId, 'resolved_at'));
    await g.reconcileSet('review_item', itemId, 'state', 'resolved', await head(itemId, 'state'));
  });
  return { reason, ops };
}
