/**
 * Quick actions E6 / E7 / E9 and "Not found on site" (PLAN §6.1, Phase 3 §4.3). Unlike the rules, these run when a
 * person taps them on the device card: the records are written at once, in one group, with the
 * action's id as `rule_id` on the item. No snapshot, no proposal.
 *
 * | Action | What it writes |
 * |---|---|
 * | E6 "Spot-check fixed" | `Information` item, `ETC`, Closed today, Notes "Reterminated - all good"; item "Spot check: <what was found>" (the master's #14); device Notes untouched |
 * | E7 "Non-ETC device" (make) | device Status `Not installed`, Notes appended "Not Installed; installed <category> at location appears to be a <make>, confirm."; `Information` item `EC` "Confirm existing <category> at location is a <make>, not a <model>" (the master's 02 #22 / 02-D4) |
 * | E9 "Relocated" (new room) | Room / Location = "<new room>; moved from <old room>" |
 * | "Not found on site" | `found_on_site = false`, Status `Not installed`, Notes appended "Not Installed."; no item (R2/R3 make the items from the status) and the device stays in the baseline (D210, T101) |
 */

import { OpError, type EditContext, type Editor, type Op } from '@field-survey/core';

export type QuickAction = { kind: 'E6'; found?: string | null } | { kind: 'E7'; make: string } | { kind: 'E9'; room: string } | { kind: 'not_found' };

export const QUICK_ACTION_TEXT: Readonly<Record<QuickAction['kind'], { title: string; text: string }>> = {
  E6: { title: 'Spot-check fixed', text: 'A spot-check finding fixed on site: an Information item for ETC, Closed today, Notes "Reterminated - all good". The device Notes stay as they are.' },
  E7: { title: 'Non-ETC device', text: 'A non-ETC device found at the location: the device is Not installed with a note of the make, and an Information item for the EC asks to confirm it.' },
  E9: { title: 'Relocated', text: 'The device is somewhere else than drawn: Room / Location becomes the new room with "; moved from <old room>".' },
  not_found: { title: 'Not found on site', text: 'The drawn device is not there: it is marked not found on site and Not installed, with "Not Installed." in its Notes. It stays in the baseline; no item is made here.' },
};

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The master's "; " separator; a phrase the note already ends with is not added twice. */
export function appendPhrase(notes: string | null, phrase: string): string {
  const cur = (notes ?? '').trim().replace(/;+$/, '').trimEnd();
  if (!cur) return phrase;
  if (cur === phrase || cur.endsWith(`; ${phrase}`)) return cur;
  return `${cur}; ${phrase}`;
}

export interface QuickActionResult {
  ops: Op[];
  /** The punch item created, if the action makes one. */
  punchItemId: string | null;
}

/** Run one quick action on a device, as one `Field survey` group. */
export async function runQuickAction(editor: Editor, deviceId: string, action: QuickAction, now: () => string = () => new Date().toISOString()): Promise<QuickActionResult> {
  const device = await editor.store.get<Row>('device', deviceId);
  if (!device) throw new OpError('This device is not on this iPad.');
  if (device.deleted_at) throw new OpError('This device is deleted; restore it first.');
  const levelId = s(device.level_id);
  if (!levelId) throw new OpError('The device has no level.');
  const noun = (s(device.category) ?? 'device').toLowerCase();
  const model = s(device.device) ?? s(device.type) ?? s(device.category) ?? 'device';
  const ctx: EditContext = { change_type: 'Field survey', reason: `Quick action ${action.kind}: ${QUICK_ACTION_TEXT[action.kind].title}` };
  let punchItemId: string | null = null;
  const ops = await editor.group(ctx, async (g) => {
    switch (action.kind) {
      case 'E6': {
        const found = s(action.found ?? null);
        const r = await g.create('punch_item', {
          level_id: levelId,
          device_id: deviceId,
          item: found ? `Spot check: ${found}` : 'Spot check',
          type: 'Information',
          owner: 'ETC',
          tracking_status: 'Closed',
          date_closed: now().slice(0, 10),
          notes: 'Reterminated - all good',
          rule_id: 'E6',
        });
        punchItemId = r.id;
        break;
      }
      case 'E7': {
        const make = s(action.make);
        if (!make) throw new OpError('Say what make the device is.');
        await g.setFields('device', deviceId, {
          status: 'Not installed',
          notes: appendPhrase(s(device.notes), `Not Installed; installed ${noun} at location appears to be a ${make}, confirm.`),
        });
        const r = await g.create('punch_item', {
          level_id: levelId,
          device_id: deviceId,
          item: `Confirm existing ${noun} at location is a ${make}, not a ${model}`,
          type: 'Information',
          owner: 'EC',
          tracking_status: 'Open',
          rule_id: 'E7',
        });
        punchItemId = r.id;
        break;
      }
      case 'E9': {
        const room = s(action.room);
        if (!room) throw new OpError('Say where the device is now.');
        const old = s(device.room_location);
        await g.setField('device', deviceId, 'room_location', old ? `${room}; moved from ${old}` : room);
        break;
      }
      case 'not_found': {
        await g.setFields('device', deviceId, {
          found_on_site: false,
          status: 'Not installed',
          notes: appendPhrase(s(device.notes), 'Not Installed.'),
        });
        break;
      }
    }
  });
  return { ops, punchItemId };
}
