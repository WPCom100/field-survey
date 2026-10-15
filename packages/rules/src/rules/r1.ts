/**
 * R1 — device status findings (PLAN §6.1). Lint only: `Installed, untested` means nothing is
 * outstanding; outstanding wiring or termination belongs under `Issue`; an `Issue` device needs an
 * open punch item; nothing is `Complete` until the project's completion phase.
 */

import type { Rule } from '../rule';
import { isOpen, itemsOfDevice, subjectOfDevice } from './shared';

const OUTSTANDING_END_STATUS: readonly (string | null)[] = ['Not installed', 'Issue'];
const OUTSTANDING_ITEM_TYPES: readonly (string | null)[] = ['Cable not run', 'Termination', 'Wiring'];

export const R1: Rule = {
  id: 'R1',
  title: 'Device status',
  text: '`Installed, untested` means nothing outstanding; outstanding wiring or termination is `Issue`; an `Issue` device needs an open punch item; nothing is `Complete` this phase.',
  lints: ['R1.untested', 'R1.no_item', 'R1.complete'],
  run(ctx) {
    const settings = ctx.snap.project?.settings ?? null;
    const completionPhase = settings?.completion_phase === true;
    for (const d of ctx.index.device.values()) {
      const subject = subjectOfDevice(d);
      const ends = ctx.index.endsByDevice.get(d.id) ?? [];
      const items = itemsOfDevice(ctx, d);
      if (d.status === 'Installed, untested') {
        const outstanding =
          ends.some((e) => OUTSTANDING_END_STATUS.includes(e.status)) || items.some((p) => isOpen(p) && OUTSTANDING_ITEM_TYPES.includes(p.type));
        if (outstanding) {
          ctx.find({ subject, lint_id: 'R1.untested', message: 'Installed, untested with outstanding wiring/termination → Issue (suggested)' });
        }
      } else if (d.status === 'Issue') {
        if (!items.some(isOpen)) ctx.find({ subject, lint_id: 'R1.no_item', message: 'Issue device with no open punch item' });
      } else if (d.status === 'Complete' && !completionPhase) {
        ctx.find({ subject, lint_id: 'R1.complete', message: 'Complete used before the completion phase' });
      }
    }
  },
};
