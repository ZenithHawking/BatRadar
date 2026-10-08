# Seasonal Themes + Tauri 0.4.0 Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship BatRadar 0.4.0 on Tauri with a remotely scheduled seasonal-theme system (first theme: Halloween, 2026-10-07 → 2026-10-31), updater UX parity, four bug fixes, and an automatic Electron → Tauri migration; then remove Electron from the repo.

**Architecture:** The theme engine runs in the renderer (plain ES modules under `src/js/season/`). It fetches `themes/schedule.json` and `themes/<id>/theme.json` + SVG assets from `raw.githubusercontent.com`, validates them, caches them (assets as `data:` URLs) in `localStorage`, and applies whitelisted colours/decorations to the dashboard and floating icon. A bundled copy under `src/themes/` is the offline fallback. Rust gains two config fields, a `settings-changed` event, updater commands, and the bug fixes. A NSIS installer hook uninstalls the old Electron app; `latest.yml` points Electron's updater at the Tauri installer.

**Tech Stack:** Tauri 2 (Rust), vanilla JS ES modules, `node:test` (Node 18+), NSIS hooks, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-07-seasonal-themes-design.md`

## Global Constraints

- Halloween schedule entry: `{ "theme": "halloween-bi-ngo", "from": "2026-10-07", "to": "2026-10-31" }`, dates inclusive, local time.
- Theme base URL: `https://raw.githubusercontent.com/ZenithHawking/BatRadar/main/themes/`
- Schedule refresh: on start + every 6 h (`SCHEDULE_TTL_MS = 6 * 3600 * 1000`). Date re-check every 60 s.
- Limits: each asset ≤ 100 KB, each theme ≤ 600 KB total.
- Validation: colours `^#[0-9a-fA-F]{6}$`; asset names `^[a-z0-9-]+\.(svg|png)$`; theme id `^[a-z0-9-]{1,40}$` and equals its folder; `particles.type` ∈ `rise|fall|drift`; `label` ≤ 24 chars, inserted with `textContent`; schedule `version` must be `1`.
- Never load remote CSS or JS. Remote images only via `<img src="data:…">`.
- Usage-level colours (green/yellow/orange/red ring, `%` text, progress bars) are never themed.
- The floating page must never get a themed `body`/`html` background.
- `prefers-reduced-motion: reduce` stops all season animations.
- Config: `seasonal_theme: bool` (default `true`), `theme_preview: Option<String>` (no UI).
- Version `0.4.0` in `Cargo.toml`, `tauri.conf.json`, `package.json`.
- Electron uninstall: `%LOCALAPPDATA%\Programs\bat-radar\Uninstall BatRadar.exe` with `/currentuser /S`; delete HKCU Run value `com.batradar.app`.
- Updater auto-check: 30 s after start, then every 6 h; never installs without a click.
- No new npm or crate dependencies except `windows-sys` (for the topmost fix).
- UI copy in Vietnamese where the surrounding UI already is (settings rows, banner).

## Review Focus

1. **`localStorage` throws or is full** (private profile, quota): the theme still applies from the fetched data; nothing crashes. → test in Task 3 (`storage that throws`).
2. **A mascot with only some valid levels** (e.g. `critical` has a bad file name): showing nothing at that level would look broken — the whole `mascot` must be dropped so the icon falls back to the provider logo. → test in Task 2.
3. **Theme updated on GitHub under the same id** (colour fix mid-season): users must get it within ~6 h, not keep the first cached copy forever. → test in Task 3 (`stale theme is refetched`).
4. **Midnight rollover while the app runs** (31/10 → 01/11): theme must disappear without restarting. → test in Task 1 (`activeThemeId` with 2026-11-01 00:00) + 60 s re-check in Task 5.
5. **Electron updater launches the Tauri installer non-silently with `--updated --force-run`**: install must still complete, remove Electron, keep `%APPDATA%\batradar`. → manual check in Task 11.

---

## File Map

| File | Responsibility |
|---|---|
| `src/js/season/schedule.js` | Parse schedule JSON; pick active theme id for a date (pure) |
| `src/js/season/validate.js` | Whitelist-validate `theme.json`; list referenced assets (pure) |
| `src/js/season/loader.js` | Fetch + cache schedule/themes, assets → data URLs (deps injected) |
| `src/js/season/apply.js` | Add/remove DOM decorations + CSS vars for dashboard/floating |
| `src/js/season/index.js` | Lifecycle: config, timers, events; entry point loaded by pages |
| `src/js/season/*.test.js` | `node:test` suites |
| `src/css/season.css` | Generic effect styles driven by `--season-*` vars and `.season-*` classes |
| `themes/…`, `src/themes/…` | Halloween content (remote) + identical bundled fallback |
| `src-tauri/src/config.rs` | New fields, atomic save, no overwrite on parse error |
| `src-tauri/src/alerts.rs` | Pure alert-level decision (extracted from `main.rs`) |
| `src-tauri/src/updater.rs` | Auto-check loop, `check_update`, `install_update` |
| `src-tauri/src/main.rs` | Wiring, `settings-changed`, topmost fix |
| `src-tauri/windows/hooks.nsh` | Uninstall Electron before install |
| `scripts/release-manifests.mjs` | Write `latest.json` (Tauri) + `latest.yml` (Electron) |
| `.github/workflows/release.yml` | Tauri build + draft release |

---

### Task 0: Commit pending history-chart work, drop the spike

The working tree holds finished history-chart changes (`src/js/dashboard.js`, `src/css/dashboard.css`) and the throwaway Halloween spike (`src/js/season.js`, `src/css/theme-halloween.css`, two lines each in `src/index.html` / `src/floating.html`).

**Files:**
- Delete: `src/js/season.js`, `src/css/theme-halloween.css`
- Modify: `src/index.html`, `src/floating.html` (remove spike lines)

- [ ] **Step 1: Remove spike wiring**

In `src/index.html` and `src/floating.html` delete these lines:
```html
  <link rel="stylesheet" href="css/theme-halloween.css">
  <script type="module" src="js/season.js"></script>
```
Then: `git rm -q --cached src/js/season.js 2>/dev/null; rm src/js/season.js src/css/theme-halloween.css`

- [ ] **Step 2: Verify only chart changes remain**

Run: `git status --short`
Expected: ` M src/css/dashboard.css` and ` M src/js/dashboard.js` only.

- [ ] **Step 3: Commit**

```bash
git add src/css/dashboard.css src/js/dashboard.js
git commit -m "Dashboard history chart: time axis, 24h/7d/30d ranges, bucketed peaks, hover tooltip"
```

---

### Task 1: Schedule parsing and active-theme selection

**Files:**
- Create: `src/js/season/schedule.js`
- Test: `src/js/season/schedule.test.js`
- Modify: `package.json` (add `"test"` script)
- Create: `src/js/season/package.json`

**Interfaces:**
- Produces: `parseSchedule(raw) -> Entry[] | null`, `activeThemeId(entries: Entry[], date: Date) -> string | null`, `localDateKey(date: Date) -> "YYYY-MM-DD"`, where `Entry = { theme, from, to }`.

- [ ] **Step 1: Write the failing tests**

`src/js/season/schedule.test.js`:
```js
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
```

Add to `package.json` `"scripts"`: `"test": "node --test src/js/season/"`

Create `src/js/season/package.json` containing `{ "type": "module" }` — node then treats the season files as ES modules without switching the root package (Electron `main.js` is CommonJS until Task 12).

- [ ] **Step 2: Run tests — expect failure**

Run: `node --test src/js/season/`
Expected: FAIL — `Cannot find module '.../schedule.js'`

- [ ] **Step 3: Implement**

`src/js/season/schedule.js`:
```js
// Picks which seasonal theme is active. Pure — no DOM, no network.
export const SCHEDULE_VERSION = 1;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID = /^[a-z0-9-]{1,40}$/;

export function localDateKey(d) {
    const two = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Returns the usable entries, or null when the file itself is unusable. */
export function parseSchedule(raw) {
    if (!raw || raw.version !== SCHEDULE_VERSION || !Array.isArray(raw.entries)) return null;
    return raw.entries
        .filter(e => e && ID.test(e.theme) && DATE.test(e.from) && DATE.test(e.to) && e.from <= e.to)
        .map(e => ({ theme: e.theme, from: e.from, to: e.to }));
}

/** Dates compare as YYYY-MM-DD strings in local time; the last matching entry wins. */
export function activeThemeId(entries, date) {
    const key = localDateKey(date);
    let hit = null;
    for (const e of entries) if (e.from <= key && key <= e.to) hit = e.theme;
    return hit;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `node --test src/js/season/`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/season/schedule.js src/js/season/schedule.test.js src/js/season/package.json package.json
git commit -m "Season schedule: parse remote schedule and pick the active theme by local date"
```

---

### Task 2: Theme validation

**Files:**
- Create: `src/js/season/validate.js`
- Test: `src/js/season/validate.test.js`

**Interfaces:**
- Produces: `validateTheme(raw, expectedId) -> Theme | null`, `assetNames(theme) -> string[]`, `LEVELS = ['low','medium','high','critical']`.
- `Theme = { id, label?, colors: {bg?,card?,border?,accent?,glow?}, lantern: {low?,medium?,high?,critical?}, mascot?: {low,medium,high,critical,sleepZ}, orbiter?, header: {badge?, flyer?, moon}, particles?: {type, color?}, fog? }` — asset fields hold file names.

- [ ] **Step 1: Write the failing tests**

