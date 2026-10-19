/**
 * The app's rule engines (T33): one `RuleEngine` per (store, project, user), run by the
 * debounced trigger after every commit and pull (`RulesRunner`), and the `ProposalDecider` the
 * device card uses for Accept / Edit / Reject. No React or Expo imports here (tested in Node);
 * `RulesRunner` plugs the app logger in with `setRulesLog`.
 */

import { DebouncedTrigger, isLibraryStream, type Store } from '@field-survey/core';
import { RULES, RuleEngine, type RuleLog } from '@field-survey/rules';

import type { ProposalDecider, ProposalDecision } from '../card/proposals';

let log: RuleLog = (level, event, data) => {
  const line = `[rules] ${event}${data ? ' ' + JSON.stringify(data) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Route the engine's log lines (the app passes `logTo('rules', …)`). */
export function setRulesLog(fn: RuleLog): void {
  log = fn;
}

const engines = new WeakMap<Store, Map<string, RuleEngine>>();

/** The engine for one project and user over a store, made once. */
export function engineFor(store: Store, projectId: string, userId: string): RuleEngine {
  let perStore = engines.get(store);
  if (!perStore) {
    perStore = new Map();
    engines.set(store, perStore);
  }
  const key = `${projectId}|${userId}`;
  let engine = perStore.get(key);
  if (!engine) {
    engine = new RuleEngine(store, { projectId, userId, rules: RULES, log: (l, e, d) => log(l, e, d) });
    perStore.set(key, engine);
  }
  return engine;
}

// --- a version counter screens reload on after a run or a decision changed proposal rows

let version = 0;
const listeners = new Set<() => void>();

export function rulesVersion(): number {
  return version;
}

export function bumpRulesVersion(): void {
  version++;
  for (const l of listeners) l();
}

/** Be told after each bump; returns the unsubscribe function. */
export function subscribeRules(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Accept / Edit / Reject on the card (Phase 3 §4.3), over this store's engine for the project. */
export function ruleDecider(store: Store, projectId: string, userId: string): ProposalDecider {
  const engine = engineFor(store, projectId, userId);
  return {
    wired: true,
    async decide(proposalId: string, decision: ProposalDecision) {
      await engine.decide(proposalId, decision);
      bumpRulesVersion();
    },
    explain: (proposalId: string) => engine.explain(proposalId),
  };
}

/** What the last pass of the trigger did (the Sync screen's timing line, T131). */
export interface RulesPass {
  /** End of the pass (ISO 8601). */
  at: string;
  /** Projects evaluated. */
  projects: number;
  /** Wall time of the whole pass, every project. */
  ms: number;
  /** Ops the engines wrote. */
  ops: number;
}

let last: RulesPass | null = null;

export function lastRulesPass(): RulesPass | null {
  return last;
}

/**
 * Start the trigger over the app store: every project that changes (locally or by pull) is
 * re-evaluated once things go quiet; the projects given at start run once at once. A change on
 * the app library's stream (D184) re-evaluates every project — the rules read the library
 * (R2g, R3c) and the stream itself is no project to run. Returns the stop function.
 */
export function startRules(store: Store, userId: string, projectIds: () => Promise<string[]>, delayMs = 500): () => void {
  const trigger = new DebouncedTrigger(store, { delayMs });
  const stop = trigger.start(async (changed) => {
    const t0 = Date.now();
    let projects = changed.filter((p) => !isLibraryStream(p));
    if (projects.length < changed.length) {
      // The library changed: every project's rules may read it; keep the order, no duplicates.
      projects = [...new Set([...projects, ...(await projectIds())])];
    }
    let wrote = 0;
    for (const p of projects) {
      try {
        const r = await engineFor(store, p, userId).run();
        wrote += r.ops;
      } catch (e) {
        log('error', 'run_failed', { project: p, error: String((e as Error)?.message ?? e) });
      }
    }
    last = { at: new Date().toISOString(), projects: projects.length, ms: Date.now() - t0, ops: wrote };
    if (wrote) bumpRulesVersion();
  });
  projectIds().then(
    (ids) => trigger.request(ids),
    (e: unknown) => log('error', 'projects_failed', { error: String(e) }),
  );
  return stop;
}
