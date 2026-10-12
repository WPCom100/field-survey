import { Directory, File, Paths } from 'expo-file-system';

import { KEEP_LOGS, MAX_LOG_BYTES, formatLine, rotationNames, type LogCategory } from './format';

/**
 * The tiny logger (CLAUDE.md §5): categories sync, store, rules, plan, written to a rotating
 * file in `Documents/logs/` that the Sync screen exports. Writes are buffered and appended in
 * one go; a logging failure is swallowed, it must never break an edit.
 */
const dir = () => new Directory(Paths.document, 'logs');
let buffer = '';
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const text = buffer;
  buffer = '';
  if (!text) return;
  try {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    const names = rotationNames(KEEP_LOGS);
    const current = new File(d, names[0]!);
    if (current.exists && current.size > MAX_LOG_BYTES) {
      for (let i = names.length - 1; i > 0; i--) {
        const from = new File(d, names[i - 1]!);
        const to = new File(d, names[i]!);
        if (to.exists) to.delete();
        if (from.exists) from.move(to);
      }
    }
    const f = new File(d, names[0]!);
    const old = f.exists ? f.textSync() : '';
    f.write(old + text);
  } catch {
    // never throw from the logger
  }
}

export function logTo(category: LogCategory, level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
  const line = formatLine(new Date(), category, level, event, data);
  if (level === 'error') console.error(line.trimEnd());
  else if (level === 'warn') console.warn(line.trimEnd());
  else console.log(line.trimEnd());
  buffer += line;
  if (!timer) timer = setTimeout(flush, 1500);
}

/** Everything logged so far (oldest file first) as one file for sharing; null if there is no log. */
export function exportLog(): File | null {
  flush();
  try {
    const d = dir();
    if (!d.exists) return null;
    const out = new File(d, 'export.log');
    if (out.exists) out.delete();
    const parts = rotationNames(KEEP_LOGS).reverse().map((n) => new File(d, n)).filter((f) => f.exists).map((f) => f.textSync());
    if (!parts.length) return null;
    out.write(parts.join(''));
    return out;
  } catch {
    return null;
  }
}
