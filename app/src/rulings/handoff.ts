/**
 * The hand-off into the ruling editor (T37): "Fix all via ruling" in the Lint view and "Apply as
 * ruling…" on a multi-selection in the plan's side lists put a pre-filled draft here and open
 * `/rulings?project=…&from=handoff`; the Rulings screen takes it once. A module value rather than
 * route params: a selection can hold hundreds of record ids. No React or Expo imports.
 */

import type { RulingDraft } from '@field-survey/rules';

export type RulingHandoff = { projectId: string; draft: RulingDraft; source: string };

let pending: RulingHandoff | null = null;

export function handRuling(projectId: string, draft: RulingDraft, source: string): void {
  pending = { projectId, draft, source };
}

/** The draft handed for this project, once; null when there is none (or it was for another project). */
export function takeRuling(projectId: string): RulingHandoff | null {
  const h = pending;
  if (!h || h.projectId !== projectId) return null;
  pending = null;
  return h;
}
