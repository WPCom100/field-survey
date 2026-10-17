/**
 * Rule parameters (T102, D176, D211): the owners, wordings and statuses the rules write, as
 * settings instead of constants. `PARAMS` is the catalogue — every parameter with its built-in
 * default (the D175 / D177 / D210 readings, so a project with no rows behaves exactly as before)
 * and the line the Rules tab shows beside it. Stored values live in `rule_param` rows:
 *
 * - `project_id` = a project: that project's value (`accepted`), edited as `Master edit` ops;
 * - `project_id` null: the app-level default, a `draft` until accepted; project creation copies
 *   the accepted ones (server `projects.py`), so a later app-level edit never moves a project.
 *
 * A project reads its own rows only; no row, or `value` null, is the built-in default. Per-code
 * parameters (`*_by_code`) store a map `{code: value}` merged over the default map, `*` standing
 * for any code without an entry — adding a cable code's owner or wording is an entry, not a
 * release.
 *
 * Templates name what they are filled with in angle brackets (`Run <signal> to <far end>`); a
 * placeholder with nothing to fill it drops out with the joining word before it ("Run DMX").
 * Pure: no store, no React.
 */

import { vocab, type ConnectionStatus, type Owner } from '@field-survey/core';

import { hashUuid, stableStringify } from './hash';

export type ParamKind = 'owner' | 'text' | 'status' | 'bool' | 'side' | 'owner_by_code' | 'text_by_code';

/** A stored or resolved value: a string (owner, text, status, side), a flag, or a per-code map. */
export type ParamValue = string | boolean | Readonly<Record<string, string>>;

export interface ParamSpec {
  /** The rule that reads it (`R3a`, `E7`…; `R3` = the signal words R3a / R3b share, `R5` = the gate). */
  rule: string;
  key: string;
  kind: ParamKind;
  /** What the value is, as the Rules tab labels it. */
  label: string;
  /** "What this changes": the records and texts that follow the value. */
  changes: string;
  default: ParamValue;
  /** Placeholders a template may use (text kinds). */
  placeholders?: readonly string[];
}

/** `[rule, key]`, or `[rule, key, code]` for one code of a per-code parameter. */
export type ParamRef = readonly [rule: string, key: string, code?: string | null];

/** `''` in a status parameter: the end gets no status (`Unsurveyed`). */
export const NO_STATUS = '';

const FAR = ['<signal>', '<far end>'] as const;

