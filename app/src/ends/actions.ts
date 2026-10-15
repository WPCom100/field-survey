/**
 * Edits of the connection end editor (T22, Phase 3 §4.5): one op (or one group) per tap through
 * `Editor` (D45, D83), plain field-survey context (D96). No React or Expo imports: tested in Node.
 */

import { OpError, vocab, type Editor, type Op } from '@field-survey/core';

import { FIELD_SURVEY } from '../card/actions';

/**
 * Status tap on an end: the status plus who surveyed it and when, `status_source = surveyed`, as
 * one group. Tapping the status the end already has (as surveyed) writes nothing.
 */
export async function setEndStatus(editor: Editor, endId: string, status: vocab.ConnectionStatus, at: string = new Date().toISOString()): Promise<Op[]> {
  if (!(vocab.CONNECTION_STATUS as readonly string[]).includes(status)) throw new OpError(`Not a connection status: ${status}`);
  return editor.group(FIELD_SURVEY, async (g) => {
    const before = await editor.store.get<Record<string, unknown>>('cable_end', endId);
    if (!before) throw new OpError('This connection end is not on this iPad.');
    if (before.status === status && before.status_source === 'surveyed') return;
    await g.setFields('cable_end', endId, {
      status,
      status_source: 'surveyed',
      surveyed_by_id: editor.userId,
      surveyed_at: at,
    });
  });
}

/** Note as committed from the box: trimmed, empty → none. One op, or none if unchanged. */
export function setEndNote(editor: Editor, endId: string, text: string): Promise<Op | null> {
  const t = text.trim();
  return editor.setField('cable_end', endId, 'note', t === '' ? null : t, FIELD_SURVEY);
}

/**
 * From / To text (D32: generated once, then stored and editable; the export writes it verbatim).
 * Trimmed; empty clears it.
 */
export function setEndText(editor: Editor, endId: string, field: 'from_text' | 'to_text', text: string): Promise<Op | null> {
  const t = text.trim();
  return editor.setField('cable_end', endId, field, t === '' ? null : t, FIELD_SURVEY);
}

/**
 * Point an end at a placeholder (D26) — the endpoint picker. Only an end that is not a device may
 * change (a device end is placed on the plan); the placeholder must belong to the editor's project.
 */
export async function setEndPlaceholder(editor: Editor, endId: string, placeholderId: string): Promise<Op[]> {
  const [end, ph] = await Promise.all([
    editor.store.get<Record<string, unknown>>('cable_end', endId),
    editor.store.get<Record<string, unknown>>('placeholder', placeholderId),
  ]);
  if (!end) throw new OpError('This connection end is not on this iPad.');
  if (!ph || ph.deleted_at || ph.project_id !== editor.projectId) throw new OpError('That placeholder is not in this project.');
  if (end.device_id) throw new OpError('This end is a device; change it on the plan.');
  return editor.group(FIELD_SURVEY, async (g) => {
    if (end.endpoint_kind === 'placeholder' && end.placeholder_id === placeholderId) return;
    await g.setFields('cable_end', endId, { endpoint_kind: 'placeholder', placeholder_id: placeholderId });
  });
}
