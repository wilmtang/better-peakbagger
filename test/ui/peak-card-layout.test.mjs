// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPeakCardLayout } from '../../src/ui/peak-card-layout.js';
import { settingsSchema as schema } from '../../src/settings/settings-schema.js';
import { pointerEvent } from '../helpers/pointer-event.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup({ saved = {}, read, fail = false, snow = true, lateSunListener = false, holdWrites = false } = {}) {
    const dom = new JSDOM(`<form><table><tbody><tr id="map"><td colspan="2"><iframe id="Gmap"></iframe><a id="legend">Native legend</a>
        <section class="bpb-sun-calculator--peak"><button type="button" class="bpb-sun-calculator__toggle" aria-expanded="true">Sun & Moon</button><div class="bpb-sun-calculator__panel"><input></div></section></td></tr>
        <tr id="bpb-peak-weather-row"><td colspan="2"><section id="bpb-peak-weather"><header><div class="bpb-week-heading"><h2>Summit weather</h2></div><button type="button">Refresh</button></header><p>Forecast</p></section></td></tr>
        ${snow ? '<tr id="bpb-peak-snow-row"><td colspan="2"><section id="bpb-peak-snow"><header><h2>Nearby snow</h2><button type="button">Refresh</button></header><p>Snow readings</p></section></td></tr>' : ''}
        <tr id="native"><td>Native details</td></tr></tbody></table></form>`, { pretendToBeVisual: true });
    const win = dom.window, doc = win.document, listeners = new Set(), writes = [], commits = [];
    let state = schema.clean(saved), failing = fail;
    const settings = { DEFAULTS: schema.DEFAULTS, clean: schema.clean, requireCurrent: read || (async () => state),
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        set: async patch => {
            writes.push(patch);
            if (holdWrites) await new Promise(resolve => commits.push(resolve));
            if (failing) throw new Error('Quota exceeded');
            state = schema.clean({ ...state, ...patch }); listeners.forEach(fn => fn(state)); return state;
        } };
    const sun = doc.querySelector('.bpb-sun-calculator__toggle'), panel = doc.querySelector('.bpb-sun-calculator__panel');
    const nativeToggle = () => { sun.setAttribute('aria-expanded', String(sun.getAttribute('aria-expanded') !== 'true')); panel.hidden = sun.getAttribute('aria-expanded') === 'false'; };
    if (!lateSunListener) sun.addEventListener('click', nativeToggle);
    const layout = createPeakCardLayout({ document: doc, settings });
    if (lateSunListener) sun.addEventListener('click', nativeToggle);
    const order = () => [...doc.querySelectorAll('[data-bpb-peak-card]')].map(node => node.dataset.bpbPeakCard);
    const card = key => doc.querySelector(`[data-bpb-peak-card="${key}"]`);
    const handle = key => card(key).querySelector('.bpb-peak-card-grip');
    for (const key of schema.PEAK_CARD_ORDER) if (card(key)) {
        const rect = () => { const top = order().indexOf(key) * 120 + 100; return { left: 20, right: 320, top, bottom: top + 100, width: 300, height: 100 }; };
        card(key).getBoundingClientRect = rect; card(key).closest('tr').getBoundingClientRect = rect;
        handle(key).scrollIntoView = () => {};
    }
    return { win, doc, layout, writes, commits, order, card, handle, sun, panel,
        get state() { return state; }, set failing(value) { failing = value; },
        update: patch => { state = schema.clean({ ...state, ...patch }); listeners.forEach(fn => fn(state)); },
        key: (key, input) => handle(key).dispatchEvent(new win.KeyboardEvent('keydown', { key: input, bubbles: true, cancelable: true })),
        pointer: (type, y, target = win, x = 50) => target.dispatchEvent(pointerEvent(win, type, { pointerId: 1, clientX: x, clientY: y })),
        close: () => { layout.lifecycle.dispose(); win.close(); } };
}