/** The catalogue, in the order the Rules tab lists it (grouped by `rule`). */
export const PARAMS: readonly ParamSpec[] = [
  // --- R3: the signal word per cable code (R3a / R3b item text, card labels)
  {
    rule: 'R3',
    key: 'signal',
    kind: 'text_by_code',
    label: 'Signal word per cable code',
    changes: 'The <signal> of every Run / Terminate item ("Run DMX to …", "Terminate network to …"). A new code with a word here is also accepted by the cable-code lint.',
    default: { X: 'DMX', N: 'network', NG: 'network & ground', U: 'Unison', F: 'fiber', P: 'panic', UV: 'UHCI-WM partition sensor', '0-10V': '0-10V', '120V': '120V', D: 'DALI' },
  },
  // --- R3a: Run and Terminate items
  {
    rule: 'R3a',
    key: 'run.item',
    kind: 'text_by_code',
    label: 'Run item text',
    changes: 'The item raised on an end that is Not installed (wire not pulled).',
    default: { '*': 'Run <signal> to <far end>', '0-10V': 'Run and land 0-10V control wiring' },
    placeholders: FAR,
  },
  {
    rule: 'R3a',
    key: 'run.owner',
    kind: 'owner_by_code',
    label: 'Run item owner',
    changes: 'Who pulls the wire: the Owner of each Run item.',
    default: { '*': 'EC' },
  },
  {
    rule: 'R3a',
    key: 'run.end',
    kind: 'side',
    label: 'Which end holds the Run item',
    changes: 'When both ends of a wire are surveyed Not installed, the one Run item goes on this end (D177: the start of the run).',
    default: 'A',
  },
  {
    rule: 'R3a',
    key: 'terminate.item',
    kind: 'text_by_code',
    label: 'Termination item text',
    changes: 'The item raised on an end that is Issue "not terminated" / "not landed" (the wire is run).',
    default: { '*': 'Terminate <signal> to <far end>', '0-10V': 'Land 0-10V control wiring', '120V': 'Land 120V power' },
    placeholders: FAR,
  },
  {
    rule: 'R3a',
    key: 'terminate.owner',
    kind: 'owner_by_code',
    label: 'Termination item owner',
    changes: 'Who terminates: the Owner of each Termination item.',
    default: { '*': 'EC', X: 'EC/ETC', N: 'ETC', NG: 'ETC', U: 'ETC', F: 'EC/ETC' },
  },
  // --- R3b: DMX termination kit item
  { rule: 'R3b', key: 'item', kind: 'text', label: 'Item text', changes: 'The DMX-kit item of a DMX end Issue "no term kit".', default: 'Terminate DMX to <far end>', placeholders: FAR },
  { rule: 'R3b', key: 'owner', kind: 'owner', label: 'Owner', changes: 'The Owner of each DMX-kit item.', default: 'EC/ETC' },
  { rule: 'R3b', key: 'notes', kind: 'text', label: 'Notes', changes: 'The Notes of each DMX-kit item (and how an imported kit item is recognised).', default: 'Waiting on DMX Termination Kits' },
  // --- R3c: the Neuron ID item
  { rule: 'R3c', key: 'item', kind: 'text', label: 'Item text', changes: 'The last item of every numbering group.', default: 'Missing all Device Neuron IDs' },
  { rule: 'R3c', key: 'owner', kind: 'owner', label: 'Owner', changes: 'The Owner of the Neuron ID item.', default: 'EC' },
  { rule: 'R3c', key: 'device_text', kind: 'text', label: 'Device text', changes: 'The Punch List Device cell of the Neuron ID item.', default: 'All devices' },
  // --- R4: parts
  { rule: 'R4a', key: 'owner', kind: 'owner', label: 'Owner of missing parts', changes: 'The Owner every rule-made part gets (R4b); a part with another owner is flagged.', default: 'EC' },
  { rule: 'R4b', key: 'part', kind: 'text', label: 'Part text', changes: 'The part made for each DMX-kit item.', default: 'DMX termination kit - <far end> run', placeholders: ['<far end>'] },
  { rule: 'R4b', key: 'notes', kind: 'text', label: 'Notes', changes: 'The Notes of each DMX-kit part.', default: 'Need to be ordered' },
  // --- R2c / R2d / R2e: library cables (drafts)
  { rule: 'R2c', key: 'fixtures.to', kind: 'text', label: '0-10V To text', changes: 'The To of a relay panel\'s 0-10V row.', default: 'Fixtures' },
  { rule: 'R2c', key: 'fixtures.status', kind: 'status', label: '0-10V starting status', changes: 'The status the 0-10V row starts with (none = Unsurveyed).', default: NO_STATUS },
  { rule: 'R2c', key: 'panic.to', kind: 'text', label: 'Panic (P) To text', changes: 'The To of a relay panel\'s panic row.', default: 'EBDK panic wire' },
  { rule: 'R2c', key: 'panic.status', kind: 'status', label: 'Panic (P) starting status', changes: 'The status the panic row starts with (P is treated as run).', default: 'Installed, untested' },
  { rule: 'R2d', key: 'from', kind: 'text', label: '120V From text', changes: 'The From of an NSPS\'s or rack\'s 120V row.', default: '120v Power' },
  { rule: 'R2d', key: 'nsps.to', kind: 'text', label: 'NSPS 120V To text', changes: 'The To of an NSPS\'s 120V row (D52).', default: 'P-NSPS-D Power Supply' },
  { rule: 'R2d', key: 'rack.to', kind: 'text', label: 'Rack 120V To text', changes: 'The To of an equipment rack\'s 120V row (D52).', default: 'Equipment rack' },
  { rule: 'R2d', key: 'status', kind: 'status', label: '120V starting status', changes: 'The status the 120V row starts with (none = Unsurveyed).', default: NO_STATUS },
  { rule: 'R2e', key: 'host.to', kind: 'text', label: 'Host end To text', changes: 'The To of the NSPS / rack end of each level\'s Unison bus row.', default: 'Unison from stations & sensors' },
  { rule: 'R2e', key: 'bus.to_nsps', kind: 'text', label: 'Bus end To text (NSPS)', changes: 'The To of the Stations & Sensors end when the level\'s host is an NSPS.', default: 'Devices to P-NSPS-D' },
  { rule: 'R2e', key: 'bus.to_rack', kind: 'text', label: 'Bus end To text (rack)', changes: 'The To of the Stations & Sensors end when the level\'s host is an equipment rack.', default: 'Devices to equipment rack' },
  { rule: 'R2e', key: 'status', kind: 'status', label: 'Unison starting status', changes: 'The status the host end starts with (none = Unsurveyed).', default: NO_STATUS },
  // --- R2f: out-of-scope runs
  { rule: 'R2f', key: 'status', kind: 'status', label: 'Status of an out-of-scope run', changes: 'What an unsurveyed end on, or running to, an out-of-scope level is offered.', default: 'Not started' },
  // --- R5: the survey gate
  { rule: 'R5', key: 'enabled', kind: 'bool', label: 'Far-end items wait for that floor\'s survey', changes: 'Off: R3a / R3b items are raised on ends of levels nobody has surveyed yet.', default: true },
  // --- E5: 0-10V card short
  { rule: 'E5', key: 'item', kind: 'text', label: 'Item text', changes: 'The panel\'s item when its ERP-FT-LVD cards are short.', default: 'Land 0-10V control wiring' },
  { rule: 'E5', key: 'owner', kind: 'owner', label: 'Owner', changes: 'The Owner of that item.', default: 'EC' },
  // --- quick actions (the device card)
  { rule: 'E6', key: 'item', kind: 'text', label: 'Item text', changes: 'The Spot-check fixed item.', default: 'Spot check: <found>', placeholders: ['<found>'] },
  { rule: 'E6', key: 'owner', kind: 'owner', label: 'Owner', changes: 'The Owner of the Spot-check item.', default: 'ETC' },
  { rule: 'E6', key: 'notes', kind: 'text', label: 'Notes', changes: 'The Notes of the Spot-check item.', default: 'Reterminated - all good' },
  { rule: 'E7', key: 'device_note', kind: 'text', label: 'Device note', changes: 'Appended to the device Notes by Non-ETC device.', default: 'Not Installed; installed <category> at location appears to be a <make>, confirm.', placeholders: ['<category>', '<make>'] },
  { rule: 'E7', key: 'item', kind: 'text', label: 'Item text', changes: 'The item Non-ETC device makes.', default: 'Confirm existing <category> at location is a <make>, not a <model>', placeholders: ['<category>', '<make>', '<model>'] },
  { rule: 'E7', key: 'owner', kind: 'owner', label: 'Owner', changes: 'The Owner of that item.', default: 'EC' },
  { rule: 'E9', key: 'room', kind: 'text', label: 'Room / Location', changes: 'What Relocated writes in Room / Location.', default: '<new room>; moved from <old room>', placeholders: ['<new room>', '<old room>'] },
  { rule: 'not_found', key: 'note', kind: 'text', label: 'Device note', changes: 'Appended to the device Notes by Not found on site.', default: 'Not Installed.' },
];

