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
