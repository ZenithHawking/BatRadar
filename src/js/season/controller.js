// Decides which theme a window shows and when to change it. No DOM and no
// network of its own: the loader, apply/clear and the clock are injected, so
// every timing case runs under node:test.
import { activeThemeId } from './schedule.js';

// Everything except bookkeeping fields — equal content means nothing to redraw
const contentKey = t => JSON.stringify({ ...t, fetchedAt: undefined, stale: undefined });

export function createSeason({ loader, apply, clear, now = () => new Date() }) {
    let cfg = { seasonal_theme: true, theme_preview: null };
    let applied = null; // { id, key }
    let generation = 0; // bumped by settings changes; stale runs drop their result
    let running = null;
    let rerun = false;

    async function wantedId() {
        if (cfg.seasonal_theme === false) return null;
        if (cfg.theme_preview) return cfg.theme_preview;
        // Never wait on the network here — refreshRemote fetches the schedule
        const entries = loader.cachedSchedule() ?? (await loader.bundledSchedule());
        return entries ? activeThemeId(entries, now()) : null;
    }

    function show(id, theme) {
        const key = contentKey(theme);
        if (applied && applied.id === id && applied.key === key) return;
        apply(theme);
        applied = { id, key };
    }

    function drop() {
        if (!applied) return;
        clear();
        applied = null;
    }

    async function runOnce() {
        const gen = generation;
        const id = await wantedId();
        if (gen !== generation) return;
        if (!id) return drop();

        const cached = loader.cachedTheme(id);
        if (cached) show(id, cached);
        if (cached && !loader.themeIsStale(id)) return;

        const fresh = await loader.loadTheme(id);
        if (gen !== generation) return;
        if (fresh) show(id, fresh);
        // The wanted theme is unavailable — don't keep showing a previous one
        else if (applied && applied.id !== id) drop();
    }

    function sync() {
        if (running) {
            rerun = true;
            return running;
        }
        running = (async () => {
            try {
                do {
                    rerun = false;
                    await runOnce();
                } while (rerun);
            } finally {
                running = null;
            }
        })();
        return running;
    }

    async function refreshRemote() {
        if (!loader.scheduleIsStale()) return;
        const { entries, remote } = await loader.refreshScheduleDetailed();
        if (!remote) return;
        if (entries) loader.pruneThemes([...new Set(entries.map(e => e.theme)), cfg.theme_preview].filter(Boolean));
        await sync();
    }

    function setConfig(next) {
        cfg = { ...cfg, ...next };
        generation++;
        // A run in flight is invalidated by the generation bump; this one replaces it
        rerun = true;
        return sync();
    }

    return {
        sync,
        refreshRemote,
        setConfig,
        get appliedId() { return applied?.id ?? null; },
    };
}