`src/js/season/validate.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTheme, assetNames } from './validate.js';

const good = () => ({
    id: 'halloween-bi-ngo', label: 'Halloween',
    colors: { bg: '#0b0810', card: '#140f1b', border: '#2c2238', accent: '#b388ff', glow: '#ff8a1f' },
    lantern: { low: '#ff9628', medium: '#ff9628', high: '#ff7814', critical: '#ef4444' },
    mascot: { low: 'mascot-low.svg', medium: 'mascot-medium.svg', high: 'mascot-high.svg', critical: 'mascot-critical.svg', sleepZ: true },
    orbiter: 'orbiter.svg',
    header: { badge: 'badge.svg', flyer: 'flyer.svg', moon: true },
    particles: { type: 'rise', color: '#ff8a1f' },
    fog: '#a078dc',
});

test('accepts a complete theme', () => {
    const t = validateTheme(good(), 'halloween-bi-ngo');
    assert.equal(t.id, 'halloween-bi-ngo');
    assert.equal(t.mascot.critical, 'mascot-critical.svg');
    assert.equal(t.particles.type, 'rise');
    assert.equal(t.header.moon, true);
});

test('id must match the folder and the pattern', () => {
    assert.equal(validateTheme(good(), 'other'), null);
    assert.equal(validateTheme({ ...good(), id: 'Bad Id' }, 'Bad Id'), null);
    assert.equal(validateTheme({ colors: {} }, 'x'), null);
    assert.equal(validateTheme('nope', 'x'), null);
});

test('bad colours are dropped individually', () => {
    const raw = good();
    raw.colors.bg = 'red';
    raw.colors.accent = '#fff';
    raw.fog = 'url(x)';
    const t = validateTheme(raw, raw.id);
    assert.equal(t.colors.bg, undefined);
    assert.equal(t.colors.accent, undefined);
    assert.equal(t.colors.card, '#140f1b');
    assert.equal(t.fog, undefined);
});

test('asset names with paths or other extensions are dropped', () => {
    const raw = good();
    raw.orbiter = '../secret.svg';
    raw.header.flyer = 'bat.js';
    raw.header.badge = 'sub/badge.svg';
    const t = validateTheme(raw, raw.id);
    assert.equal(t.orbiter, undefined);
    assert.equal(t.header.flyer, undefined);
    assert.equal(t.header.badge, undefined);
});

test('mascot is all-or-nothing', () => {
    const raw = good();
    raw.mascot.critical = '../x.svg';
    assert.equal(validateTheme(raw, raw.id).mascot, undefined);
});

test('unknown particle type disables particles; long label dropped', () => {
    const raw = good();
    raw.particles.type = 'explode';
    raw.label = 'x'.repeat(25);
    const t = validateTheme(raw, raw.id);
    assert.equal(t.particles, undefined);
    assert.equal(t.label, undefined);
});

test('unknown fields are ignored', () => {
    const t = validateTheme({ ...good(), css: 'body{}', script: 'alert(1)' }, 'halloween-bi-ngo');
    assert.equal('css' in t, false);
    assert.equal('script' in t, false);
});

test('assetNames lists each referenced file once', () => {
    const t = validateTheme(good(), 'halloween-bi-ngo');
    assert.deepEqual(assetNames(t).sort(), [
        'badge.svg', 'flyer.svg', 'mascot-critical.svg', 'mascot-high.svg',
        'mascot-low.svg', 'mascot-medium.svg', 'orbiter.svg',
    ]);
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `node --test src/js/season/`
Expected: FAIL — `Cannot find module '.../validate.js'`

- [ ] **Step 3: Implement**

`src/js/season/validate.js`:
```js
// Whitelist validation for remote theme.json. Anything not understood is dropped,
// so a compromised or broken theme can only ever change colours and pictures.
export const LEVELS = ['low', 'medium', 'high', 'critical'];
const ID = /^[a-z0-9-]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET = /^[a-z0-9-]+\.(svg|png)$/;
const PARTICLES = ['rise', 'fall', 'drift'];
const COLOR_KEYS = ['bg', 'card', 'border', 'accent', 'glow'];

const color = v => (typeof v === 'string' && HEX.test(v) ? v : undefined);
const asset = v => (typeof v === 'string' && ASSET.test(v) ? v : undefined);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function validateTheme(raw, expectedId) {
    if (!raw || typeof raw !== 'object' || raw.id !== expectedId || !ID.test(raw.id)) return null;
    const t = { id: raw.id };

    if (typeof raw.label === 'string' && raw.label.length > 0 && raw.label.length <= 24) t.label = raw.label;

    t.colors = compact(Object.fromEntries(COLOR_KEYS.map(k => [k, color(obj(raw.colors)[k])])));
    t.lantern = compact(Object.fromEntries(LEVELS.map(k => [k, color(obj(raw.lantern)[k])])));

    // A mascot missing any level would leave the icon empty at that level
    const m = obj(raw.mascot);
    const faces = LEVELS.map(k => asset(m[k]));
    if (faces.every(Boolean)) {
        t.mascot = Object.fromEntries(LEVELS.map((k, i) => [k, faces[i]]));
        t.mascot.sleepZ = m.sleepZ === true;
    }

    const orbiter = asset(raw.orbiter);
    if (orbiter) t.orbiter = orbiter;

    const h = obj(raw.header);
    t.header = compact({ badge: asset(h.badge), flyer: asset(h.flyer) });
    t.header.moon = h.moon === true;

    const p = obj(raw.particles);
    if (PARTICLES.includes(p.type)) t.particles = compact({ type: p.type, color: color(p.color) });

    const fog = color(raw.fog);
    if (fog) t.fog = fog;
    return t;
}

