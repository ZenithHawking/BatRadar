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