const SPEC = new Map(PARAMS.map((p) => [`${p.rule}|${p.key}`, p] as const));

export function paramSpec(rule: string, key: string): ParamSpec | null {
  return SPEC.get(`${rule}|${key}`) ?? null;
}

export function isByCode(kind: ParamKind): boolean {
  return kind === 'owner_by_code' || kind === 'text_by_code';
}

/**
 * The row id of a parameter: a hash of (scope, rule, key), the same on every iPad and on the
 * server (`app/rule_params.py`), so two people setting one parameter offline make one row (D169).
 */
export function ruleParamId(projectId: string | null, ruleId: string, key: string): string {
  return hashUuid('field-survey:rule_param', [projectId ?? 'app', ruleId, key]);
}

/** A `rule_param` row as the rules read it. */
export interface RuleParamRow {
  id: string;
  project_id: string | null;
  rule_id: string;
  key: string;
  value: unknown;
  state: 'draft' | 'accepted' | 'rejected';
  deleted_at: string | null;
}

const OWNERS: readonly string[] = vocab.OWNER;
const STATUSES: readonly string[] = vocab.CONNECTION_STATUS;

/** Is `v` a usable value of one entry of this kind (a per-code map's entry, or a plain value)? */
export function validEntry(kind: ParamKind, v: unknown): v is string | boolean {
  switch (kind) {
    case 'owner':
    case 'owner_by_code':
      return typeof v === 'string' && OWNERS.includes(v);
    case 'text':
    case 'text_by_code':
      return typeof v === 'string' && v.trim() !== '';
    case 'status':
      return typeof v === 'string' && (v === NO_STATUS || STATUSES.includes(v));
    case 'side':
      return v === 'A' || v === 'B';
    case 'bool':
      return typeof v === 'boolean';
  }
}

/**
 * The value a stored one resolves to: a per-code map merged over the default map (bad entries
 * dropped), else the stored value when valid, else the default. Never throws on bad data: a
 * value another app version wrote falls back to the default.
 */
export function resolveValue(spec: ParamSpec, stored: unknown): ParamValue {
  if (isByCode(spec.kind)) {
    const out: Record<string, string> = { ...(spec.default as Record<string, string>) };
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [code, v] of Object.entries(stored as Record<string, unknown>)) {
        if (code.trim() && validEntry(spec.kind, v)) out[code.trim()] = (v as string).trim();
      }
    }
    return out;
  }
  if (stored != null && validEntry(spec.kind, stored)) return typeof stored === 'string' && spec.kind === 'text' ? stored.trim() : stored;
  return spec.default;
}