export function assetNames(t) {
    const names = [t.orbiter, t.header?.badge, t.header?.flyer];
    if (t.mascot) names.push(...LEVELS.map(k => t.mascot[k]));
    return [...new Set(names.filter(Boolean))];
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `node --test src/js/season/`
Expected: all tests PASS (Task 1 + Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/js/season/validate.js src/js/season/validate.test.js
git commit -m "Season validate: whitelist theme.json fields, drop anything unsafe"
```

---

### Task 3: Loader — fetch, cache, data URLs, fallback

**Files:**
- Create: `src/js/season/loader.js`
- Test: `src/js/season/loader.test.js`

**Interfaces:**
- Consumes: `parseSchedule` (Task 1), `validateTheme`, `assetNames` (Task 2).
- Produces: `createLoader({ fetchFn, storage, now?, baseUrl?, fallbackUrl? })` returning:
  - `cachedSchedule() -> Entry[] | null`
  - `scheduleIsStale() -> boolean`
  - `refreshSchedule() -> Promise<Entry[] | null>` (remote → cache; on failure cached → bundled fallback)
  - `cachedTheme(id) -> LoadedTheme | null`
  - `themeIsStale(id) -> boolean`
  - `loadTheme(id) -> Promise<LoadedTheme | null>` (remote → bundled fallback; caches on success)
  - `pruneThemes(keepIds: string[]) -> void`
  - `LoadedTheme = Theme & { assets: { [fileName]: dataUrl }, fetchedAt }`
- Constants exported: `BASE_URL`, `SCHEDULE_TTL_MS`, `MAX_ASSET_BYTES`, `MAX_THEME_BYTES`.

- [ ] **Step 1: Write the failing tests**

`src/js/season/loader.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, SCHEDULE_TTL_MS, MAX_ASSET_BYTES } from './loader.js';

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
    assert.equal(l.cachedTheme('hw'), null);
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
```

- [ ] **Step 2: Run tests — expect failure**

Run: `node --test src/js/season/`
Expected: FAIL — `Cannot find module '.../loader.js'`

- [ ] **Step 3: Implement**

`src/js/season/loader.js`:
```js
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
```

- [ ] **Step 4: Run tests — expect pass**

Run: `node --test src/js/season/`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/season/loader.js src/js/season/loader.test.js
git commit -m "Season loader: fetch + cache schedule and themes, assets as data URLs, bundled fallback"
```

---

### Task 4: Halloween theme content (remote + bundled fallback)

**Files:**
- Create: `themes/schedule.json`, `themes/halloween-bi-ngo/theme.json`, `themes/halloween-bi-ngo/{mascot-low,mascot-medium,mascot-high,mascot-critical,badge,flyer,orbiter}.svg`
- Create: identical copies under `src/themes/`
- Test: `src/js/season/themes.test.js`

**Interfaces:**
- Consumes: `parseSchedule`, `validateTheme`, `assetNames`.

- [ ] **Step 1: Write the failing test**

`src/js/season/themes.test.js`:
```js
// Guards the shipped theme content: remote folder and bundled fallback must be
// identical, valid, and within size limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchedule } from './schedule.js';
import { validateTheme, assetNames } from './validate.js';
import { MAX_ASSET_BYTES, MAX_THEME_BYTES } from './loader.js';

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REMOTE = join(ROOT, 'themes');
const BUNDLED = join(ROOT, 'src', 'themes');
const list = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();

test('bundled fallback mirrors themes/ byte for byte', () => {
    assert.deepEqual(list(BUNDLED), list(REMOTE));
    for (const f of list(REMOTE)) assert.ok(readFileSync(join(REMOTE, f)).equals(readFileSync(join(BUNDLED, f))), f);
});

test('schedule is valid and every scheduled theme exists and validates', () => {
    const entries = parseSchedule(JSON.parse(readFileSync(join(REMOTE, 'schedule.json'), 'utf8')));
    assert.ok(entries && entries.length > 0);
    for (const e of entries) {
        const dir = join(REMOTE, e.theme);
        const theme = validateTheme(JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8')), e.theme);
        assert.ok(theme, `${e.theme} invalid`);
        let total = 0;
        for (const name of assetNames(theme)) {
            const size = statSync(join(dir, name)).size;
            assert.ok(size <= MAX_ASSET_BYTES, `${name} too big`);
            total += size;
        }
        assert.ok(total <= MAX_THEME_BYTES);
    }
});

test('halloween runs 2026-10-07 to 2026-10-31', () => {
    const entries = parseSchedule(JSON.parse(readFileSync(join(REMOTE, 'schedule.json'), 'utf8')));
    assert.deepEqual(entries.find(e => e.theme === 'halloween-bi-ngo'), { theme: 'halloween-bi-ngo', from: '2026-10-07', to: '2026-10-31' });
});

test('halloween theme uses every effect slot', () => {
    const t = validateTheme(JSON.parse(readFileSync(join(REMOTE, 'halloween-bi-ngo', 'theme.json'), 'utf8')), 'halloween-bi-ngo');
    assert.ok(t.mascot && t.orbiter && t.header.badge && t.header.flyer && t.header.moon && t.particles && t.fog);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `node --test src/js/season/`
Expected: FAIL — `ENOENT ... src/themes`

- [ ] **Step 3: Create theme files**

`themes/schedule.json`:
```json
{
  "version": 1,
  "entries": [
    { "theme": "halloween-bi-ngo", "from": "2026-10-07", "to": "2026-10-31" }
  ]
}
```

`themes/halloween-bi-ngo/theme.json`:
```json
{
  "id": "halloween-bi-ngo",
  "label": "Halloween",
  "colors": { "bg": "#0b0810", "card": "#140f1b", "border": "#2c2238", "accent": "#b388ff", "glow": "#ff8a1f" },
  "lantern": { "low": "#ff9628", "medium": "#ff9628", "high": "#ff7814", "critical": "#ef4444" },
  "mascot": {
    "low": "mascot-low.svg", "medium": "mascot-medium.svg",
    "high": "mascot-high.svg", "critical": "mascot-critical.svg",
    "sleepZ": true
  },
  "orbiter": "orbiter.svg",
  "header": { "badge": "badge.svg", "flyer": "flyer.svg", "moon": true },
  "particles": { "type": "rise", "color": "#ff8a1f" },
  "fog": "#a078dc"
}
```

Shared pumpkin body (used verbatim at the top of every mascot/badge file, after the `<svg …>` line):
```xml
  <path d="M31 14c0-5 3-9 8-10l1 3c-3 1-5 4-5 7z" fill="#65a30d"/>
  <ellipse cx="19" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="45" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="32" cy="37" rx="15" ry="22" fill="#f97316"/>
  <path d="M27 18c-3 6-3 32 0 40M37 18c3 6 3 32 0 40" stroke="#ea580c" stroke-width="1.5" fill="none" opacity=".7"/>
```

`themes/halloween-bi-ngo/mascot-low.svg` (asleep):
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M31 14c0-5 3-9 8-10l1 3c-3 1-5 4-5 7z" fill="#65a30d"/>
  <ellipse cx="19" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="45" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="32" cy="37" rx="15" ry="22" fill="#f97316"/>
  <path d="M27 18c-3 6-3 32 0 40M37 18c3 6 3 32 0 40" stroke="#ea580c" stroke-width="1.5" fill="none" opacity=".7"/>
  <g fill="none" stroke="#fde68a" stroke-width="3.5" stroke-linecap="round" opacity=".85">
    <path d="M14 32q6 5 12 0M38 32q6 5 12 0"/>
    <path d="M28 46q4 3 8 0"/>
  </g>
</svg>
```

`themes/halloween-bi-ngo/mascot-medium.svg` (happy, flickering candle):
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <style>.f{fill:#fde047;animation:k 2.6s infinite}@keyframes k{8%{fill:#fb923c}10%{fill:#fde047}50%{fill:#f59e0b}53%{fill:#fde047}}@media (prefers-reduced-motion:reduce){.f{animation:none}}</style>
  <path d="M31 14c0-5 3-9 8-10l1 3c-3 1-5 4-5 7z" fill="#65a30d"/>
  <ellipse cx="19" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="45" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="32" cy="37" rx="15" ry="22" fill="#f97316"/>
  <path d="M27 18c-3 6-3 32 0 40M37 18c3 6 3 32 0 40" stroke="#ea580c" stroke-width="1.5" fill="none" opacity=".7"/>
  <g class="f">
    <path d="M15 34l6-10 6 10z"/><path d="M37 34l6-10 6 10z"/>
    <path d="M13 42c6 11 32 11 38 0l-4 2-3 4-4-3-3 4-3-4-3 4-3-4-3 4-4-3-3-4z"/>
  </g>
</svg>
```

`themes/halloween-bi-ngo/mascot-high.svg` (tense):
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <style>.f{fill:#fde047;animation:k 1.8s infinite}@keyframes k{8%{fill:#fb923c}10%{fill:#fde047}50%{fill:#f59e0b}53%{fill:#fde047}}@media (prefers-reduced-motion:reduce){.f{animation:none}}</style>
  <path d="M31 14c0-5 3-9 8-10l1 3c-3 1-5 4-5 7z" fill="#65a30d"/>
  <ellipse cx="19" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="45" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="32" cy="37" rx="15" ry="22" fill="#f97316"/>
  <path d="M27 18c-3 6-3 32 0 40M37 18c3 6 3 32 0 40" stroke="#ea580c" stroke-width="1.5" fill="none" opacity=".7"/>
  <g class="f">
    <path d="M13 29l14 4-3 6z"/><path d="M51 29l-14 4 3 6z"/>
    <path d="M15 45h34l-3 5-3-4-3 4-3-4-3 4-3-4-3 4-3-4-3 4-3-4z"/>
  </g>
</svg>
```

`themes/halloween-bi-ngo/mascot-critical.svg` (angry):
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M31 14c0-5 3-9 8-10l1 3c-3 1-5 4-5 7z" fill="#65a30d"/>
  <ellipse cx="19" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="45" cy="38" rx="13" ry="19" fill="#c2410c"/>
  <ellipse cx="32" cy="37" rx="15" ry="22" fill="#f97316"/>
  <path d="M27 18c-3 6-3 32 0 40M37 18c3 6 3 32 0 40" stroke="#ea580c" stroke-width="1.5" fill="none" opacity=".7"/>
  <g fill="#fecaca">
    <path d="M12 26l16 7-13 5z"/><path d="M52 26l-16 7 13 5z"/>
    <path d="M14 41c5 13 31 13 36 0l-4 3-3-5-4 6-4-6-4 6-4-6-4 6-3-5z"/>
  </g>
</svg>
```

`themes/halloween-bi-ngo/badge.svg`: copy of `mascot-medium.svg` with the stem made two-leaved — identical content to `mascot-medium.svg` plus this line after the stem path:
```xml
  <path d="M38 9c4-2 8-1 10 2-3 0-6 1-8 3z" fill="#84cc16"/>
```

`themes/halloween-bi-ngo/flyer.svg`:
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 44"><path fill="#7c5aa6" d="M50 14c-1-5-3-8-5-9 1 3 1 5 0 7C39 6 25 2 8 6c8 3 13 9 14 16 5-4 11-4 15 1 3-4 8-4 11 1 1-2 1-3 2-3s1 1 2 3c3-5 8-5 11-1 4-5 10-5 15-1 1-7 6-13 14-16-17-4-31 0-37 6-1-2-1-4 0-7-2 1-4 4-5 9z"/></svg>
```

`themes/halloween-bi-ngo/orbiter.svg` (same bat, darker body, gold edge):
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 44"><path fill="#4c2d6b" stroke="#ffd166" stroke-width="2.5" stroke-linejoin="round" d="M50 14c-1-5-3-8-5-9 1 3 1 5 0 7C39 6 25 2 8 6c8 3 13 9 14 16 5-4 11-4 15 1 3-4 8-4 11 1 1-2 1-3 2-3s1 1 2 3c3-5 8-5 11-1 4-5 10-5 15-1 1-7 6-13 14-16-17-4-31 0-37 6-1-2-1-4 0-7-2 1-4 4-5 9z"/></svg>
```

Then mirror: `rm -rf src/themes && cp -r themes src/themes`

- [ ] **Step 4: Run — expect pass**

Run: `node --test src/js/season/`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add themes src/themes src/js/season/themes.test.js
git commit -m "Halloween theme content (2026-10-07 → 31) with bundled fallback copy"
```

---

### Task 5: Apply layer, season.css, lifecycle, page wiring

**Files:**
- Create: `src/js/season/apply.js`, `src/js/season/index.js`, `src/css/season.css`
- Modify: `src/index.html`, `src/floating.html`

**Interfaces:**
- Consumes: `createLoader` (Task 3), `activeThemeId` (Task 1), `LEVELS` (Task 2), `invoke`/`listen` from `src/js/utils.js`, Tauri events `settings-changed` (payload = full Config, Task 6).
- Produces: `applyTheme(theme: LoadedTheme, page: 'dashboard'|'floating')`, `clearTheme()`; page entry `<script type="module" src="js/season/index.js">`.

- [ ] **Step 1: Write `apply.js`**

```js
// Adds and removes seasonal decoration. Every element it creates carries the
// `season-el` class and every CSS var it sets is listed in VARS, so clearTheme
// restores the page exactly.
import { LEVELS } from './validate.js';

const root = document.documentElement;
const VARS = [
    '--bg-primary', '--bg-secondary', '--bg-card', '--border', '--accent', '--accent-dim', '--accent-faint',
    '--season-glow', '--season-bg', '--season-fog', '--season-particle',
    ...LEVELS.map(l => `--season-lantern-${l}`),
];

function el(tag, cls, attrs = {}) {
    const e = document.createElement(tag);
    e.className = `season-el ${cls}`;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}
const img = (src, cls) => el('img', cls, { src, alt: '', 'aria-hidden': 'true', draggable: 'false' });
const setVar = (name, value) => value && root.style.setProperty(name, value);

export function clearTheme() {
    document.querySelectorAll('.season-el').forEach(e => e.remove());
    document.querySelectorAll('.season-hidden').forEach(e => e.classList.remove('season-hidden'));
    for (const v of VARS) root.style.removeProperty(v);
    delete root.dataset.season;
    delete root.dataset.seasonPage;
    delete root.dataset.seasonMascot;
}

export function applyTheme(theme, page) {
    clearTheme();
    root.dataset.season = theme.id;
    root.dataset.seasonPage = page;
    const a = name => (name ? theme.assets[name] : null);
    if (page === 'dashboard') applyDashboard(theme, a);
    else applyFloating(theme, a);
}

function applyDashboard(t, a) {
    const c = t.colors;
    setVar('--bg-primary', c.bg);
    setVar('--bg-card', c.card);
    setVar('--bg-secondary', c.card);
    setVar('--border', c.border);
    setVar('--accent', c.accent);
    if (c.accent) {
        setVar('--accent-dim', `color-mix(in srgb, ${c.accent} 50%, transparent)`);
        setVar('--accent-faint', `color-mix(in srgb, ${c.glow || c.accent} 10%, transparent)`);
    }
    setVar('--season-glow', c.glow);

    const title = document.querySelector('.header-title');
    if (title) {
        if (a(t.header.badge)) {
            title.querySelector('svg')?.classList.add('season-hidden');
            title.prepend(img(a(t.header.badge), 'season-badge'));
        }
        if (t.label) {
            const pill = el('span', 'season-pill');
            pill.textContent = t.label;
            title.append(pill);
        }
    }

    const header = document.querySelector('.header');
    if (header && (t.header.moon || a(t.header.flyer))) {
        const sky = el('div', 'season-sky', { 'aria-hidden': 'true' });
        if (t.header.moon) sky.append(el('div', 'season-moon'));
        if (a(t.header.flyer)) for (let i = 1; i <= 3; i++) sky.append(img(a(t.header.flyer), `season-flyer f${i}`));
        header.append(sky);
    }

    if (t.fog || t.particles) {
        const back = el('div', 'season-backdrop', { 'aria-hidden': 'true' });
        if (t.fog) {
            setVar('--season-fog', t.fog);
            back.append(el('div', 'season-fog f1'), el('div', 'season-fog f2'));
        }
        if (t.particles) {
            setVar('--season-particle', t.particles.color || c.glow || '#ffffff');
            for (let i = 0; i < 9; i++) {
                const p = el('i', `season-particle season-${t.particles.type}`);
                p.style.setProperty('--i', i);
                back.append(p);
            }
        }
        document.body.append(back);
    }
}

function applyFloating(t, a) {
    // Never touch the body/html background here — the window is wider than the ring
    const icon = document.getElementById('floating-icon');
    if (!icon) return;
    setVar('--season-bg', t.colors.bg);
    for (const l of LEVELS) setVar(`--season-lantern-${l}`, t.lantern[l] || t.colors.glow);
    icon.prepend(el('span', 'season-lantern', { 'aria-hidden': 'true' }));

    if (t.mascot) {
        root.dataset.seasonMascot = '1';
        const box = el('span', 'season-mascot', { 'aria-hidden': 'true' });
        for (const l of LEVELS) {
            const face = img(a(t.mascot[l]), 'season-face');
            face.dataset.level = l;
            box.append(face);
        }
        if (t.mascot.sleepZ) {
            const z = el('i', 'season-zzz');
            z.textContent = 'z';
            box.append(z);
        }
        icon.append(box);
    }
    if (a(t.orbiter)) {
        const orbit = el('span', 'season-orbit', { 'aria-hidden': 'true' });
        orbit.append(img(a(t.orbiter), 'season-orbiter'));
        icon.append(orbit);
    }
}
```

- [ ] **Step 2: Write `index.js`**

```js
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
        let theme = id === appliedId && !refetch ? null : loader.cachedTheme(id);
        if (theme && id !== appliedId) { applyTheme(theme, page); appliedId = id; }
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
    setInterval(refreshRemote, 15 * 60 * 1000);
    listen('settings-changed', ({ payload }) => {
        cfg = { ...cfg, ...payload };
        appliedId = null;
        sync();
    });
})();
```

(`refreshRemote` runs every 15 min but only fetches when the 6 h TTL has expired, so a laptop waking from sleep catches up quickly.)

- [ ] **Step 3: Write `src/css/season.css`**

```css
/* Generic seasonal effects. Content (colours, pictures) comes from the theme via
   --season-* vars and data: URL <img>s; nothing here is specific to one season.
   Usage-level colours are never touched. */

/* ─── Dashboard ─────────────────────────────────────────────────────────── */

[data-season-page="dashboard"] body {
  background:
    radial-gradient(120% 60% at 50% 115%, color-mix(in srgb, var(--season-fog, transparent) 20%, transparent), transparent 60%),
    var(--bg-primary);
}

[data-season-page="dashboard"] .header,
[data-season-page="dashboard"] .content,
[data-season-page="dashboard"] .footer { position: relative; z-index: 1; }

[data-season-page="dashboard"] .header {
  overflow: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, var(--season-glow, transparent) 8%, transparent), transparent 85%);
}

[data-season-page="dashboard"] .header-title,
[data-season-page="dashboard"] .header-actions { position: relative; z-index: 2; }

[data-season-page="dashboard"] .header-title > span:not(.season-pill) {
  background: linear-gradient(90deg, var(--season-glow, var(--accent)), var(--accent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  letter-spacing: 1.5px;
}

.season-hidden { display: none !important; }

.season-badge {
  width: 22px;
  height: 22px;
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--season-glow, #fff) 55%, transparent));
  animation: season-bob 3.2s ease-in-out infinite;
}

.season-pill {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--season-glow, var(--accent));
  border: 1px solid color-mix(in srgb, var(--season-glow, var(--accent)) 40%, transparent);
  background: color-mix(in srgb, var(--season-glow, var(--accent)) 8%, transparent);
  padding: 2px 7px;
  border-radius: 999px;
}

.season-sky { position: absolute; inset: 0; pointer-events: none; z-index: 1; }

.season-moon {
  position: absolute;
  top: -26px;
  right: 118px;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 40%, rgba(0, 0, 0, 0.12) 0 5px, transparent 6px),
    radial-gradient(circle at 62% 66%, rgba(0, 0, 0, 0.10) 0 4px, transparent 5px),
    radial-gradient(circle at 40% 35%, #fff6d8, #f6d77a 70%);
  box-shadow: 0 0 22px 6px rgba(246, 215, 122, 0.25);
  opacity: 0.85;
}

.season-flyer {
  position: absolute;
  width: 22px;
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 45%, transparent));
  animation: season-fly 14s linear infinite, season-flap 0.32s ease-in-out infinite alternate;
  transform-origin: 50% 40%;
}
.season-flyer.f1 { top: 6px; }
.season-flyer.f2 { top: 16px; width: 15px; animation-duration: 19s, 0.26s; animation-delay: -7s, 0s; }
.season-flyer.f3 { top: 2px;  width: 11px; animation-duration: 23s, 0.22s; animation-delay: -15s, 0s; }

.season-backdrop { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }

.season-fog {
  position: absolute;
  bottom: -40px;
  width: 140%;
  height: 160px;
  background: radial-gradient(50% 50% at 50% 50%, color-mix(in srgb, var(--season-fog) 18%, transparent), transparent 70%);
  filter: blur(8px);
  animation: season-drift-fog 26s ease-in-out infinite alternate;
}
.season-fog.f1 { left: -40%; }
.season-fog.f2 { left: 0; bottom: -60px; animation-duration: 34s; animation-direction: alternate-reverse; opacity: 0.8; }

.season-particle {
  position: absolute;
  left: calc(6% + var(--i) * 10.5%);
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--season-particle);
  box-shadow: 0 0 6px 2px color-mix(in srgb, var(--season-particle) 60%, transparent);
  opacity: 0;
  animation-duration: calc(9s + var(--i) * 1.3s);
  animation-delay: calc(var(--i) * -2.1s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
.season-rise  { bottom: -6px; animation-name: season-rise; }
.season-fall  { top: -6px;    animation-name: season-fall; }
.season-drift { top: calc(10% + var(--i) * 9%); left: -6px; animation-name: season-drift; }

[data-season-page="dashboard"] .provider-card.active {
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
  box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--season-glow, var(--accent)) 28%, transparent);
}
[data-season-page="dashboard"] .provider-card:hover {
  border-color: color-mix(in srgb, var(--season-glow, var(--accent)) 45%, transparent);
}

/* ─── Floating icon ─────────────────────────────────────────────────────── */

[data-season-page="floating"] .floating-icon {
  background: radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--season-bg, #0a0a0f) 70%, #3a2050), var(--season-bg, #0a0a0f) 72%);
}

[data-season-page="floating"] .icon-logo,
[data-season-page="floating"] .icon-pct { position: relative; z-index: 2; }

.season-lantern {
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
  --lc: var(--season-lantern-medium);
  background: radial-gradient(circle at 50% 60%, color-mix(in srgb, var(--lc) 32%, transparent), transparent 62%);
  animation: season-candle 2.4s infinite;
}
.floating-icon.low .season-lantern      { --lc: var(--season-lantern-low); opacity: 0.45; }
.floating-icon.high .season-lantern     { --lc: var(--season-lantern-high); }
.floating-icon.critical .season-lantern { --lc: var(--season-lantern-critical); animation-duration: 0.9s; }

/* Mascot takes the logo's place; the provider logo shrinks to a badge */
.season-mascot {
  position: absolute;
  left: 50%;
  top: 6px;
  width: 30px;
  height: 30px;
  margin-left: -15px;
  z-index: 3;
  pointer-events: none;
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--season-lantern-medium) 75%, transparent));
  animation: season-bob 3.2s ease-in-out infinite;
}
.season-face { display: none; width: 100%; height: 100%; }
.floating-icon.low .season-face[data-level="low"],
.floating-icon.medium .season-face[data-level="medium"],
.floating-icon.high .season-face[data-level="high"],
.floating-icon.critical .season-face[data-level="critical"] { display: block; }
.floating-icon.critical .season-mascot {
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--season-lantern-critical) 95%, transparent));
  animation: season-shake 0.45s ease-in-out infinite;
}

[data-season-mascot] .icon-logo {
  position: absolute;
  z-index: 4;
  width: 15px;
  height: 15px;
  right: 5px;
  top: 25px;
  border-radius: 4px;
  filter: drop-shadow(0 0 2px #000);
}
[data-season-mascot] .icon-pct { margin-top: 26px; }

.season-zzz {
  display: none;
  position: absolute;
  left: 26px;
  top: -3px;
  font: italic 700 9px/1 "Segoe UI", sans-serif;
  color: #c4b5fd;
  animation: season-zzz 2.8s ease-out infinite;
}
.floating-icon.low .season-zzz { display: block; }

.season-orbit {
  position: absolute;
  inset: -2px;
  z-index: 5;
  pointer-events: none;
  animation: season-spin 9s linear infinite;
}
.season-orbiter {
  position: absolute;
  top: 1px;
  left: calc(50% - 10px);
  width: 20px;
  filter: drop-shadow(0 0 2px color-mix(in srgb, var(--season-lantern-medium) 60%, transparent));
  animation: season-flap-soft 0.3s ease-in-out infinite alternate;
  transform-origin: 50% 40%;
}
.floating-icon.critical .season-orbit { animation-duration: 4s; }

/* ─── Motion ────────────────────────────────────────────────────────────── */

@keyframes season-bob       { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-1.5px) rotate(3deg); } }
@keyframes season-flap      { from { scale: 1 1; } to { scale: 1 0.35; } }
@keyframes season-flap-soft { from { scale: 1 1; } to { scale: 1 0.55; } }
@keyframes season-fly {
  0%   { left: -30px; transform: translateY(0); }
  25%  { transform: translateY(6px); }
  50%  { transform: translateY(-3px); }
  75%  { transform: translateY(5px); }
  100% { left: 110%; transform: translateY(0); }
}
@keyframes season-drift-fog { from { transform: translateX(-8%); } to { transform: translateX(8%); } }
@keyframes season-rise  { 0% { transform: translate(0, 0); opacity: 0; } 10% { opacity: 0.9; } 70% { opacity: 0.5; } 100% { transform: translate(14px, -560px); opacity: 0; } }
@keyframes season-fall  { 0% { transform: translate(0, 0); opacity: 0; } 10% { opacity: 0.9; } 70% { opacity: 0.6; } 100% { transform: translate(-14px, 560px); opacity: 0; } }
@keyframes season-drift { 0% { transform: translate(0, 0); opacity: 0; } 10% { opacity: 0.8; } 90% { opacity: 0.6; } 100% { transform: translate(420px, 18px); opacity: 0; } }
@keyframes season-candle { 0%, 100% { opacity: 0.85; } 20% { opacity: 1; } 22% { opacity: 0.7; } 55% { opacity: 0.95; } 70% { opacity: 0.75; } }
@keyframes season-shake  { 0%, 100% { transform: translateX(0) rotate(0); } 25% { transform: translateX(-1px) rotate(-6deg); } 75% { transform: translateX(1px) rotate(6deg); } }
@keyframes season-spin   { to { transform: rotate(360deg); } }
@keyframes season-zzz    { 0% { transform: translate(0, 4px); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(5px, -4px); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  [data-season] .season-el,
  [data-season] .season-el * { animation: none !important; }
  .season-flyer.f1 { left: 30%; }
  .season-flyer.f2 { left: 55%; }
  .season-flyer.f3 { left: 72%; }
}
```

(Flapping uses the `scale` property so it composes with the `transform` used by `season-fly`/`season-flap-soft` on the same element.)

- [ ] **Step 4: Wire the pages**

`src/index.html` — after `<link rel="stylesheet" href="css/dashboard.css">` add:
```html
  <link rel="stylesheet" href="css/season.css">
```
and before `<script type="module" src="js/dashboard.js"></script>` add:
```html
  <script type="module" src="js/season/index.js"></script>
```
`src/floating.html` — after `<link rel="stylesheet" href="css/floating.css">` add the same `season.css` link; before `js/floating.js` add the same `season/index.js` script.

- [ ] **Step 5: Run unit tests**

Run: `npm test`
Expected: all PASS (apply/index are DOM code, covered by Step 6).

- [ ] **Step 6: Visual check in headless Chrome**

Serve `src/` and a harness that stubs `window.__TAURI__` (`load_settings` → `{seasonal_theme:true}`, `get_usage` per provider, `get_providers`), then screenshot:
- dashboard at 400×560 → expect pumpkin badge, "HALLOWEEN" pill, moon, bats, rising embers, purple cards; status pills and `%` colours unchanged;
- floating at u = 0.3 / 0.7 / 0.88 / 0.98 over a magenta page background → expect sleeping/happy/tense/angry pumpkin, bat on the ring, **magenta visible outside the ring** (no dark rectangle);
- set `load_settings` → `{seasonal_theme:false}` → expect the plain look on both pages.

Commands (Chrome path on this machine):
```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=500,560 --virtual-time-budget=5000 --screenshot=dash.png http://127.0.0.1:1430/__h/dash.html
```

- [ ] **Step 7: Commit**

```bash
git add src/js/season/apply.js src/js/season/index.js src/css/season.css src/index.html src/floating.html
git commit -m "Season engine: apply validated themes to dashboard and floating icon, keep in sync with date and settings"
```

---

### Task 6: Config fields, `settings-changed`, Settings toggle, safe config writes

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/main.rs:569-583` (`save_settings`)
- Modify: `src/settings.html:218-224`, `src/js/settings.js:72-77`, `src/js/settings.js:187-200`

**Interfaces:**
- Produces: `Config.seasonal_theme: bool`, `Config.theme_preview: Option<String>`; event `settings-changed` with payload = serialized `Config`; `config::load_from(&Path) -> (Config, bool /*needs_save*/)`, `config::save_to(&Path, &Config) -> io::Result<()>`.

- [ ] **Step 1: Write failing Rust tests** (append to `config.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("batradar-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn missing_file_gives_defaults_and_needs_save() {
        let p = tmp("missing");
        let _ = std::fs::remove_file(&p);
        let (cfg, needs_save) = load_from(&p);
        assert!(cfg.seasonal_theme);
        assert!(cfg.theme_preview.is_none());
        assert!(needs_save);
    }

    #[test]
    fn corrupt_file_is_never_overwritten() {
        let p = tmp("corrupt");
        std::fs::write(&p, "{ not json").unwrap();
        let (cfg, needs_save) = load_from(&p);
        assert!(!needs_save);
        assert_eq!(cfg.poll_interval_seconds, 30);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ not json");
    }

    #[test]
    fn old_config_gets_new_fields_with_defaults() {
        let p = tmp("old");
        std::fs::write(&p, r#"{"poll_interval_seconds":60,"migrated_providers":["gemini","copilot","openrouter","antigravity"]}"#).unwrap();
        let (cfg, _) = load_from(&p);
        assert_eq!(cfg.poll_interval_seconds, 60);
        assert!(cfg.seasonal_theme);
    }

    #[test]
    fn save_is_atomic_and_round_trips() {
        let p = tmp("save");
        let mut cfg = Config::default();
        cfg.theme_preview = Some("halloween-bi-ngo".into());
        save_to(&p, &cfg).unwrap();
        assert!(!p.with_extension("json.tmp").exists());
        let (back, _) = load_from(&p);
        assert_eq!(back.theme_preview.as_deref(), Some("halloween-bi-ngo"));
    }
}
```

- [ ] **Step 2: Run — expect compile failure**

Run: `cd src-tauri && cargo test config::`
Expected: FAIL — `cannot find function load_from` / no field `seasonal_theme`.

- [ ] **Step 3: Implement in `config.rs`**

Add fields to `Config` (after `migrated_providers`):
```rust
    /// Seasonal theme on/off (Settings → "Giao diện theo mùa")
    pub seasonal_theme: bool,
    /// Dev-only: force a theme id regardless of the schedule; edited by hand
    pub theme_preview: Option<String>,
```
In `Default`: `seasonal_theme: true, theme_preview: None,`

Replace `load` and `save`:
```rust
/// Returns the config and whether it should be written back (new file or migration).
/// A file that exists but fails to parse is left untouched — overwriting it with
/// defaults would wipe the user's settings.
pub fn load_from(path: &std::path::Path) -> (Config, bool) {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<Config>(&s) {
            Ok(mut cfg) => {
                let migrated = migrate(&mut cfg);
                (cfg, migrated)
            }
            Err(e) => {
                eprintln!("[BatRadar] config.json unreadable, using defaults: {e}");
                (Config::default(), false)
            }
        },
        Err(_) => {
            let mut cfg = Config::default();
            migrate(&mut cfg);
            (cfg, true)
        }
    }
}

pub fn load() -> Config {
    let (cfg, needs_save) = load_from(&config_path());
    if needs_save {
        save(&cfg);
    }
    cfg
}

/// Temp file + rename so a concurrent reader never sees a half-written file.
pub fn save_to(path: &std::path::Path, cfg: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg)?)?;
    std::fs::rename(&tmp, path)
}

