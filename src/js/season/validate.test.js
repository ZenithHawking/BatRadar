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
