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