pub fn save(cfg: &Config) {
    if let Err(e) = save_to(&config_path(), cfg) {
        eprintln!("[BatRadar] config save failed: {e}");
    }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd src-tauri && cargo test config::`
Expected: 4 tests PASS.

- [ ] **Step 5: Emit `settings-changed`**

In `main.rs` `save_settings`, after `set_autostart(app, cfg.autostart);` — change to:
```rust
    if let Ok(cfg) = serde_json::from_value::<Config>(current) {
        config::save(&cfg);
        set_autostart(app.clone(), cfg.autostart);
        let _ = app.emit("settings-changed", &cfg);
    }
```

- [ ] **Step 6: Settings toggle**

`src/settings.html` — insert after the Notifications `setting-row` (after line 224):
```html
        <div class="setting-row">
          <div>
            <div class="setting-label">Giao diện theo mùa</div>
            <div class="setting-desc">Đổi giao diện theo dịp lễ (Halloween, Noel, Tết…)</div>
          </div>
          <label class="toggle"><input type="checkbox" id="toggle-seasonal" checked><span class="toggle-slider"></span></label>
        </div>
```
`src/js/settings.js` `applySettings` — add:
```js
    document.getElementById('toggle-seasonal').checked = s.seasonal_theme !== false;
```
`saveSettings` `settings` object — add:
```js
        seasonal_theme:        document.getElementById('toggle-seasonal').checked,
```

- [ ] **Step 7: Build + manual check**

Run: `cd src-tauri && cargo build`; launch with `cargo tauri dev`. Untick "Giao diện theo mùa" → Save → dashboard and icon return to plain within 1 s; tick again → Halloween returns. Add `"theme_preview": "halloween-bi-ngo"` to `%APPDATA%\batradar\config.json`, restart → theme shows (already in schedule, so also set the schedule entry to a past date in a local copy to confirm preview overrides it — revert afterwards).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs src/settings.html src/js/settings.js
git commit -m "Config: seasonal_theme toggle, theme_preview, atomic writes, never overwrite an unreadable config"
```

---

### Task 7: Updater UX parity

**Files:**
- Create: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/main.rs` (remove `check_for_updates`, register module/commands, spawn loop)
- Modify: `src/index.html`, `src/js/dashboard.js`, `src/css/dashboard.css`, `src/settings.html:225-231`, `src/js/settings.js:58-70`

**Interfaces:**
- Produces: commands `check_update() -> Result<UpdateInfo, String>` with `UpdateInfo { available: bool, version: String, current: String }`; `install_update() -> Result<(), String>`; events `update-available { version }`, `update-progress { percent: Option<u8> }`, `update-error { message }`.

- [ ] **Step 1: Write `updater.rs`**

```rust
//! Checks GitHub for a signed update in the background and installs only when
//! the user clicks. Mirrors the Electron build's "ask first" behaviour.
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

static PENDING: Mutex<Option<Update>> = Mutex::new(None);
static NOTIFIED: Mutex<Option<String>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct UpdateInfo {
    available: bool,
    version: String,
    current: String,
}

async fn check_inner(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = match &update {
        Some(u) => UpdateInfo { available: true, version: u.version.clone(), current },
        None => UpdateInfo { available: false, version: current.clone(), current },
    };
    if info.available {
        let _ = app.emit("update-available", json!({ "version": info.version }));
    }
    *PENDING.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    check_inner(&app).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Đang cập nhật".into());
    }
    let result = async {
        let pending = PENDING.lock().unwrap().take();
        let update = match pending {
            Some(u) => u,
            None => app
                .updater()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Không có bản mới".to_string())?,
        };
        let mut downloaded: u64 = 0;
        let progress_app = app.clone();
        update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    let percent = total.map(|t| ((downloaded * 100) / t.max(1)).min(100) as u8);
                    let _ = progress_app.emit("update-progress", json!({ "percent": percent }));
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(()) => {
            app.restart();
        }
        Err(e) => {
            INSTALLING.store(false, Ordering::SeqCst);
            let _ = app.emit("update-error", json!({ "message": e }));
            Err(e)
        }
    }
}

