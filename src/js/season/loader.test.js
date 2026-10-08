import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, SCHEDULE_TTL_MS, MAX_ASSET_BYTES, RETRY_MS } from './loader.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const THEME = {
    id: 'hw', colors: { bg: '#000000' }, orbiter: 'bat.svg',
    header: {}, lantern: {},
};
const SCHEDULE = { version: 1, entries: [{ theme: 'hw', from: '2026-10-07', to: '2026-10-31' }] };

function memoryStorage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        key: i => [...m.keys()][i] ?? null,
        get length() { return m.size; },
    };
}

// files: { url: string | Uint8Array | Error }
function fakeFetch(files, calls = []) {
    return async url => {
        calls.push(url);
        const f = files[url];
        if (f === undefined) return { ok: false, status: 404 };
        if (f instanceof Error) throw f;
        const bytes = typeof f === 'string' ? new TextEncoder().encode(f) : f;
        return {
            ok: true, status: 200,
            json: async () => JSON.parse(new TextDecoder().decode(bytes)),
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
    };
}

const R = 'https://r/';
const F = 'fb/';
const remote = {
    [`${R}schedule.json`]: JSON.stringify(SCHEDULE),
    [`${R}hw/theme.json`]: JSON.stringify(THEME),
    [`${R}hw/bat.svg`]: SVG,
};

test('refreshSchedule fetches remote and caches it', async () => {
    const storage = memoryStorage();
    const l = createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F, now: () => 1000 });
    assert.deepEqual(await l.refreshSchedule(), SCHEDULE.entries);
    assert.deepEqual(l.cachedSchedule(), SCHEDULE.entries);
    assert.equal(l.scheduleIsStale(), false);
});

test('schedule becomes stale after the TTL', async () => {
    let t = 1000;
    const l = createLoader({ fetchFn: fakeFetch(remote), storage: memoryStorage(), baseUrl: R, fallbackUrl: F, now: () => t });
    await l.refreshSchedule();
    t += SCHEDULE_TTL_MS + 1;
    assert.equal(l.scheduleIsStale(), true);
});

test('network failure keeps the cached schedule', async () => {
    const storage = memoryStorage();
    await createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F }).refreshSchedule();
    const offline = createLoader({ fetchFn: fakeFetch({ [`${R}schedule.json`]: new Error('offline') }), storage, baseUrl: R, fallbackUrl: F });
    assert.deepEqual(await offline.refreshSchedule(), SCHEDULE.entries);
});

test('no cache + no network → bundled fallback, not cached as fresh', async () => {
    const storage = memoryStorage();
    const files = { [`${F}schedule.json`]: JSON.stringify(SCHEDULE) };
    const l = createLoader({ fetchFn: fakeFetch(files), storage, baseUrl: R, fallbackUrl: F });
    assert.deepEqual(await l.refreshSchedule(), SCHEDULE.entries);
    assert.equal(l.scheduleIsStale(), true);
});

test('loadTheme converts assets to data URLs and caches', async () => {
    const storage = memoryStorage();
    const l = createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F });
    const t = await l.loadTheme('hw');
    assert.match(t.assets['bat.svg'], /^data:image\/svg\+xml;base64,/);
    assert.equal(l.cachedTheme('hw').colors.bg, '#000000');
});

test('invalid theme.json → null', async () => {
    const files = { ...remote, [`${R}hw/theme.json`]: JSON.stringify({ id: 'other' }) };
    const l = createLoader({ fetchFn: fakeFetch(files), storage: memoryStorage(), baseUrl: R, fallbackUrl: F });
    assert.equal(await l.loadTheme('hw'), null);
});

test('oversized asset rejects the remote theme, falls back to bundle', async () => {
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    const files = {
        ...remote, [`${R}hw/bat.svg`]: big,
        [`${F}hw/theme.json`]: JSON.stringify(THEME), [`${F}hw/bat.svg`]: SVG,
    };
    const l = createLoader({ fetchFn: fakeFetch(files), storage: memoryStorage(), baseUrl: R, fallbackUrl: F });
    const t = await l.loadTheme('hw');
    assert.match(t.assets['bat.svg'], /^data:image\/svg\+xml/);
});

test('missing asset → theme fails (no half-loaded theme)', async () => {
    const files = { ...remote };
    delete files[`${R}hw/bat.svg`];
    const l = createLoader({ fetchFn: fakeFetch(files), storage: memoryStorage(), baseUrl: R, fallbackUrl: F });
    assert.equal(await l.loadTheme('hw'), null);
});

