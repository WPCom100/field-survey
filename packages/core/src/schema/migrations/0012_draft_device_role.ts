/**
 * T115 (D201): `draft_device.role` — what the BOM / riser extraction read the device as
 * (`relay_panel` … `other`), beside the D196 category it writes. Draft review and placement read
 * it before the category's role (`roleOfCategory` in core); null on drafts made before T115.
 * No row is rewritten. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE draft_device ADD COLUMN role TEXT CHECK (role IN ('relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps', 'touchscreen', 'station', 'sensor', 'other'))`,
];