/// 30 s after start, then every 6 h. Notifies once per new version.
pub fn spawn_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            match check_inner(&app).await {
                Ok(info) if info.available => {
                    let mut seen = NOTIFIED.lock().unwrap();
                    if seen.as_deref() != Some(info.version.as_str()) {
                        *seen = Some(info.version.clone());
                        let _ = app
                            .notification()
                            .builder()
                            .title("BatRadar")
                            .body(format!("Có bản {} — mở dashboard để cập nhật", info.version))
                            .show();
                    }
                }
                Ok(_) => {}
                Err(e) => eprintln!("[BatRadar][updater] {e}"),
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}
```

- [ ] **Step 2: Wire into `main.rs`**

- Add `mod updater;` next to the other `mod` lines.
- Delete the `check_for_updates` command (lines 835-847) and its entry in `generate_handler!`.
- Add `updater::check_update, updater::install_update,` to `generate_handler!`.
- In `.setup(...)`, after the tray is built: `updater::spawn_auto_check(handle.clone());`

Run: `cd src-tauri && cargo build`
Expected: compiles with no warnings about unused `check_for_updates`.

- [ ] **Step 3: Dashboard banner**

`src/index.html` — between the header `</div>` and `<!-- Provider cards -->`:
```html
  <div class="update-banner" id="update-banner" hidden>
    <span id="update-text"></span>
    <button class="btn-primary" id="update-btn" onclick="installUpdate()">Cập nhật</button>
  </div>
