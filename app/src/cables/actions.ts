/**
 * Edits of the cable / riser view (T39) beyond the end editor's: Confirm endpoint (D6) — the
 * reviewer checked the far end against the riser. One op, `Riser cross-check` (D180). No React or
 * Expo imports: tested in Node.
 */

import type { EditContext, Editor, Op } from '@field-survey/core';

export const RISER_CROSS_CHECK: EditContext = { change_type: 'Riser cross-check', reason: 'Endpoint confirmed against the riser' };

/** Marks the cable's endpoints confirmed; null when it already was. */
export function confirmEndpoint(editor: Editor, cableId: string): Promise<Op | null> {
  return editor.setField('cable', cableId, 'endpoint_confirmed', true, RISER_CROSS_CHECK);
}
