/** Line format and rotation rule of the on-device log (no Expo imports, tested in Node). */

export const LOG_CATEGORIES = ['sync', 'store', 'rules', 'plan', 'update'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const MAX_LOG_BYTES = 512 * 1024;
export const KEEP_LOGS = 3;

export function formatLine(now: Date, category: LogCategory, level: string, event: string, data?: Record<string, unknown>): string {
  let tail = '';
  if (data) {
    try {
      tail = ' ' + JSON.stringify(data);
    } catch {
      tail = ' [unserialisable]';
    }
  }
  return `${now.toISOString()} ${level.toUpperCase()} [${category}] ${event}${tail}\n`;
}

/** File names for rotation: `app.log` is current, `app.1.log` the previous one … */
export function rotationNames(keep: number = KEEP_LOGS): string[] {
  return ['app.log', ...Array.from({ length: keep - 1 }, (_, i) => `app.${i + 1}.log`)];
}
