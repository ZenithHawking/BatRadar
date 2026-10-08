// Fetches the schedule and themes, caches them in localStorage. Every
// dependency is injected so the logic runs under node:test.
import { parseSchedule } from './schedule.js';
import { validateTheme, assetNames } from './validate.js';

export const BASE_URL = 'https://raw.githubusercontent.com/ZenithHawking/BatRadar/main/themes/';
export const FALLBACK_URL = 'themes/';
export const SCHEDULE_TTL_MS = 6 * 3600 * 1000;
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

export function createLoader({ fetchFn, storage, now = () => Date.now(), baseUrl = BASE_URL, fallbackUrl = FALLBACK_URL }) {
    // localStorage can throw (blocked, quota) — the theme must still work without it
    const read = key => { try { const v = storage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } };
    const write = (key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch { /* not cached */ } };
    const remove = key => { try { storage.removeItem(key); } catch { /* ignore */ } };

    async function getJson(url) {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return res.json();
    }

    async function fetchSchedule(base) {
        try { return parseSchedule(await getJson(`${base}schedule.json`)); } catch { return null; }
    }

    async function fetchTheme(base, id) {
        try {
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
            return { ...theme, assets, fetchedAt: now() };
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
        async refreshSchedule() {
            const remoteEntries = await fetchSchedule(baseUrl);
            if (remoteEntries) {
                write(SCHEDULE_KEY, { fetchedAt: now(), entries: remoteEntries });
                return remoteEntries;
            }
            // Bundled copy is not written to the cache, so the next cycle retries remote
            return read(SCHEDULE_KEY)?.entries ?? (await fetchSchedule(fallbackUrl));
        },
        cachedTheme: id => read(THEME_PREFIX + id),
        themeIsStale(id) {
            const c = read(THEME_PREFIX + id);
            return !c || now() - c.fetchedAt > SCHEDULE_TTL_MS;
        },
        async loadTheme(id) {
            const theme = (await fetchTheme(baseUrl, id)) ?? (await fetchTheme(fallbackUrl, id));
            if (theme) write(THEME_PREFIX + id, theme);
            return theme;
        },
        pruneThemes(keepIds) {
            const keys = [];
            try { for (let i = 0; i < storage.length; i++) keys.push(storage.key(i)); } catch { return; }
            for (const k of keys) if (k?.startsWith(THEME_PREFIX) && !keepIds.includes(k.slice(THEME_PREFIX.length))) remove(k);
        },
    };
}
