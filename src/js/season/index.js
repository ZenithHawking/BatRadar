// Season lifecycle for one window: pick the theme for today, keep it current,
// react to the Settings toggle. Loaded by index.html and floating.html.
import { invoke, listen } from '../utils.js';
import { createLoader } from './loader.js';
import { activeThemeId } from './schedule.js';
import { applyTheme, clearTheme } from './apply.js';

const page = document.getElementById('floating-icon') ? 'floating' : 'dashboard';
const loader = createLoader({ fetchFn: url => fetch(url, { cache: 'no-store' }), storage: window.localStorage });
let cfg = { seasonal_theme: true, theme_preview: null };
let appliedId = null;
let busy = false;

async function wantedId() {
    if (cfg.seasonal_theme === false) return null;
    if (cfg.theme_preview) return cfg.theme_preview;
    const entries = loader.cachedSchedule() ?? (await loader.refreshSchedule());
    return entries ? activeThemeId(entries, new Date()) : null;
}

async function sync({ refetch = false } = {}) {
    if (busy) return;
    busy = true;
    try {
        const id = await wantedId();
        if (!id) {
            if (appliedId) clearTheme();
            appliedId = null;
            return;
        }
        // Cached copy first so the page never flashes the plain look
        const cached = id === appliedId && !refetch ? null : loader.cachedTheme(id);
        if (cached && id !== appliedId) { applyTheme(cached, page); appliedId = id; }
        if (!loader.cachedTheme(id) || loader.themeIsStale(id) || refetch) {
            const fresh = await loader.loadTheme(id);
            if (fresh) { applyTheme(fresh, page); appliedId = id; }
        }
    } finally {
        busy = false;
    }
}

async function refreshRemote() {
    if (!loader.scheduleIsStale()) return;
    const entries = await loader.refreshSchedule();
    if (entries) loader.pruneThemes([...new Set(entries.map(e => e.theme)), cfg.theme_preview].filter(Boolean));
    await sync({ refetch: true });
}

(async () => {
    try { cfg = { ...cfg, ...(await invoke('load_settings')) }; } catch { /* keep defaults */ }
    await sync();
    refreshRemote();
    setInterval(sync, 60 * 1000);
    // Fetches only once the 6 h TTL has expired; the short tick catches up fast after sleep
    setInterval(refreshRemote, 15 * 60 * 1000);
    listen('settings-changed', ({ payload }) => {
        cfg = { ...cfg, ...payload };
        // Drop the current look first; sync re-applies it if it is still wanted
        clearTheme();
        appliedId = null;
        sync();
    });
})();
