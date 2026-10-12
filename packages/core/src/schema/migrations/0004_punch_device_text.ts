/**
 * T29 (D136): `punch_item.device_text` — the master's **Device** column text, kept verbatim by the
 * seed import and written back by the export as stored (like From/To, D32); generated from the
 * linked device when empty. Nullable, so existing rows and ops need nothing. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE punch_item ADD COLUMN device_text TEXT`,
];
