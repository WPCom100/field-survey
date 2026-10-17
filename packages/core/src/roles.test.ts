import { describe, expect, it } from 'vitest';

import { defaultIdScheme, defaultIdSchemeForRole, tagDeviceId } from './device-id';
import { defaultDeviceText } from './punch';
import { DEVICE_CATEGORIES, MASTER_CATEGORY_RENAME, ROLE, ROLE_LABEL, canonicalCategory, isRole, roleOf, roleOfCategory } from './roles';

describe('roles (T112, D201)', () => {
  it('names nine roles, each with a label', () => {
    expect(ROLE).toHaveLength(9);
    for (const r of ROLE) expect(ROLE_LABEL[r]).toBeTruthy();
    expect(isRole('nsps')).toBe(true);
    expect(isRole('NSPS')).toBe(false);
    expect(isRole(null)).toBe(false);
  });

  it("the master's eight categories each imply one role", () => {
    expect(roleOfCategory('Relay panel')).toBe('relay_panel');
    expect(roleOfCategory('Foundry panel')).toBe('foundry_panel');
    expect(roleOfCategory('EBDK')).toBe('ebdk');
    expect(roleOfCategory('Equipment rack')).toBe('equipment_rack');
    expect(roleOfCategory('NSPS')).toBe('nsps');
    expect(roleOfCategory('Touchscreen')).toBe('touchscreen');
    expect(roleOfCategory('Station')).toBe('station');
    expect(roleOfCategory('Sensor')).toBe('sensor');
  });

  it('of the D196 eleven, only the categories that name one role imply it', () => {
    expect(DEVICE_CATEGORIES).toHaveLength(11);
    expect(roleOfCategory('Emergency Equipment')).toBe('ebdk');
    expect(roleOfCategory('Equipment Panels')).toBe('equipment_rack');
    expect(roleOfCategory('Equipment Rack')).toBe('equipment_rack');
    // relay and Foundry panels share Power Distribution; NSPS shares Equipment with gateways
    expect(roleOfCategory('Power Distribution')).toBe('other');
    expect(roleOfCategory('Equipment')).toBe('other');
    expect(roleOfCategory('Power Supplies')).toBe('other');
    expect(roleOfCategory('Wall Plates')).toBe('other');
    expect(roleOfCategory('Lighting Console')).toBe('other');
    expect(roleOfCategory(null)).toBe('other');
    expect(roleOfCategory('')).toBe('other');
    expect(roleOfCategory('Dimmer rack')).toBe('other');
  });

  it("roleOf: the type's role, else the type's category, else the device's category", () => {
    const device = { category: 'Power Distribution' };
    expect(roleOf({ role: 'relay_panel', category: 'Power Distribution' }, device)).toBe('relay_panel');
    expect(roleOf({ role: null, category: 'NSPS' }, device)).toBe('nsps');
    expect(roleOf({ role: 'bogus', category: 'Station' }, device)).toBe('station');
    expect(roleOf(null, device)).toBe('other');
    expect(roleOf(null, { category: 'EBDK' })).toBe('ebdk');
    expect(roleOf(undefined, null)).toBe('other');
    // a typed accessory with no category and no role leaves the device's category in charge
    expect(roleOf({ role: null, category: null }, { category: 'Sensor' })).toBe('sensor');
  });

  it('the rename table maps the five renamed master categories; canonicalCategory applies it', () => {
    expect(Object.keys(MASTER_CATEGORY_RENAME).sort()).toEqual(['EBDK', 'Equipment rack', 'Foundry panel', 'NSPS', 'Relay panel']);
    for (const to of Object.values(MASTER_CATEGORY_RENAME)) expect(DEVICE_CATEGORIES).toContain(to);
    expect(canonicalCategory('Relay panel')).toBe('Power Distribution');
    expect(canonicalCategory('Foundry panel')).toBe('Power Distribution');
    expect(canonicalCategory('Station')).toBe('Station');
    expect(canonicalCategory('Custom thing')).toBe('Custom thing');
    expect(canonicalCategory(null)).toBeNull();
    expect(canonicalCategory('')).toBeNull();
  });

  it('ID scheme follows the role; the tag helpers take a role or a category', () => {
    expect(defaultIdSchemeForRole('station')).toBe('level_tag');
    expect(defaultIdSchemeForRole('sensor')).toBe('level_tag');
    expect(defaultIdSchemeForRole('nsps')).toBe('level_number');
    expect(defaultIdSchemeForRole('other')).toBe('level_number');
    expect(defaultIdScheme('Station')).toBe('level_tag');
    expect(defaultIdScheme('Power Distribution')).toBe('level_number');
    expect(tagDeviceId('01', 'station', '15')).toBe('01-S15');
    expect(tagDeviceId('B2', 'sensor', '1')).toBe('B2-D1');
    expect(() => tagDeviceId('01', 'sensor', 'S15')).toThrow(/A Sensor tag starts with D/);
    expect(() => tagDeviceId('03', 'other', '2')).toThrow(/needs its letter for a device/);
    expect(() => tagDeviceId('03', 'Lighting Console', '2')).toThrow(/needs its letter for a Lighting Console/);
  });

  it('the Punch List Device text reads the role when given, else the category', () => {
    const rack = { display_id: '06M-05', device: 'Equipment Rack 18U', category: 'Equipment Panels', room_location: 'IDF 6M' };
    expect(defaultDeviceText(rack)).toBe('Equipment Rack 18U');
    // an NSPS whose category is the D196 `Equipment`: its type's role names it alone
    const nsps = { display_id: '06M-04', device: 'P-NSPS-D-KIT', category: 'Equipment', room_location: 'IDF 6M' };
    expect(defaultDeviceText({ ...nsps, role: 'nsps' })).toBe('P-NSPS-D-KIT');
    expect(defaultDeviceText(nsps)).toBe('P-NSPS-D-KIT - IDF 6M'); // no type: the room follows
    const ebdk = { display_id: '06M-03', device: 'EBDK', category: 'Emergency Equipment', panel_name: 'CT06LCPB' };
    expect(defaultDeviceText(ebdk)).toBe('EBDK (CT06LCPB)');
    expect(defaultDeviceText({ ...ebdk, role: 'other' })).toBe('EBDK');
    const ufmp = { display_id: '01-08', device: 'UFMP4', category: 'Power Distribution', room_location: 'BH OBS RM 47' };
    expect(defaultDeviceText({ ...ufmp, role: 'foundry_panel' })).toBe('UFMP4 - BH OBS RM 47');
    expect(defaultDeviceText({ ...ufmp, role: 'relay_panel' })).toBe('UFMP4');
  });
});
