export interface Snapshot {
  [key: string]: unknown;
}

export interface EvaluateResult {
  proposals: unknown[];
  findings: unknown[];
}

export function evaluate(snapshot: Snapshot): EvaluateResult {
  void snapshot;
  return { proposals: [], findings: [] };
}
