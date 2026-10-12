/**
 * T65 (D128): `photo_link` — a photo linked to further devices, connection ends and punch items,
 * written by `link_add`/`link_remove` like `part_source`. `photo.device_id` stays the device the
 * photo was taken from; `photo.punch_item_id`/`cable_end_id` are read as links too (T21 photos,
 * seed import) but new photos write links only. Frozen.
 */
export const statements: readonly string[] = [
  `CREATE TABLE photo_link (
  photo_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('device', 'cable_end', 'punch')),
  target_id TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by_id TEXT,
  PRIMARY KEY (photo_id, target_kind, target_id)
)`,
  `CREATE INDEX ix_photo_link_target_kind_target_id ON photo_link (target_kind, target_id)`,
];