test('cards restore validated order and disclosures while preserving the native map and legend', async () => {
    const env = setup({ saved: { peakCardOrder: ['snow', 'sun', 'weather'], peakWeatherCollapsed: true, peakSunCollapsed: true } });
    try {
        await tick();
        assert.deepEqual(env.order(), ['snow', 'sun', 'weather']);
        assert.equal(env.doc.querySelector('#Gmap').closest('tr').id, 'map');
        assert.equal(env.doc.querySelector('#legend').closest('tr').id, 'map');
        assert.equal(env.card('weather').querySelector('.bpb-peak-card-body').hidden, true);
        assert.equal(env.panel.hidden, true); assert.equal(env.sun.getAttribute('aria-expanded'), 'false');
        assert.equal(env.doc.querySelectorAll('.bpb-peak-card-grip').length, 3);
        assert.equal(env.writes.length, 0, 'restoring a Sun & Moon disclosure does not rewrite settings');
        env.sun.click(); await tick();
        assert.deepEqual(env.writes.at(-1), { peakSunCollapsed: false });
    } finally { env.close(); }
});

test('Sun & Moon clicks survive MAIN listeners running after isolated listeners', async () => {
    const env = setup({ lateSunListener: true });
    try {
        await tick(); env.sun.click(); await tick();
        assert.equal(env.panel.hidden, true); assert.equal(env.state.peakSunCollapsed, true);
        env.sun.click(); await tick();
        assert.equal(env.panel.hidden, false); assert.equal(env.state.peakSunCollapsed, false);
    } finally { env.close(); }
});

test('keyboard ordering, hidden-card positions and independent collapse fields survive another page', async () => {
    const env = setup();
    try {
        await tick();
        env.card('snow').querySelector('.bpb-peak-card-toggle').click();
        env.key('snow', 'Home'); await tick();
        assert.deepEqual(env.order(), ['snow', 'sun', 'weather']);
        assert.equal(env.doc.activeElement, env.handle('snow'));
        assert.deepEqual(env.writes[0], { peakSnowCollapsed: true });
        env.card('sun').hidden = true; await tick();
        env.key('weather', 'Home'); await tick();
        assert.deepEqual(env.order(), ['weather', 'sun', 'snow'], 'hidden slots are preserved when visible cards move');
        const next = setup({ saved: env.state });
        try { await tick(); assert.deepEqual(next.order(), env.order()); assert.equal(next.card('snow').querySelector('.bpb-peak-card-body').hidden, true); }
        finally { next.close(); }
    } finally { env.close(); }
});

test('pointer reordering commits only on drop and Escape or outside-column drops preserve order', async () => {
    const env = setup();
    try {
        await tick();
        for (const cancel of ['escape', 'outside']) {
            env.pointer('pointerdown', 360, env.handle('snow')); env.pointer('pointermove', 110);
            assert.deepEqual(env.order(), ['sun', 'weather', 'snow'], 'drag preview does not reflow the cards');
            if (cancel === 'escape') env.win.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            else env.pointer('pointerup', 110, env.win, 700);
            assert.equal(env.writes.length, 0);
            assert.equal(env.doc.querySelector('.bpb-peak-card-ghost').hidden, true);
        }
        env.pointer('pointerdown', 360, env.handle('snow')); env.pointer('pointermove', 110); env.pointer('pointerup', 110);
        assert.deepEqual(env.order(), ['snow', 'sun', 'weather']);
        assert.equal(env.writes.length, 1); assert.equal(env.doc.activeElement, env.handle('snow'));
    } finally { env.close(); }
});

