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

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
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
