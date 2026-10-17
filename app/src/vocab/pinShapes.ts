/**
 * Pin shapes per role (D64, T104, D214): the shape each role's pins take, for every project at
 * once. Stored as one app-library `rule_param` row (`pin` / `shape`, project null, on the library
 * stream) whose value maps a role to a shape, keeping only the roles moved off their default
 * (`DEFAULT_PIN_SHAPE`); it applies at once (no draft) and is never copied into a project. The
 * iPad's pins and the server's floor PDF (`app/roles.py` `pin_shapes`) read the same row.
 * No React or Expo imports: tested in Node.
 */

import { LIBRARY_STREAM, OpError, ROLE, type EditContext, type Editor, type Role, type Store } from '@field-survey/core';
import { ruleParamId } from '@field-survey/rules';

import { DEFAULT_PIN_SHAPE, PIN_SHAPE_NAMES, type PinShapeMap, type PinShapeName } from '../plan/pins';

export const PIN_SHAPE_RULE = 'pin';
export const PIN_SHAPE_KEY = 'shape';
const CTX: EditContext = { change_type: 'Master edit', reason: 'Pin shapes' };

type Row = Record<string, unknown>;

export const pinShapeRowId = (): string => ruleParamId(null, PIN_SHAPE_RULE, PIN_SHAPE_KEY);

/** Role → shape: the defaults with the stored overrides over them (unknown roles or shapes ignored). */
export function resolvePinShapes(value: unknown): PinShapeMap {
  const out: Record<string, PinShapeName> = { ...DEFAULT_PIN_SHAPE };
  if (value && typeof value === 'object') {
    for (const [role, shape] of Object.entries(value as Record<string, unknown>)) {
      if ((ROLE as readonly string[]).includes(role) && (PIN_SHAPE_NAMES as readonly unknown[]).includes(shape)) out[role] = shape as PinShapeName;
    }
  }
  return out as PinShapeMap;
}

export async function loadPinShapes(store: Store): Promise<PinShapeMap> {
  const row = await store.get<Row>('rule_param', pinShapeRowId());
  return resolvePinShapes(row && !row.deleted_at && row.state === 'accepted' ? row.value : null);
}

/** Give a role another shape (its default = back to normal); one op, none when nothing changes. */
export async function setPinShape(libraryEditor: Editor, store: Store, role: Role, shape: PinShapeName): Promise<number> {
  if (libraryEditor.projectId !== LIBRARY_STREAM) throw new OpError('Pin shapes are set in the app library, for every project.');
  if (!(ROLE as readonly string[]).includes(role) || !(PIN_SHAPE_NAMES as readonly string[]).includes(shape)) throw new OpError(`Unknown role or shape: ${role} / ${shape}`);
  const id = pinShapeRowId();
  const row = await store.get<Row>('rule_param', id);
  const next: Record<string, PinShapeName> = { ...resolvePinShapes(row && !row.deleted_at && row.state === 'accepted' ? row.value : null), [role]: shape };
  const stored: Record<string, PinShapeName> = {};
  for (const r of ROLE) if (next[r] !== DEFAULT_PIN_SHAPE[r]) stored[r] = next[r]!;
  const value = Object.keys(stored).length ? stored : null;
  if (!row) {
    if (!value) return 0;
    return (await libraryEditor.group(CTX, (g) => g.create('rule_param', { id, project_id: null, rule_id: PIN_SHAPE_RULE, key: PIN_SHAPE_KEY, value, state: 'accepted' }))).length;
  }
  if (JSON.stringify(row.value ?? null) === JSON.stringify(value) && !row.deleted_at && row.state === 'accepted') return 0;
  const ops = await libraryEditor.group(CTX, async (g) => {
    if (row.deleted_at) await g.restore('rule_param', id);
    await g.setFields('rule_param', id, { value, state: 'accepted' });
  });
  return ops.length;
}

/** Roles that share a shape with another role (colour is never the only signal, D64: say so). */
export function sharedShapes(shapes: PinShapeMap): Role[] {
  return ROLE.filter((r) => ROLE.some((o) => o !== r && shapes[o] === shapes[r]));
}
