/**
 * E5 and the accessory finding (PLAN §6.1, D52).
 *
 * - E5: an ERP-FT-LVD (0-10V card) found short of what the BOM expects means the 0-10V run
 *   cannot be landed: the 0-10V end is offered `Issue` "Not landed" and the panel the item
 *   "Land 0-10V control wiring" (`Wiring`, `EC`).
 * - Acc: any accessory found < expected is a finding on the device (D52).
 */

import { ownerParam, textParam } from '../params';
import type { Rule } from '../rule';
import type { AccessoryRow } from '../snapshot';
import { cableOf, deviceLabel, endLabel, hasOpenItemText, subjectOfDevice, subjectOfEnd, terminationItem } from './shared';

/** The default item text (the `E5.item` parameter, T102). */
export const LAND_0_10V = 'Land 0-10V control wiring';

function short(a: AccessoryRow): boolean {
  return a.found_qty != null && a.expected_qty != null && a.found_qty < a.expected_qty;
}

export const E5: Rule = {
  id: 'E5',
  title: '0-10V card short',
  text: 'An ERP-FT-LVD (0-10V card) found short of the expected count: the 0-10V end is Issue "Not landed" and the panel needs "Land 0-10V control wiring" (`Wiring`, `EC`).',
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      const lvd = (ctx.index.accessoriesByDevice.get(d.id) ?? []).filter((a) => /^ERP-FT-LVD/i.test((a.model ?? '').trim()) && short(a));
      if (!lvd.length) continue;
      const found = lvd.reduce((n, a) => n + (a.found_qty ?? 0), 0);
      const expected = lvd.reduce((n, a) => n + (a.expected_qty ?? 0), 0);
      const ends = (ctx.index.endsByDevice.get(d.id) ?? []).filter((e) => cableOf(ctx, e)?.cable === '0-10V');
      for (const e of ends) {
        if (e.status === 'Issue') continue;
        ctx.propose({
          subject: subjectOfEnd(ctx, e),
          discriminator: 'E5',
          kind: 'status',
          payload: { now: 'Issue', extra: { note: 'Not landed', status_source: 'derived' } },
          inputs: { found, expected, status: e.status },
          why: `${deviceLabel(ctx, d)}: ERP-FT-LVD found ${found} of ${expected}, so ${endLabel(ctx, e)} (0-10V) cannot be landed.`,
        });
      }
      // The Termination item of an Issue "Not landed" 0-10V end (R3a) is the same text; raise it once.
      const item = textParam(ctx.params, 'E5', 'item');
      if (ends.some((e) => terminationItem(ctx, e)?.item === item)) continue;
      if (hasOpenItemText(ctx, d.id, null, item) || ends.some((e) => hasOpenItemText(ctx, null, e.id, item))) continue;
      ctx.propose({
        subject: subjectOfDevice(d),
        discriminator: 'E5',
        kind: 'punch',
        payload: { item, type: 'Wiring', owner: ownerParam(ctx.params, 'E5', 'owner'), device_id: d.id, cable_end_id: ends[0]?.id ?? null, level_id: d.level_id },
        inputs: { found, expected },
        params: [['E5', 'item'], ['E5', 'owner']],
        why: `${deviceLabel(ctx, d)}: ERP-FT-LVD found ${found} of ${expected}; the 0-10V control wiring waits for the card.`,
      });
    }
  },
};

export const Acc: Rule = {
  id: 'Acc',
  title: 'Accessory short',
  text: 'An accessory found fewer than expected is flagged on its device (D52).',
  run(ctx) {
    for (const [deviceId, list] of ctx.index.accessoriesByDevice) {
      const d = ctx.index.device.get(deviceId);
      if (!d) continue;
      for (const a of list) {
        if (!short(a)) continue;
        ctx.find({ subject: subjectOfDevice(d), discriminator: a.id, message: `${a.model ?? 'Accessory'}: found ${a.found_qty} of ${a.expected_qty}` });
      }
    }
  },
};