```
`src/css/dashboard.css` — append:
```css
.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent-dim);
  background: var(--accent-faint);
  font-size: 11px;
  color: var(--text-primary);
  flex-shrink: 0;
}
.update-banner[hidden] { display: none; }
.update-banner button { padding: 4px 10px; font-size: 11px; }
```
`src/js/dashboard.js` — append:
```js
// ─── Update banner ────────────────────────────────────────────────────────────
const banner = document.getElementById('update-banner');
const bannerText = document.getElementById('update-text');
const bannerBtn = document.getElementById('update-btn');

listen('update-available', ({ payload }) => {
    bannerText.textContent = `Có bản ${payload.version}`;
    bannerBtn.disabled = false;
    bannerBtn.textContent = 'Cập nhật';
    banner.hidden = false;
});
listen('update-progress', ({ payload }) => {
    banner.hidden = false;
    bannerBtn.disabled = true;
    bannerText.textContent = payload.percent == null ? 'Đang tải…' : `Đang tải ${payload.percent}%…`;
});
listen('update-error', ({ payload }) => {
    bannerBtn.disabled = false;
    bannerBtn.textContent = 'Thử lại';
    bannerText.textContent = `Lỗi cập nhật: ${payload.message}`;
});
window.installUpdate = () => {
    bannerBtn.disabled = true;
    invoke('install_update').catch(() => {});
};
```

- [ ] **Step 4: Settings result text**

`src/settings.html` — replace the "Cập nhật" row's description line with two lines:
```html
            <div class="setting-desc" id="app-version">Phiên bản: …</div>
            <div class="setting-desc" id="update-result"></div>
```
`src/js/settings.js` — replace `window.checkUpdates` with:
```js
window.checkUpdates = async () => {
    const btn = document.getElementById('btn-check-updates');
    const out = document.getElementById('update-result');
    btn.disabled = true;
    btn.textContent = 'Đang kiểm tra…';
    out.textContent = '';
    try {
        const info = await invoke('check_update');
        if (info.available) {
            out.textContent = `Có bản ${info.version}`;
            btn.textContent = 'Cập nhật';
            btn.disabled = false;
            btn.onclick = () => {
                btn.disabled = true;
                out.textContent = 'Đang tải…';
                invoke('install_update').catch(e => { out.textContent = `Lỗi: ${e}`; btn.disabled = false; });
            };
            return;
        }
        out.textContent = `Đã là bản mới nhất (${info.current})`;
    } catch (e) {
        out.textContent = `Lỗi: ${e}`;
    }
    btn.disabled = false;
    btn.textContent = 'Kiểm tra';
};

listen('update-progress', ({ payload }) => {
    const out = document.getElementById('update-result');
    if (out) out.textContent = payload.percent == null ? 'Đang tải…' : `Đang tải ${payload.percent}%…`;
});
```
and change the first import line of `settings.js` to `import { invoke, listen } from './utils.js';`.

- [ ] **Step 5: Manual check**

Run `cargo tauri dev`. Settings → "Kiểm tra" → with no newer release published expect "Đã là bản mới nhất (0.4.0)" (after Task 10's version bump) or an error text (if no `latest.json` exists yet — acceptable before release). Never silently installs.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/updater.rs src-tauri/src/main.rs src/index.html src/js/dashboard.js src/css/dashboard.css src/settings.html src/js/settings.js
git commit -m "Updater: background check with notification, install only on click, progress and clear results"
```

---

### Task 8: Rust bug fixes — alert spam, sunken floating icon

**Files:**
- Create: `src-tauri/src/alerts.rs`
- Modify: `src-tauri/src/main.rs:352-400` (`check_alerts`), `src-tauri/src/main.rs:961-986` (recovery loop)
- Modify: `src-tauri/Cargo.toml` (add `windows-sys`)

**Interfaces:**
- Produces: `alerts::AlertFlags { warn, crit, limit }`, `alerts::Level { Warning, Critical, Limit }`, `alerts::pick(util, warn_th, crit_th, &mut AlertFlags) -> Option<Level>`.

- [ ] **Step 1: Write failing tests** — `src-tauri/src/alerts.rs`:

