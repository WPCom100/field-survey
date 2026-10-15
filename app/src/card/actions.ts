/**
 * Edits the device card makes (T20, Phase 3 §4.3). Each tap is one op through `Editor` (D45,
 * D83), never a table write. Plain field taps carry `Field survey` / "Field survey" (D96);
 * delete, restore and move pin are `Correction`s with the reason the surveyor typed.
 * No React or Expo imports: tested in Node.
 */

import { OpError, displayNumber, vocab, type EditContext, type Editor, type Op, type Store } from '@field-survey/core';
import { cablePlan, libraryCablePayload, type LibraryCable } from '@field-survey/rules';

/** The context of every plain status / notes / accessory / Neuron ID tap (D96). */
export const FIELD_SURVEY: EditContext = { change_type: 'Field survey', reason: 'Field survey' };

/** A `Correction` with the typed reason; refuses a blank one before any op is built. */
export function correction(reason: string): EditContext {
  if (!reason.trim()) throw new OpError('Say why (the reason is kept in the history).');
  return { change_type: 'Correction', reason: reason.trim() };
}

/** One tap on a status button. Tapping the status the device already has writes nothing. */
export function setStatus(editor: Editor, deviceId: string, status: vocab.DeviceStatus): Promise<Op | null> {
  return editor.setField('device', deviceId, 'status', status, FIELD_SURVEY);
}

/** Notes as committed from the text box: trimmed, empty → no note. One op, or none if unchanged. */
export function setNotes(editor: Editor, deviceId: string, text: string): Promise<Op | null> {
  const t = text.trim();
  return editor.setField('device', deviceId, 'notes', t === '' ? null : t, FIELD_SURVEY);
}

/**
 * Notes after tapping a vocabulary chip: the phrase on its own, or appended with "; " (the
 * master's separator). A phrase the note already ends with is not added twice.
 */
export function appendPhrase(notes: string | null, phrase: string): string {
  const cur = (notes ?? '').trim().replace(/;+$/, '').trimEnd();
  if (!cur) return phrase;
  if (cur === phrase || cur.endsWith(`; ${phrase}`)) return cur;
  return `${cur}; ${phrase}`;
}

// ------------------------------------------------------------------ optional cables and accessories (T105)

/**
 * "+ add N → switch": the type's optional run created on the device with both ends, as R2g's
 * builder makes it (the template's code, qty, From / To, the far end on its placeholder). One
 * `Field survey` group.
 */
export async function addOptionalCable(editor: Editor, store: Store, deviceId: string, cable: LibraryCable): Promise<Op[]> {
  const d = await store.get<Record<string, unknown>>('device', deviceId);
  if (!d || d.deleted_at) throw new OpError('This device is not on this iPad.');
  const level = await store.get<Record<string, unknown>>('level', String(d.level_id));
  if (!level) throw new OpError('This device has no level on this iPad.');
  const projectId = String(level.project_id);
  const placeholders = await store.list<{ id: string; label: string; level_id: string | null }>('placeholder', {
    where: 'project_id = ?',
    params: [projectId],
  });
  const device = {
    id: deviceId,
    level_id: String(d.level_id),
    panel_name: (d.panel_name as string | null) ?? null,
    device: (d.device as string | null) ?? null,
    display_id: (d.display_id as string | null) ?? null,
  };
  const plan = cablePlan(projectId, libraryCablePayload(device, cable, placeholders));
  return editor.group(FIELD_SURVEY, async (g) => {
    for (const step of plan) if (step.kind === 'create') await g.create(step.entity, { id: step.id, ...step.payload });
  });
}

/** "+ add <model>": an accessory row on the device, expected as the type says, found not yet counted. */
export async function addOptionalAccessory(editor: Editor, deviceId: string, model: string, expected: number | null): Promise<Op> {
  const { op } = await editor.create('accessory', { device_id: deviceId, model, expected_qty: expected }, FIELD_SURVEY);
  return op;
}

