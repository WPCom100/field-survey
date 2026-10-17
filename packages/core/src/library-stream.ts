/**
 * The app-level device-type library's op stream (T61, D65, D184). App-library edits are ordinary
 * ops whose `project_id` is this fixed id: the Editor, the outbox, the pull cursor and conflict
 * review treat it like a project, and the transport sends it to `/library/ops` instead of
 * `/ops`. The server stores those ops (and their review items) with no project. Only
 * `library_type`, `rule_param` (T102) and `suggestion` (T99) rows with `project_id` null live there.
 */

export const LIBRARY_STREAM = '00000000-0000-7000-8000-00000000a11b';

export function isLibraryStream(id: string | null | undefined): boolean {
  return id === LIBRARY_STREAM;
}