test('late reads cannot undo user changes and failed saves remain usable, dismissible and retryable', async () => {
    let release;
    const env = setup({ read: () => new Promise(resolve => { release = resolve; }), fail: true });
    try {
        env.card('snow').querySelector('.bpb-peak-card-toggle').click(); await tick();
        release(schema.clean({ peakSnowCollapsed: false })); await tick();
        assert.equal(env.card('snow').querySelector('.bpb-peak-card-body').hidden, true);
        const status = env.doc.querySelector('.bpb-peak-card-status');
        assert.equal(status.classList.contains('bpb-peak-card-sr'), false); assert.match(status.textContent, /could not be saved/);
        status.querySelector('button').click(); assert.equal(status.classList.contains('bpb-peak-card-sr'), true);
        env.failing = false; env.card('snow').querySelector('.bpb-peak-card-toggle').click(); await tick();
        assert.equal(status.hasAttribute('data-error'), false);
        assert.equal(env.card('snow').querySelector('.bpb-peak-card-body').hidden, false);
    } finally { env.close(); }
});

test('earlier queued writes cannot bounce a newer disclosure or reorder intent', async () => {
    const env = setup({ holdWrites: true });
    try {
        await tick();
        const toggle = env.card('snow').querySelector('.bpb-peak-card-toggle');
        toggle.click(); toggle.click();
        assert.equal(env.card('snow').querySelector('.bpb-peak-card-body').hidden, false);
        env.commits.shift()(); await tick();
        assert.equal(env.card('snow').querySelector('.bpb-peak-card-body').hidden, false);
        env.commits.shift()(); await tick();
        env.key('snow', 'Home'); env.key('snow', 'End');
        assert.deepEqual(env.order(), ['sun', 'weather', 'snow']);
        env.commits.shift()(); await tick();
        assert.deepEqual(env.order(), ['sun', 'weather', 'snow']);
        env.commits.shift()(); await tick();
        assert.deepEqual(env.state.peakCardOrder, ['sun', 'weather', 'snow']);
    } finally { env.close(); }
});

test('explicit map requests reveal a collapsed card before its owner focuses the content', async () => {
    const env = setup({ saved: { peakSnowCollapsed: true, peakWeatherCollapsed: true } });
    try {
        await tick();
        for (const key of ['snow', 'weather']) {
            env.card(key).dispatchEvent(new env.win.Event('bpb:reveal-card'));
            assert.equal(env.card(key).querySelector('.bpb-peak-card-body').hidden, false);
        }
        await tick(); assert.equal(env.state.peakSnowCollapsed, false); assert.equal(env.state.peakWeatherCollapsed, false);
    } finally { env.close(); }
});

test('late cards, feature visibility, bfcache and disposal keep one layout owner', async () => {
    const env = setup({ snow: false, saved: { peakCardOrder: ['snow', 'weather', 'sun'], peakSunCollapsed: true } });
    try {
        await tick();
        const row = env.doc.createElement('tr'); row.id = 'bpb-peak-snow-row';
        row.innerHTML = '<td><section id="bpb-peak-snow"><header><h2>Nearby snow</h2><button>Refresh</button></header><p>Snow</p></section></td>';
        env.doc.querySelector('tbody').append(row); await tick();
        assert.deepEqual(env.order(), ['snow', 'weather', 'sun']);
        env.sun.disabled = true; env.sun.setAttribute('aria-expanded', 'false'); await tick();
        env.sun.disabled = false; env.sun.setAttribute('aria-expanded', 'true'); env.panel.hidden = false; await tick();
        assert.equal(env.panel.hidden, true, 'late calculator availability keeps the saved disclosure');
        env.pointer('pointerdown', 100, env.handle('weather')); env.pointer('pointermove', 200);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(env.doc.querySelector('.bpb-peak-card-ghost').hidden, true);
        env.win.dispatchEvent(new env.win.PageTransitionEvent('pageshow', { persisted: true })); await tick();
        assert.equal(env.doc.querySelectorAll('.bpb-peak-card-grip').length, 3);
        env.layout.lifecycle.dispose(); env.key('weather', 'Home');
        assert.equal(env.writes.length, 0);
    } finally { env.close(); }
});
