// Season lifecycle for one window: wires the loader and DOM layer into the
// controller, keeps it ticking, reacts to the Settings toggle.
// Loaded by index.html and floating.html.
import { invoke, listen } from '../utils.js';
import { createLoader } from './loader.js';
import { createSeason } from './controller.js';
import { applyTheme, clearTheme } from './apply.js';

const page = document.getElementById('floating-icon') ? 'floating' : 'dashboard';

// Merely reading window.localStorage throws when storage is blocked; the
// loader keeps an in-memory copy, so an inert store is enough here
function safeStorage() {
    try { return window.localStorage; } catch {
        return { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
    }
}

const loader = createLoader({ fetchFn: url => fetch(url, { cache: 'no-store' }), storage: safeStorage() });
const season = createSeason({ loader, apply: theme => applyTheme(theme, page), clear: clearTheme });

(async () => {
    try { await season.setConfig(await invoke('load_settings')); } catch { await season.sync(); }
    season.refreshRemote();
    setInterval(() => season.sync(), 60 * 1000);
    // Fetches only once the 6 h TTL has expired; the short tick catches up fast after sleep
    setInterval(() => season.refreshRemote(), 15 * 60 * 1000);
    listen('settings-changed', ({ payload }) => season.setConfig(payload));
})();
