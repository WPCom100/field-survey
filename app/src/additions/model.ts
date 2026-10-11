/**
 * Field additions from the plan (T23, Phase 3 §4.6): a device found on site that is not in the
 * baseline, placed where the surveyor long-pressed. No React or Expo imports: runs in Node.
 *
 * - **Type:** picked from the device-type library (this project's types and the app library, D65;
 *   rejected types left out), or a model typed freely, which becomes a **draft** library type of
 *   this project (D55) — unless it matches an existing type's model or alias, which is used instead.
 * - **ID (D93):** `level_number` types are created without an ID and show `<level>-?` + `NEW` until
 *   the server's `assign` arrives; `level_tag` types (stations, sensors) need the drawing tag typed
 *   here (`S15` → `06M-S15`), a duplicate is a warning, not a refusal (D76).
 * - **Record:** `origin = field_addition`, `found_on_site = true`, the pin in sheet coordinates,
 *   status empty (Unsurveyed); the draft type and the device are one group (`Field survey`, D96).
 */

import { DeviceIdError, OpError, deviceIdFor, type Editor, type Op, type Store } from '@field-survey/core';

import { FIELD_SURVEY } from '../card/actions';

export type LibraryChoice = {
  id: string;
  model: string;
  category: string | null;
  aliases: string[];
  scheme: 'level_number' | 'level_tag' | null;
  /** `draft` types are usable at once, flagged until accepted (D48). */
  state: 'draft' | 'accepted';
  /** null = app library (D65). */
  projectId: string | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Library types usable on this project (project first, then app library), optionally of one category. */
export async function libraryChoices(store: Store, projectId: string, category?: string | null): Promise<LibraryChoice[]> {
  const rows = await store.list<Row>('library_type', {
    where: `(project_id = ? OR project_id IS NULL) AND state <> 'rejected'${category ? ' AND category = ?' : ''}`,
    params: category ? [projectId, category] : [projectId],
  });
  const out = rows.map(
    (r): LibraryChoice => ({
      id: String(r.id),
      model: String(r.model),
      category: str(r.category),
      aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [],
      scheme: r.id_scheme === 'level_tag' || r.id_scheme === 'level_number' ? r.id_scheme : null,
      state: r.state === 'accepted' ? 'accepted' : 'draft',
      projectId: str(r.project_id),
    }),
  );
  // a project type shadows an app-library type of the same model (it was copied from it)
  const projectModels = new Set(out.filter((c) => c.projectId).map((c) => c.model.toUpperCase()));
  return out
    .filter((c) => c.projectId || !projectModels.has(c.model.toUpperCase()))
    .sort((a, b) => Number(!a.projectId) - Number(!b.projectId) || a.model.localeCompare(b.model, 'en', { numeric: true }));
}

/** The library type a typed model means (model or alias, any case, spaces ignored), if any. */
export function matchModel(choices: readonly LibraryChoice[], typed: string): LibraryChoice | null {
  const key = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  const k = key(typed);
  if (!k) return null;
  return choices.find((c) => key(c.model) === k || c.aliases.some((a) => key(a) === k)) ?? null;
}

export type FieldDeviceInput = {
  projectId: string;
  levelId: string;
  sheetId: string;
  /** Sheet coordinates of the long-press (D92). */
  at: { x: number; y: number };
  category: string;
  /** A library type picked from the list… */
  libraryTypeId?: string | null;
  /** …or a model typed freely (becomes a draft type unless it matches one). */
  typedModel?: string | null;
  /** `level_tag` types: the drawing tag (`S15`, `15`). */
  tag?: string | null;
  room?: string | null;
};

export type FieldDeviceResult = {
  deviceId: string;
  /** The new draft library type, when the model was typed and matched nothing. */
  draftTypeId: string | null;
  /** `06M-S15` for a tag; null while the server numbers a `level_number` device. */
  displayId: string | null;
  /** Other devices already carrying that tag (a warning). */
  takenBy: string[];
  ops: Op[];
};

/**
 * Create the field addition. Throws `OpError` / `DeviceIdError` (missing tag, wrong letter, no
 * model) before anything is written.
 */
export async function addFieldDevice(editor: Editor, store: Store, input: FieldDeviceInput): Promise<FieldDeviceResult> {
  const choices = await libraryChoices(store, input.projectId);
  let type: LibraryChoice | null = input.libraryTypeId ? (choices.find((c) => c.id === input.libraryTypeId) ?? null) : null;
  if (input.libraryTypeId && !type) throw new OpError('That device type is not in the library on this iPad.');
  const typed = str(input.typedModel);
  if (!type && typed) type = matchModel(choices, typed);
  if (!type && !typed) throw new OpError('Pick a device type or type the model.');
  const category = type?.category ?? input.category;
  const model = type?.model ?? typed!;

  // ID per D93 / T63 — through deviceIdFor, so the scheme is read exactly as the server reads it
  // (a model typed freely has no type row yet: deviceIdFor then goes by the category)
  const proposal = await deviceIdFor(store, {
    projectId: input.projectId,
    levelId: input.levelId,
    category,
    libraryTypeId: type?.id ?? null,
    tag: input.tag ?? null,
  }).catch((e: unknown) => {
    throw e instanceof DeviceIdError ? new OpError(e.message) : e;
  });
  const displayId = proposal.pending ? null : proposal.display_id;
  const takenBy = proposal.pending ? [] : proposal.taken_by;

  let draftTypeId: string | null = null;
  let deviceId = '';
  const round = (n: number) => Math.round(n * 10) / 10;
  const ops = await editor.group(FIELD_SURVEY, async (g) => {
    let libraryTypeId = type?.id ?? null;
    if (!type) {
      const draft = await g.create('library_type', {
        project_id: input.projectId,
        model,
        category,
        state: 'draft',
        created_by_id: editor.userId,
      });
      draftTypeId = libraryTypeId = draft.id;
    }
    const d = await g.create('device', {
      level_id: input.levelId,
      ...(displayId ? { display_id: displayId } : {}),
      category,
      device: model,
      room_location: str(input.room),
      pin: { sheet: input.sheetId, x: round(input.at.x), y: round(input.at.y) },
      origin: 'field_addition',
      found_on_site: true,
      library_type_id: libraryTypeId,
    });
    deviceId = d.id;
  });
  return { deviceId, draftTypeId, displayId, takenBy, ops };
}

/** The ID scheme the form should ask for: the type's, else the category default. */
export function schemeFor(type: LibraryChoice | null, category: string | null): 'level_number' | 'level_tag' {
  if (type?.scheme) return type.scheme;
  return category === 'Station' || category === 'Sensor' ? 'level_tag' : 'level_number';
}