/** Accessory found quantity (expected stays as the BOM said). */
export function setFound(editor: Editor, accessoryId: string, found: number | null): Promise<Op | null> {
  if (found !== null && (!Number.isInteger(found) || found < 0)) throw new OpError('Found must be a whole number, 0 or more.');
  return editor.setField('accessory', accessoryId, 'found_qty', found, FIELD_SURVEY);
}

// ------------------------------------------------------------------ Neuron ID

/** Characters people type for hex digits by mistake, with what they probably meant. */
const LOOKALIKE: Readonly<Record<string, string>> = { O: '0', Q: '0', I: '1', L: '1', S: '5', G: '6', Z: '2' };

/** Upper case, separators (space, `:`, `-`, `.`) removed: `00:a1:b2…` → `00A1B2…`. */
export function normalizeNeuronId(input: string): string {
  return input.toUpperCase().replace(/[\s:.-]/g, '');
}

/** The normalised ID and, if it is not 12 hex digits, why not (with look-alike hints). */
export function checkNeuronId(input: string): { value: string; error: string | null } {
  const value = normalizeNeuronId(input);
  const bad = [...new Set([...value].filter((c) => !/[0-9A-F]/.test(c)))];
  if (bad.length) {
    const hints = bad.map((c) => (LOOKALIKE[c] ? `${c} (${LOOKALIKE[c]}?)` : c)).join(', ');
    return { value, error: `Not hex: ${hints}. A Neuron ID is 0–9 and A–F.` };
  }
  if (value.length !== 12) return { value, error: `A Neuron ID has 12 hex digits; this has ${value.length}.` };
  return { value, error: null };
}

/** Other live devices of the project with this Neuron ID (D76: a duplicate is a warning, not a refusal). */
export async function neuronDuplicates(
  store: Store,
  projectId: string,
  neuronId: string,
  exceptDeviceId: string,
): Promise<{ id: string; label: string }[]> {
  const rows = await store.db.query<Record<string, unknown>>(
    `SELECT d.id, d.display_id, l.level FROM device d JOIN level l ON l.id = d.level_id
     WHERE l.project_id = ? AND d.neuron_id = ? AND d.id <> ? AND d.deleted_at IS NULL ORDER BY d.display_id`,
    [projectId, neuronId, exceptDeviceId],
  );
  return rows.map((r) => ({ id: String(r.id), label: displayNumber('device', r) }));
}

/** Typed Neuron ID: `neuron_id` + `neuron_method = typed` as one group. Refuses an invalid ID. */
export function saveNeuronId(editor: Editor, deviceId: string, input: string): Promise<Op[]> {
  const { value, error } = checkNeuronId(input);
  if (error) throw new OpError(error);
  return editor.setFields('device', deviceId, { neuron_id: value, neuron_method: 'typed' }, FIELD_SURVEY);
}

// ------------------------------------------------------------------ [⋯] corrections

export function deleteDevice(editor: Editor, deviceId: string, reason: string): Promise<Op> {
  return editor.delete('device', deviceId, correction(reason));
}

export function restoreDevice(editor: Editor, deviceId: string, reason: string): Promise<Op> {
  return editor.restore('device', deviceId, correction(reason));
}

/** New pin position in sheet coordinates (D92), rounded to 0.1 pt. */
export function movePin(
  editor: Editor,
  deviceId: string,
  pin: { sheet: string; x: number; y: number },
  reason: string,
  /** The Drawing Position the new pin reads as (T45), set in the same group when given. */
  drawingPosition?: string | null,
): Promise<Op | null> {
  const round = (n: number) => Math.round(n * 10) / 10;
  const at = { sheet: pin.sheet, x: round(pin.x), y: round(pin.y) };
  if (drawingPosition === undefined) return editor.setField('device', deviceId, 'pin', at, correction(reason));
  return editor
    .group(correction(reason), async (g) => {
      await g.setField('device', deviceId, 'pin', at);
      await g.setField('device', deviceId, 'drawing_position', drawingPosition);
    })
    .then((ops) => ops[0] ?? null);
}
