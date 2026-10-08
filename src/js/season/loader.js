// Fetches the schedule and themes, caches them in localStorage. Every
// dependency is injected so the logic runs under node:test.
import { parseSchedule } from './schedule.js';
import { validateTheme, assetNames } from './validate.js';

export const BASE_URL = 'https://raw.githubusercontent.com/ZenithHawking/BatRadar/main/themes/';
export const FALLBACK_URL = 'themes/';
export const SCHEDULE_TTL_MS = 6 * 3600 * 1000;
export const RETRY_MS = 15 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 10 * 1000;
export const MAX_ASSET_BYTES = 100 * 1024;
export const MAX_THEME_BYTES = 600 * 1024;

const SCHEDULE_KEY = 'season:schedule';
const THEME_PREFIX = 'season:theme:';
const MIME = { svg: 'image/svg+xml', png: 'image/png' };

function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function createLoader({
    fetchFn, storage, now = () => Date.now(),
    baseUrl = BASE_URL, fallbackUrl = FALLBACK_URL, timeoutMs = FETCH_TIMEOUT_MS,
}) {
    // localStorage can throw (blocked, quota). An in-memory copy keeps the
    // theme working — and stops a refetch every minute — when it does.
    const mem = new Map();
    const read = key => {
        try {
            const v = storage.getItem(key);
            if (v) return JSON.parse(v);
        } catch { /* fall through to memory */ }
        return mem.get(key) ?? null;
    };
    const write = (key, value) => {
        mem.set(key, value);
        try { storage.setItem(key, JSON.stringify(value)); } catch { /* memory only */ }
    };
    const remove = key => {
        mem.delete(key);
        try { storage.removeItem(key); } catch { /* ignore */ }
    };
    const failedAt = new Map();

    // A connection a proxy holds open without answering must not stall the
    // caller forever — the bundled copy and the date checks depend on it.
    function timed(promise) {
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    async function getJson(url) {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return res.json();
    }

    async function fetchSchedule(base) {
        try { return parseSchedule(await timed(getJson(`${base}schedule.json`))); } catch { return null; }
    }

    async function fetchTheme(base, id) {
        try {
            return await timed((async () => {
                const theme = validateTheme(await getJson(`${base}${id}/theme.json`), id);
                if (!theme) return null;
                const assets = {};
                let total = 0;
                for (const name of assetNames(theme)) {
                    const res = await fetchFn(`${base}${id}/${name}`);
                    if (!res.ok) return null;
                    const bytes = new Uint8Array(await res.arrayBuffer());
                    total += bytes.length;
                    if (bytes.length > MAX_ASSET_BYTES || total > MAX_THEME_BYTES) return null;
                    assets[name] = `data:${MIME[name.split('.').pop()]};base64,${toBase64(bytes)}`;
                }
                return { ...theme, assets };
            })());
        } catch {
            return null;
        }
    }

    return {
        cachedSchedule: () => read(SCHEDULE_KEY)?.entries ?? null,
        scheduleIsStale() {
            const c = read(SCHEDULE_KEY);
            return !c || now() - c.fetchedAt > SCHEDULE_TTL_MS;
        },
        bundledSchedule: () => fetchSchedule(fallbackUrl),
        /** Remote → cache. Returns { entries, remote } so callers know whether anything new arrived. */
        async refreshScheduleDetailed() {
            const remoteEntries = await fetchSchedule(baseUrl);
            if (remoteEntries) {
                write(SCHEDULE_KEY, { fetchedAt: now(), entries: remoteEntries });
                return { entries: remoteEntries, remote: true };
            }
            // The bundled copy is never cached, so the next cycle retries remote
            const entries = read(SCHEDULE_KEY)?.entries ?? (await fetchSchedule(fallbackUrl));
            return { entries, remote: false };
        },
        async refreshSchedule() {
            return (await this.refreshScheduleDetailed()).entries;
        },
        cachedTheme: id => read(THEME_PREFIX + id),
        themeIsStale(id) {
            const c = read(THEME_PREFIX + id);
            return !c || c.stale === true || now() - c.fetchedAt > SCHEDULE_TTL_MS;
        },
        /**
         * Remote copy if reachable. Otherwise keep whatever was downloaded before;
         * the bundled copy is only a last resort and is stored as already stale.
         * A failed id is not retried for RETRY_MS, so a broken theme push does not
         * make every client re-download it every minute.
         */
        async loadTheme(id) {
            const last = failedAt.get(id);
            if (last !== undefined && now() - last < RETRY_MS) return read(THEME_PREFIX + id);
            const remoteTheme = await fetchTheme(baseUrl, id);
            if (remoteTheme) {
                failedAt.delete(id);
                const theme = { ...remoteTheme, fetchedAt: now() };
                write(THEME_PREFIX + id, theme);
                return theme;
            }
            failedAt.set(id, now());
            const cached = read(THEME_PREFIX + id);
            if (cached) return cached;
            const bundled = await fetchTheme(fallbackUrl, id);
            if (!bundled) return null;
            const theme = { ...bundled, fetchedAt: now(), stale: true };
            write(THEME_PREFIX + id, theme);
            return theme;
        },
        pruneThemes(keepIds) {
            const keys = new Set([...mem.keys()]);
            try { for (let i = 0; i < storage.length; i++) keys.add(storage.key(i)); } catch { /* memory keys only */ }
            for (const k of keys) if (k?.startsWith(THEME_PREFIX) && !keepIds.includes(k.slice(THEME_PREFIX.length))) remove(k);
        },
    };
}
