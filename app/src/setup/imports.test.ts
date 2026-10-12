import { describe, expect, it } from 'vitest';

import { fieldLabel, initialMapping, isFinished, jobLine, overrides, unmatched, type ImportPreview } from './imports';

const preview: ImportPreview = {
  name: 'Floor_06.xlsx',
  levels: ['06'],
  images: 0,
  checks: [],
  tabs: [
    {
      tab: 'Devices',
      found: true,
      rows: 3,
      headers: ['Level', 'ID', 'Room', 'Status'],
      fields: [
        { field: 'level', default: 'Level', header: 'Level' },
        { field: 'display_id', default: 'ID', header: 'ID' },
        { field: 'room_location', default: 'Room / Location', header: null },
        { field: 'status', default: 'Status', header: 'Status' },
      ],
    },
    { tab: 'Change Log', found: false, rows: 0, headers: [], fields: [] },
  ],
};

describe('column mapping (T28)', () => {
  it('starts from the server matches and leaves absent tabs out', () => {
    expect(initialMapping(preview)).toEqual({ Devices: { level: 'Level', display_id: 'ID', room_location: '', status: 'Status' } });
  });

  it('sends nothing while the mapping is the defaults, and only the differences once changed', () => {
    expect(overrides(preview, initialMapping(preview))).toEqual({});
    const chosen = initialMapping(preview);
    chosen.Devices!.room_location = 'Room';
    chosen.Devices!.status = '';
    expect(overrides(preview, chosen)).toEqual({ Devices: { room_location: 'Room', status: '' } });
  });

  it('lists the fields still unmatched', () => {
    expect(unmatched(preview, initialMapping(preview))).toEqual([{ tab: 'Devices', field: 'room_location' }]);
    const chosen = initialMapping(preview);
    chosen.Devices!.room_location = 'Room';
    expect(unmatched(preview, chosen)).toEqual([]);
  });

  it('labels fields and job states', () => {
    expect(fieldLabel('room_location')).toBe('Room / Location');
    expect(fieldLabel('notes')).toBe('Notes');
    expect(isFinished('running')).toBe(false);
    expect(isFinished('skipped')).toBe(true);
    expect(jobLine({ id: 'x', job_state: 'failed', stats: { error: 'tab missing' } })).toBe('Failed: tab missing');
  });
});