test('storage that throws does not break loading', async () => {
    const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() {}, key: () => null, length: 0 };
    const l = createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F });
    assert.deepEqual(await l.refreshSchedule(), SCHEDULE.entries);
    assert.ok(await l.loadTheme('hw'));
    // Served from memory so a blocked storage does not mean a refetch every minute
    assert.equal(l.cachedTheme('hw').colors.bg, '#000000');
    assert.equal(l.themeIsStale('hw'), false);
    assert.deepEqual(l.cachedSchedule(), SCHEDULE.entries);
});

test('stale theme is refetched', async () => {
    let t = 1000;
    const storage = memoryStorage();
    const l = createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F, now: () => t });
    await l.loadTheme('hw');
    assert.equal(l.themeIsStale('hw'), false);
    t += SCHEDULE_TTL_MS + 1;
    assert.equal(l.themeIsStale('hw'), true);
});

test('pruneThemes removes themes not kept', async () => {
    const storage = memoryStorage();
    const l = createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F });
    await l.loadTheme('hw');
    l.pruneThemes([]);
    assert.equal(l.cachedTheme('hw'), null);
});

test('hung fetch times out and falls back to the bundle', { timeout: 3000 }, async () => {
    const files = { [`${F}schedule.json`]: JSON.stringify(SCHEDULE) };
    const base = fakeFetch(files);
    const fetchFn = url => (url.startsWith(R) ? new Promise(() => {}) : base(url));
    const l = createLoader({ fetchFn, storage: memoryStorage(), baseUrl: R, fallbackUrl: F, timeoutMs: 50 });
    assert.deepEqual(await l.refreshSchedule(), SCHEDULE.entries);
});

test('bundledSchedule reads only the bundle', async () => {
    const calls = [];
    const files = { ...remote, [`${F}schedule.json`]: JSON.stringify(SCHEDULE) };
    const l = createLoader({ fetchFn: fakeFetch(files, calls), storage: memoryStorage(), baseUrl: R, fallbackUrl: F });
    assert.deepEqual(await l.bundledSchedule(), SCHEDULE.entries);
    assert.deepEqual(calls, [`${F}schedule.json`]);
});

test('offline keeps the downloaded theme; the bundle does not overwrite it', async () => {
    let t = 1000;
    const storage = memoryStorage();
    await createLoader({ fetchFn: fakeFetch(remote), storage, baseUrl: R, fallbackUrl: F, now: () => t }).loadTheme('hw');
    const bundledTheme = { ...THEME, colors: { bg: '#111111' } };
    const offline = createLoader({
        fetchFn: fakeFetch({ [`${F}hw/theme.json`]: JSON.stringify(bundledTheme), [`${F}hw/bat.svg`]: SVG }),
        storage, baseUrl: R, fallbackUrl: F, now: () => t,
    });
    t += SCHEDULE_TTL_MS + 1;
    const got = await offline.loadTheme('hw');
    assert.equal(got.colors.bg, '#000000');
    assert.equal(offline.cachedTheme('hw').colors.bg, '#000000');
});

test('bundled theme is cached as stale so remote is retried', async () => {
    const files = { [`${F}hw/theme.json`]: JSON.stringify(THEME), [`${F}hw/bat.svg`]: SVG };
    const l = createLoader({ fetchFn: fakeFetch(files), storage: memoryStorage(), baseUrl: R, fallbackUrl: F, now: () => 5000 });
    assert.ok(await l.loadTheme('hw'));
    assert.equal(l.themeIsStale('hw'), true);
});

test('a failed load is not retried within the retry window', async () => {
    let t = 1000;
    const calls = [];
    const files = { [`${R}hw/theme.json`]: JSON.stringify({ id: 'nope' }) };
    const l = createLoader({ fetchFn: fakeFetch(files, calls), storage: memoryStorage(), baseUrl: R, fallbackUrl: F, now: () => t });
    assert.equal(await l.loadTheme('hw'), null);
    const after1 = calls.length;
    assert.equal(await l.loadTheme('hw'), null);
    assert.equal(calls.length, after1);
    t += RETRY_MS + 1;
    await l.loadTheme('hw');
    assert.ok(calls.length > after1);
});