```rust
//! Which usage alert to fire. Firing a level also marks every lower level as
//! fired, so 100% → "Limit" is never followed by "Critical" then "Warning".

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct AlertFlags {
    pub warn: bool,
    pub crit: bool,
    pub limit: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    Warning,
    Critical,
    Limit,
}

pub fn pick(util: f64, warn_th: f64, crit_th: f64, f: &mut AlertFlags) -> Option<Level> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_to_full_fires_limit_once_then_nothing() {
        let mut f = AlertFlags::default();
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), Some(Level::Limit));
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), None);
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), None);
    }

    #[test]
    fn climbing_fires_each_level_once() {
        let mut f = AlertFlags::default();
        assert_eq!(pick(0.5, 0.8, 0.95, &mut f), None);
        assert_eq!(pick(0.85, 0.8, 0.95, &mut f), Some(Level::Warning));
        assert_eq!(pick(0.9, 0.8, 0.95, &mut f), None);
        assert_eq!(pick(0.96, 0.8, 0.95, &mut f), Some(Level::Critical));
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), Some(Level::Limit));
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), None);
    }

    #[test]
    fn critical_jump_suppresses_later_warning() {
        let mut f = AlertFlags::default();
        assert_eq!(pick(0.97, 0.8, 0.95, &mut f), Some(Level::Critical));
        assert_eq!(pick(0.85, 0.8, 0.95, &mut f), None);
    }
}
```
Add `mod alerts;` to `main.rs`.

- [ ] **Step 2: Run — expect failure**

Run: `cd src-tauri && cargo test alerts::`
Expected: FAIL — panicked at `not yet implemented`.

- [ ] **Step 3: Implement `pick`**

```rust
pub fn pick(util: f64, warn_th: f64, crit_th: f64, f: &mut AlertFlags) -> Option<Level> {
    if util >= 1.0 && !f.limit {
        *f = AlertFlags { warn: true, crit: true, limit: true };
        Some(Level::Limit)
    } else if util >= crit_th && !f.crit {
        f.warn = true;
        f.crit = true;
        Some(Level::Critical)
    } else if util >= warn_th && !f.warn {
        f.warn = true;
        Some(Level::Warning)
    } else {
        None
    }
}
```

- [ ] **Step 4: Use it in `check_alerts`**

Replace `ProviderState`'s `alert_warn`, `alert_crit`, `alert_limit` with `alert_flags: alerts::AlertFlags`. Replace the body of `check_alerts` from `// A new quota window resets…` to the end of the `let (sub, body) = …` block with:
```rust
    // A new quota window resets which alerts have already fired
    let level = with_state(app, id, |st| {
        if st.alert_reset_at != session.reset_at {
            st.alert_reset_at = session.reset_at.clone();
            st.alert_flags = alerts::AlertFlags::default();
        }
        alerts::pick(util, cfg.alert_threshold, cfg.critical_threshold, &mut st.alert_flags)
    });
    let name = provider_name(id);
    let (sub, body) = match level {
        Some(alerts::Level::Limit) => ("Limit Reached", format!("Session full! Resets in {rst}")),
        Some(alerts::Level::Critical) => ("Critical", format!("Session {pct}%! Resets in {rst}")),
        Some(alerts::Level::Warning) => ("Warning", format!("Session {pct}%. Resets in {rst}")),
        None => return,
    };
```
Run: `cd src-tauri && cargo test alerts:: && cargo build` — expect PASS + build OK.

- [ ] **Step 5: Re-assert topmost every 2 s**

Append to the end of `src-tauri/Cargo.toml` (a separate table, not inside `[dependencies]`):
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_UI_WindowsAndMessaging"] }
```
In `main.rs` add near `show_window`:
```rust
/// Windows can drop WS_EX_TOPMOST from the overlay (display sleep, fullscreen
/// apps, explorer restart) without hiding it, and tao's set_always_on_top is a
/// no-op when its own flag is already set — so push the HWND back to the
/// topmost band directly. NOACTIVATE keeps focus where the user left it.
#[cfg(windows)]
fn reassert_topmost(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    };
    if let Ok(hwnd) = w.hwnd() {
        unsafe {
            SetWindowPos(
                hwnd.0 as _,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }
    }
}
#[cfg(not(windows))]
fn reassert_topmost(_w: &tauri::WebviewWindow) {}
```
In the recovery loop replace the `Some(w) => { … }` arm with:
```rust
                        Some(w) => {
                            if matches!(w.is_visible(), Ok(false)) {
                                let _ = w.show();
                            }
                            reassert_topmost(&w);
                        }
```
Run: `cd src-tauri && cargo build` — expect OK.

- [ ] **Step 6: Manual check**

Run the app; open a maximised window over the icon → icon stays above. Run `taskkill /f /im explorer.exe & start explorer.exe` → within 2 s icon is on top. Confirm focus stays in the window you were typing in (type continuously while it runs).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/alerts.rs src-tauri/src/main.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Fix alert spam after hitting 100% and keep the floating icon in the topmost band"
```

---

### Task 9: Dashboard rebuilds cards whose status changes after load

**Files:**
- Modify: `src/js/dashboard.js` (listeners at top; initial render block)

**Interfaces:**
- Produces: `rebuildCard(id: string) -> Promise<void>` (dashboard-internal).

- [ ] **Step 1: Add `rebuildCard`** after `buildCard`:

```js
// A card built while its provider was disconnected has no rows to fill; when
// the provider connects later (Antigravity is discovered on the first poll,
// or the user re-enables one) swap in a freshly built card in place.
async function rebuildCard(id) {
    const old = document.getElementById(`card-${id}`);
    if (!old) return;
    const p = (await invoke('get_providers')).find(x => x.id === id);
    if (!p) return;
    const card = buildCard(p);
    if (old.classList.contains('expanded')) card.classList.add('expanded');
    old.replaceWith(card);
    if (p.status === 'connected') {
        try { renderUsage(card, id, await invoke('get_usage', { provider: id })); } catch { /* next poll fills it */ }
    }
}
```

- [ ] **Step 2: Call it from the listeners**

Replace the `usage-update` listener with:
```js
listen('usage-update', ({ payload }) => {
    const card = document.getElementById(`card-${payload.provider}`);
    if (!card) return;
    if (!card.querySelector(`#rows-${payload.provider}`)) { rebuildCard(payload.provider); return; }
    renderUsage(card, payload.provider, payload.data);
    updateStatus('Updated just now');
});
```
In the `provider-status-changed` listener, after `if (!card) return;` add:
```js
    if (payload.status === 'connected' && !card.querySelector(`#rows-${payload.provider}`)) { rebuildCard(payload.provider); return; }
```

- [ ] **Step 3: Manual check**

Start the app with Antigravity closed → Antigravity card "Not Connected". Open Antigravity, wait ≤ 60 s → card shows quota rows without reopening the dashboard. Disconnect Codex in Settings, then "Bật lại" → card returns to rows after the next poll.

- [ ] **Step 4: Commit**

```bash
git add src/js/dashboard.js
git commit -m "Dashboard: rebuild a provider card when it connects after the dashboard loaded"
```

---

### Task 10: Release tooling — version, signing key, NSIS hook, manifests, CI

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json` (version `0.4.0`)
- Create: `src-tauri/windows/hooks.nsh`, `scripts/release-manifests.mjs`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Generate a new signing key** (old private key is not on this machine)

```bash
cargo tauri signer generate --ci -p "" -w "$USERPROFILE/.tauri/batradar.key"
```
Copy the printed public key into `tauri.conf.json` → `plugins.updater.pubkey`. Tell the user to store `~/.tauri/batradar.key` in two places (password manager + offline) and add it as GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (file contents), plus secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = empty string.

- [ ] **Step 2: Bump versions**

`src-tauri/Cargo.toml` `version = "0.4.0"`; `src-tauri/tauri.conf.json` `"version": "0.4.0"`; `package.json` `"version": "0.4.0"`.

- [ ] **Step 3: NSIS hook**

`src-tauri/windows/hooks.nsh`:
```nsis
; Runs inside Tauri's NSIS installer. Removes the old Electron build of BatRadar
; so users don't end up with two apps, two tray icons and two autostart entries.
; %APPDATA%\batradar (settings, keys, history) is shared and left untouched.

!include FileFunc.nsh

!macro NSIS_HOOK_PREINSTALL
  StrCpy $0 "$LOCALAPPDATA\Programs\bat-radar"
  IfFileExists "$0\Uninstall BatRadar.exe" 0 electron_done
    DetailPrint "Removing the previous Electron version of BatRadar..."
    ; _?= runs the uninstaller in place so ExecWait really waits for it
    ExecWait '"$0\Uninstall BatRadar.exe" /currentuser /S _?=$0'
    RMDir /r "$0"
  electron_done:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.batradar.app"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; electron-updater passes --force-run; when the install was silent there is
  ; no finish page to launch the app from, so start it here
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  IfErrors postinstall_done
  IfSilent 0 postinstall_done
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  postinstall_done:
!macroend
```
`src-tauri/tauri.conf.json` → `bundle.windows.nsis` add `"installerHooks": "./windows/hooks.nsh"`.

- [ ] **Step 4: Manifest script**

`scripts/release-manifests.mjs`:
```js
// Writes the two update manifests for a release, next to the NSIS installer:
//   latest.json — read by the Tauri updater (0.4.0+)
//   latest.yml  — read by the old Electron updater (0.2.x/0.3.x) so those users
//                 are offered the Tauri installer as their next update
// Usage: node scripts/release-manifests.mjs <version> [notes]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [version, notes = `BatRadar ${version}`] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    console.error('usage: node scripts/release-manifests.mjs <x.y.z> [notes]');
    process.exit(1);
}
const dir = 'src-tauri/target/release/bundle/nsis';
const exe = `BatRadar_${version}_x64-setup.exe`;
const exePath = join(dir, exe);
const url = `https://github.com/ZenithHawking/BatRadar/releases/download/v${version}/${exe}`;
const now = new Date().toISOString();

const latestJson = {
    version,
    notes,
    pub_date: now,
    platforms: {
        'windows-x86_64': { signature: readFileSync(`${exePath}.sig`, 'utf8').trim(), url },
    },
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(latestJson, null, 2) + '\n');

