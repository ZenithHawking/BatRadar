import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeason } from './controller.js';

const HW = { theme: 'hw', from: '2026-10-07', to: '2026-10-31' };
const NOEL = { theme: 'noel', from: '2026-11-01', to: '2026-11-30' };
const theme = (id, fetchedAt = 1, extra = {}) => ({ id, colors: {}, assets: {}, fetchedAt, ...extra });

// In-memory stand-in for createLoader; loadTheme can be held open with `gate`.
function fakeLoader({ cachedEntries = null, bundled = [HW], cached = {}, remote = {}, remoteSchedule = null } = {}) {
    const calls = { loadTheme: [], refresh: 0, bundled: 0 };
    let gate = null;
    const l = {
        calls,
        hold() { let release; gate = new Promise(r => { release = r; }); return () => { gate = null; release(); }; },
        cachedSchedule: () => cachedEntries,
        scheduleIsStale: () => true,
        bundledSchedule: async () => { calls.bundled++; return bundled; },
        refreshScheduleDetailed: async () => {
            calls.refresh++;
            if (remoteSchedule) { cachedEntries = remoteSchedule; return { entries: remoteSchedule, remote: true }; }
            return { entries: cachedEntries ?? bundled, remote: false };
        },
        cachedTheme: id => cached[id] ?? null,
        themeIsStale: id => !cached[id],
        loadTheme: async id => {
            calls.loadTheme.push(id);
            if (gate) await gate;
            const t = remote[id] ?? null;
            if (t) cached[id] = t;
            return t ?? cached[id] ?? null;
        },
        pruneThemes() {},
    };
    return l;
}

function recorder() {
    const log = [];
    return { log, apply: t => log.push(`apply:${t.id}`), clear: () => log.push('clear') };
}

const at = (y, m, d) => () => new Date(y, m - 1, d, 12);

test('first run without a cached schedule uses the bundle immediately', async () => {
    const loader = fakeLoader({ remote: { hw: theme('hw') } });
    const r = recorder();
    const s = createSeason({ loader, ...r, now: at(2026, 10, 10) });
    await s.sync();
    assert.equal(loader.calls.bundled, 1);
    assert.equal(loader.calls.refresh, 0);
    assert.deepEqual(r.log, ['apply:hw']);
});

test('theme disappears after its last day', async () => {
    let now = at(2026, 10, 31);
    const loader = fakeLoader({ cachedEntries: [HW], cached: { hw: theme('hw') } });
    const r = recorder();
    const s = createSeason({ loader, ...r, now: () => now() });
    await s.sync();
    now = at(2026, 11, 1);
    await s.sync();
    assert.deepEqual(r.log, ['apply:hw', 'clear']);
    assert.equal(s.appliedId, null);
});

test('next theme that cannot load does not leave the old one up', async () => {
    let now = at(2026, 10, 31);
    const loader = fakeLoader({ cachedEntries: [HW, NOEL], cached: { hw: theme('hw') } });
    const r = recorder();
    const s = createSeason({ loader, ...r, now: () => now() });
    await s.sync();
    now = at(2026, 11, 2);
    await s.sync();
    assert.deepEqual(r.log, ['apply:hw', 'clear']);
    assert.equal(s.appliedId, null);
});

test('turning the toggle off during an in-flight load wins', async () => {
    const loader = fakeLoader({ cachedEntries: [HW], remote: { hw: theme('hw') } });
    const r = recorder();
    const s = createSeason({ loader, ...r, now: at(2026, 10, 10) });
    const release = loader.hold();
    const first = s.sync();
    await new Promise(res => setTimeout(res, 0));
    const toggled = s.setConfig({ seasonal_theme: false });
    release();
    await first;
    await toggled;
    assert.equal(s.appliedId, null);
    assert.ok(!r.log.includes('apply:hw') || r.log.at(-1) === 'clear');
});

test('a sync requested while one is running runs afterwards', async () => {
    let now = at(2026, 10, 10);
    const loader = fakeLoader({ cachedEntries: [HW, NOEL], remote: { hw: theme('hw'), noel: theme('noel') } });
    const r = recorder();
    const s = createSeason({ loader, ...r, now: () => now() });
    const release = loader.hold();
    const first = s.sync();
    await new Promise(res => setTimeout(res, 0));
    now = at(2026, 11, 5);
    const second = s.sync();
    release();
    await first;
    await second;
    assert.equal(s.appliedId, 'noel');
});

test('refetching identical content does not rebuild the decorations', async () => {
    const loader = fakeLoader({ cachedEntries: [HW], cached: { hw: theme('hw', 1) }, remote: { hw: theme('hw', 2) } });
    loader.themeIsStale = () => true;
    const r = recorder();
    const s = createSeason({ loader, ...r, now: at(2026, 10, 10) });
    await s.sync();
    await s.sync();
    assert.deepEqual(r.log, ['apply:hw']);
});

test('refetching changed content re-applies it', async () => {
    const loader = fakeLoader({ cachedEntries: [HW], cached: { hw: theme('hw', 1) }, remote: { hw: theme('hw', 2, { colors: { bg: '#111111' } }) } });
    loader.themeIsStale = () => true;
    const r = recorder();
    const s = createSeason({ loader, ...r, now: at(2026, 10, 10) });
    await s.sync();
    assert.deepEqual(r.log, ['apply:hw', 'apply:hw']);
});

test('refreshRemote only re-syncs when the remote schedule actually arrived', async () => {
    const offline = fakeLoader({ cachedEntries: [HW], cached: { hw: theme('hw') } });
    const r1 = recorder();
    const s1 = createSeason({ loader: offline, ...r1, now: at(2026, 10, 10) });
    await s1.sync();
    await s1.refreshRemote();
    assert.deepEqual(r1.log, ['apply:hw']);

    const online = fakeLoader({ cachedEntries: [], remoteSchedule: [HW], cached: { hw: theme('hw') } });
    const r2 = recorder();
    const s2 = createSeason({ loader: online, ...r2, now: at(2026, 10, 10) });
    await s2.sync();
    await s2.refreshRemote();
    assert.deepEqual(r2.log, ['apply:hw']);
});
