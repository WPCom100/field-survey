/**
 * T146 (D245, D246, D247): addresses follow the wires. `device.ip_address` (IPv4 dotted quad, no
 * subnet) and `device.dmx_address` (`<universe>/<address>`) beside `neuron_id`, indexed like it;
 * `library_type.needs_ip_address` / `needs_dmx_address` beside `needs_neuron_id` — null = "by
 * the wires" (the device's cable codes decide, `addressNeeds` in packages/rules). No row is
 * rewritten: a fresh iPad rebuilds the tables from ops and must read the same. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE device ADD COLUMN ip_address TEXT`,
  `ALTER TABLE device ADD COLUMN dmx_address TEXT`,
  `CREATE INDEX ix_device_ip_address ON device (ip_address)`,
  `CREATE INDEX ix_device_dmx_address ON device (dmx_address)`,
  `ALTER TABLE library_type ADD COLUMN needs_ip_address INTEGER`,
  `ALTER TABLE library_type ADD COLUMN needs_dmx_address INTEGER`,
];