const sha512 = createHash('sha512').update(readFileSync(exePath)).digest('base64');
const size = statSync(exePath).size;
const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${exe}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${exe}`,
    `sha512: ${sha512}`,
    `releaseDate: '${now}'`,
    '',
].join('\n');
writeFileSync(join(dir, 'latest.yml'), yml);
console.log(`wrote latest.json + latest.yml for ${exe} (${size} bytes)`);
```

- [ ] **Step 5: Local build**

```bash
export TAURI_SIGNING_PRIVATE_KEY="$USERPROFILE/.tauri/batradar.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
cargo tauri build
node scripts/release-manifests.mjs 0.4.0
ls src-tauri/target/release/bundle/nsis
```
Expected: `BatRadar_0.4.0_x64-setup.exe`, `.exe.sig`, `latest.json`, `latest.yml`; installer ≈ 5 MB.

- [ ] **Step 6: CI workflow**

Replace `.github/workflows/release.yml` with:
```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install Tauri CLI
        run: cargo install tauri-cli --version "^2" --locked

      - name: Test
        run: node --test src/js/season/

      - name: Build
        run: cargo tauri build
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}

      - name: Update manifests
        shell: bash
        run: node scripts/release-manifests.mjs "${GITHUB_REF_NAME#v}"

      # Draft: a human checks the assets before users are offered the update
      - uses: softprops/action-gh-release@v2
        with:
          name: BatRadar ${{ github.ref_name }}
          draft: true
          files: |
            src-tauri/target/release/bundle/nsis/*.exe
            src-tauri/target/release/bundle/nsis/*.sig
            src-tauri/target/release/bundle/nsis/latest.json
            src-tauri/target/release/bundle/nsis/latest.yml
          body: |
            ## BatRadar ${{ github.ref_name }}

            ### Cài đặt
            Tải file `BatRadar_*_x64-setup.exe` và chạy. Bản cũ (Electron) được gỡ tự động, cài đặt được giữ nguyên.

            ### Yêu cầu
            - Windows 10/11
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json package.json src-tauri/windows/hooks.nsh scripts/release-manifests.mjs .github/workflows/release.yml
git commit -m "Release 0.4.0 tooling: new updater key, Electron cleanup hook, update manifests, Tauri CI build"
```

---

### Task 11: Migration test on this machine (manual, gate before publishing)

- [ ] **Step 1:** Stop any running BatRadar. Delete HKCU Run value `BatRadar` (points at `target\debug\batradar.exe` from development): `reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v BatRadar /f`. Back up `%APPDATA%\batradar` to the scratchpad.
- [ ] **Step 2:** Install Electron 0.3.0: `gh release download v0.3.0 -p "BatRadar-Setup-0.3.0.exe"` and run it. Confirm `%LOCALAPPDATA%\Programs\bat-radar` exists and Run value `com.batradar.app` exists.
- [ ] **Step 3:** Point the installed Electron app at a local feed: replace `%LOCALAPPDATA%\Programs\bat-radar\resources\app-update.yml` with:
```yaml
provider: generic
url: http://127.0.0.1:8765/
updaterCacheDirName: bat-radar-updater
```
Serve `src-tauri/target/release/bundle/nsis/` on port 8765 (`npx http-server -p 8765` or a small node server).
- [ ] **Step 4:** Start Electron BatRadar → expect "update available 0.4.0" dialog → accept → installer runs.
- [ ] **Step 5:** Verify:
  - `Get-Process BatRadar` shows only the Tauri binary path (`%LOCALAPPDATA%\BatRadar\…`);
  - `%LOCALAPPDATA%\Programs\bat-radar` is gone;
  - HKCU Run has no `com.batradar.app`; has `BatRadar` only if autostart was on;
  - `%APPDATA%\batradar\config.json`, `openrouter.enc`, `history.jsonl` unchanged (compare with backup);
  - dashboard shows Halloween; icon shows the pumpkin; Settings shows version 0.4.0.
- [ ] **Step 6:** Also run the 0.4.0 installer directly on a machine state without Electron (uninstall Tauri, run setup.exe) → installs cleanly, hook does nothing.
- [ ] **Step 7:** If Step 4–5 fail because of installer arguments, stop and report — fallback is an Electron 0.3.1 "bridge" release (spec §9), which needs its own plan.

---

### Task 12: Remove Electron from the repo

Only after Task 11 passes.

**Files:**
- Delete: `main.js`, `preload.js`, `RELEASE_NOTES_v0.2.2.md`, `RELEASE_NOTES_v0.2.3.md`
- Modify: `package.json`, `package-lock.json`, `src/js/utils.js`, `src/js/floating.js`, `src-tauri/src/main.rs`, `README.md`, `landing/index.html`

- [ ] **Step 1: Delete files**

```bash
git rm -q main.js preload.js RELEASE_NOTES_v0.2.2.md RELEASE_NOTES_v0.2.3.md
```

- [ ] **Step 2: `package.json`** — replace whole file with:
```json
{
  "name": "bat-radar",
  "version": "0.4.0",
  "private": true,
  "description": "BatRadar - AI Tools Usage Monitor",
  "author": "BatRadar",
  "type": "module",
  "scripts": {
    "dev": "cargo tauri dev",
    "build": "cargo tauri build",
    "test": "node --test src/js/season/"
  }
}
```
Then `rm -rf node_modules package-lock.json && npm install` (creates an empty lockfile).
Run: `npm test` → PASS (confirms `"type": "module"` is fine for the test files).

- [ ] **Step 3: `src/js/utils.js`** — replace the runtime bridge block (lines 1-11) with:
```js
const TAURI = window.__TAURI__;

export const invoke = (cmd, args) => TAURI.core.invoke(cmd, args || {});
export const listen = (event, cb) => TAURI.event.listen(event, cb);
```

- [ ] **Step 4: Drop `set_float_interactive`** — delete the command and its comment in `main.rs` (`/// Kept for renderer compatibility with the Electron build` + fn) and its `generate_handler!` entry. Run `grep -rn "set_float_interactive" src src-tauri/src` → expect no matches. Fix the comment in `main.rs` mentioning "Mirrors the Electron build's `floatingIntentionallyHidden`" to "Set when the user hides the icon on purpose".

- [ ] **Step 5: README** — replace the Electron badge line with:
```markdown
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri)
```
Replace the whole "## Building from source" section (from its heading to the next `---`) with:
```markdown
## Building from source

Requires the Rust toolchain, the MSVC build tools ("Desktop development with C++") and the Tauri CLI (`cargo install tauri-cli --version "^2"`).

```bash
cargo tauri dev     # run with hot-reloaded UI
cargo tauri build   # installer in src-tauri/target/release/bundle/nsis/
npm test            # seasonal-theme unit tests (Node 18+)
```

Upgrading from 0.3.x (Electron): the normal in-app update installs 0.4.0 and removes the old version automatically; settings in `%APPDATA%\batradar` are kept.
```
Replace "## Running from Source" section (heading through its build-installer code block) with a one-line pointer: `See [Building from source](#building-from-source).`
In "## Project Structure" replace the `main.js` / `preload.js` lines and the `src-tauri/` line with:
```
├── src-tauri/           # Rust backend — windows, tray, polling, IPC, updater, history log
├── themes/              # Seasonal themes + schedule, fetched by the app from GitHub
```
and add under `src/js/`: `│   │   ├── season/      # Seasonal theme engine (+ node:test suites)`.
Add a section before "## Privacy":
```markdown
## Seasonal themes

The app checks `themes/schedule.json` on GitHub every 6 hours and dresses the dashboard and floating icon for the current event (e.g. Halloween). To add one: create `themes/<id>/theme.json` + SVGs, add a dated entry to the schedule, copy the folder into `src/themes/` (offline fallback), run `npm test`, push to `main`. Turn it off in Settings → "Giao diện theo mùa".
```

- [ ] **Step 6: Landing page** — in `landing/index.html`: change `<span>~80 MB</span>` to `<span>~5 MB</span>`; change `data-count-to="80"` to `data-count-to="5"`; change `BatRadar Setup x.x.x.exe` (3 places) to `BatRadar_x.x.x_x64-setup.exe`; change the two `faq.3.a` strings and the visible FAQ body to "Not yet. The app is built with Tauri, so a port is plausible, but the installer is Windows-only right now." / "Chưa có. App viết bằng Tauri nên port được, nhưng hiện tại chỉ có installer cho Windows."

- [ ] **Step 7: Verify**

Run: `grep -rni "electron" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=docs . | grep -v "^./landing/.*\.png"`
Expected: only the README upgrade note and `hooks.nsh` / `release-manifests.mjs` comments (intentional).
Run: `npm test && cd src-tauri && cargo build` → PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Remove the Electron runtime; Tauri is the only build"
```

---

### Task 13: Publish (requires the user's explicit go-ahead)

- [ ] **Step 1:** Ask the user to confirm: GitHub secrets set, key backed up, Task 11 passed.
- [ ] **Step 2:** Merge `seasonal-themes` into `main` and push (`themes/` must be live on `main` before users get 0.4.0).
- [ ] **Step 3:** `curl -s https://raw.githubusercontent.com/ZenithHawking/BatRadar/main/themes/schedule.json` → expect the Halloween entry.
- [ ] **Step 4:** `git tag v0.4.0 && git push origin v0.4.0` → CI builds a **draft** release.
- [ ] **Step 5:** Download the draft's `latest.yml`, `latest.json`, installer; check `sha512`/`size` match the exe and `latest.json` URL points at `releases/download/v0.4.0/…`.
- [ ] **Step 6:** With the user's confirmation, publish the draft (`gh release edit v0.4.0 --draft=false`). From this moment Electron users see the update.
- [ ] **Step 7:** Update memory note `batradar-size-tauri.md`: 0.4.0 shipped on Tauri, Electron removed, key location.
