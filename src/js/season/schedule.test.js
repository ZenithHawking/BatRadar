import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, activeThemeId, localDateKey } from './schedule.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);
const HW = { theme: 'halloween-bi-ngo', from: '2026-10-07', to: '2026-10-31' };

test('localDateKey pads month and day', () => {
    assert.equal(localDateKey(at(2026, 1, 5)), '2026-01-05');
});

test('parseSchedule rejects unknown version and non-arrays', () => {
    assert.equal(parseSchedule({ version: 2, entries: [HW] }), null);
    assert.equal(parseSchedule({ version: 1, entries: 'x' }), null);
    assert.equal(parseSchedule(null), null);
});

test('parseSchedule drops malformed entries, keeps good ones', () => {
    const out = parseSchedule({ version: 1, entries: [
        HW,
        { theme: '../evil', from: '2026-10-01', to: '2026-10-02' },
        { theme: 'x', from: '2026-13-01', to: '2026-10-02' },
        { theme: 'x', from: '2026-10-05', to: '2026-10-01' },
        { theme: 'x' },
        null,
    ] });
    assert.deepEqual(out, [HW]);
});

test('active on both inclusive ends, inactive outside', () => {
    const e = [HW];
    assert.equal(activeThemeId(e, at(2026, 10, 7, 0)), 'halloween-bi-ngo');
    assert.equal(activeThemeId(e, at(2026, 10, 31, 23)), 'halloween-bi-ngo');
    assert.equal(activeThemeId(e, at(2026, 11, 1, 0)), null);
    assert.equal(activeThemeId(e, at(2026, 10, 6, 23)), null);
});

test('later entry wins on overlap', () => {
    const e = [
        { theme: 'winter', from: '2027-01-01', to: '2027-02-28' },
        { theme: 'tet', from: '2027-02-01', to: '2027-02-14' },
    ];
    assert.equal(activeThemeId(e, at(2027, 2, 10)), 'tet');
    assert.equal(activeThemeId(e, at(2027, 2, 20)), 'winter');
});

test('no entries → null', () => {
    assert.equal(activeThemeId([], at(2026, 10, 10)), null);
});