/** The parameters one scope resolves to (a project's live, accepted rows), with lookups. */
export class RuleParams {
  private readonly values = new Map<string, ParamValue>();
  private readonly stored = new Map<string, RuleParamRow>();

  /** `rows`: the scope's rows; deleted, rejected and draft rows are skipped. */
  constructor(rows: readonly RuleParamRow[] = []) {
    for (const r of rows) {
      if (r.deleted_at != null || r.state !== 'accepted') continue;
      const spec = paramSpec(r.rule_id, r.key);
      if (!spec || r.value == null) continue;
      this.stored.set(`${r.rule_id}|${r.key}`, r);
      this.values.set(`${r.rule_id}|${r.key}`, resolveValue(spec, r.value));
    }
  }

  /** The resolved value; a per-code parameter's whole map (see `code`). */
  get(rule: string, key: string): ParamValue {
    const spec = paramSpec(rule, key);
    if (!spec) throw new Error(`Unknown rule parameter ${rule}.${key}`);
    return this.values.get(`${rule}|${key}`) ?? resolveValue(spec, null);
  }

  /** One code of a per-code parameter: its entry, else `*`, else the code itself. */
  code(rule: string, key: string, code: string | null | undefined): string {
    const map = this.get(rule, key) as Record<string, string>;
    return (code != null ? map[code] : undefined) ?? map['*'] ?? code ?? '';
  }

  /** A ref's resolved value (one code's entry for a per-code ref with a code). */
  ref(r: ParamRef): ParamValue {
    const [rule, key, code] = r;
    const spec = paramSpec(rule, key);
    if (spec && isByCode(spec.kind) && code !== undefined) return this.code(rule, key, code);
    return this.get(rule, key);
  }

  /**
   * The refs whose value differs from the built-in default, as `{"R3a.run.owner[X]": value}`:
   * what a proposal's `inputs_hash` adds (D211), so a project on the defaults hashes as before
   * and a changed parameter re-offers the rejected drafts it words differently.
   */
  overrides(refs: readonly ParamRef[]): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {};
    const defaults = DEFAULT_PARAMS;
    for (const r of refs) {
      const now = this.ref(r);
      if (stableStringify(now) === stableStringify(defaults.ref(r))) continue;
      out[`${r[0]}.${r[1]}${r[2] !== undefined ? `[${r[2] ?? ''}]` : ''}`] = now;
    }
    return out;
  }

  /** Is anything set away from the defaults? */
  get customised(): boolean {
    return this.values.size > 0;
  }
}

/** The built-in defaults (no rows). */
export const DEFAULT_PARAMS = new RuleParams();

/** Typed reads the rules use. */
export function ownerParam(p: RuleParams, rule: string, key: string, code?: string | null): Owner {
  return (code !== undefined ? p.code(rule, key, code) : p.get(rule, key)) as Owner;
}

export function textParam(p: RuleParams, rule: string, key: string, code?: string | null): string {
  return code !== undefined ? p.code(rule, key, code) : (p.get(rule, key) as string);
}

/** A status parameter: null for "no status" (`Unsurveyed`). */
export function statusParam(p: RuleParams, rule: string, key: string): ConnectionStatus | null {
  const v = p.get(rule, key) as string;
  return v === NO_STATUS ? null : (v as ConnectionStatus);
}

export function flagParam(p: RuleParams, rule: string, key: string): boolean {
  return p.get(rule, key) === true;
}

// ------------------------------------------------------------------ templates

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fill a template's `<name>` placeholders. One with nothing to fill it (null / empty) drops out
 * together with the joining word or mark before it: "Run <signal> to <far end>" without a far
 * end is "Run DMX", "Spot check: <found>" without a finding is "Spot check".
 */
export function fillTemplate(template: string, vars: Readonly<Record<string, string | null | undefined>>): string {
  let out = template;
  for (const [name, raw] of Object.entries(vars)) {
    const value = raw == null ? '' : String(raw).trim();
    const token = `<${name}>`;
    if (value) out = out.split(token).join(value);
    else out = out.replace(new RegExp(`(?:\\s*(?:\\bto|\\bfrom|[:;,-])?\\s*)${esc(token)}`, 'g'), '');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * A pattern matching texts the template made, capturing what `capture` was filled with
 * (`Terminate DMX to <far end>` → /^Terminate DMX to (.+)$/i). Other placeholders match anything.
 */
export function templatePattern(template: string, capture: string): RegExp {
  const token = `<${capture}>`;
  const parts = template.split(/(<[^<>]+>)/);
  let captured = false;
  const body = parts
    .map((p) => {
      if (p === token && !captured) {
        captured = true;
        return '(.+)';
      }
      return /^<[^<>]+>$/.test(p) ? '.+?' : esc(p);
    })
    .join('');
  return new RegExp(`^${body}$`, 'i');
}
