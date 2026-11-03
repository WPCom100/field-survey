/**
 * T148 (T146 follow-up): project search finds IP and DMX addresses. The device's `search_doc`
 * insert and update triggers (migration 0001) are recreated with `ip_address` / `dmx_address`
 * (`searchDocTriggerSql(['device'])`, written out here), and the device rows of `search_doc` are
 * rebuilt so addresses captured since 0019 are found at once; the FTS5 triggers on `search_doc`
 * carry the rebuild into `search_fts`. Frozen.
 */
export const statements: readonly string[] = [
  `DROP TRIGGER device_search_ai`,
  `DROP TRIGGER device_search_au`,
  `CREATE TRIGGER device_search_ai AFTER INSERT ON device BEGIN INSERT INTO search_doc (entity_kind, entity_id, level_id, text) SELECT 'device', NEW.id, NEW.level_id, trim(coalesce(NEW.display_id, '') || ' ' || coalesce(NEW.category, '') || ' ' || coalesce(NEW.device, '') || ' ' || coalesce(NEW.type, '') || ' ' || coalesce(NEW.room_location, '') || ' ' || coalesce(NEW.drawing_position, '') || ' ' || coalesce(NEW.notes, '') || ' ' || coalesce(NEW.neuron_id, '') || ' ' || coalesce(NEW.panel_name, '') || ' ' || coalesce(NEW.ip_address, '') || ' ' || coalesce(NEW.dmx_address, '')) WHERE NEW.deleted_at IS NULL; END`,
  `CREATE TRIGGER device_search_au AFTER UPDATE ON device BEGIN DELETE FROM search_doc WHERE entity_id = NEW.id; INSERT INTO search_doc (entity_kind, entity_id, level_id, text) SELECT 'device', NEW.id, NEW.level_id, trim(coalesce(NEW.display_id, '') || ' ' || coalesce(NEW.category, '') || ' ' || coalesce(NEW.device, '') || ' ' || coalesce(NEW.type, '') || ' ' || coalesce(NEW.room_location, '') || ' ' || coalesce(NEW.drawing_position, '') || ' ' || coalesce(NEW.notes, '') || ' ' || coalesce(NEW.neuron_id, '') || ' ' || coalesce(NEW.panel_name, '') || ' ' || coalesce(NEW.ip_address, '') || ' ' || coalesce(NEW.dmx_address, '')) WHERE NEW.deleted_at IS NULL; END`,
  `DELETE FROM search_doc WHERE entity_kind = 'device'`,
  `INSERT INTO search_doc (entity_kind, entity_id, level_id, text) SELECT 'device', id, level_id, trim(coalesce(display_id, '') || ' ' || coalesce(category, '') || ' ' || coalesce(device, '') || ' ' || coalesce(type, '') || ' ' || coalesce(room_location, '') || ' ' || coalesce(drawing_position, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(neuron_id, '') || ' ' || coalesce(panel_name, '') || ' ' || coalesce(ip_address, '') || ' ' || coalesce(dmx_address, '')) FROM device WHERE deleted_at IS NULL`,
];
