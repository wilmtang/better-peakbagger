// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createPeakCardLayout } from '../../src/ui/peak-card-layout.js';
import { settingsSchema as schema } from '../../src/settings/settings-schema.js';
import { pointerEvent } from '../helpers/pointer-event.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup({ saved = {}, read, fail = false, snow = true, lateSunListener = false, holdWrites = false, columns = false } = {}) {
    const dom = new JSDOM(`<form><table><tbody><tr id="map"><td colspan="2"><iframe id="Gmap"></iframe><a id="legend">Native legend</a>
        <section class="bpb-sun-calculator--peak"><button type="button" class="bpb-sun-calculator__toggle" aria-expanded="true">Sun & Moon</button><div class="bpb-sun-calculator__panel"><input></div></section></td></tr>
        <tr id="bpb-peak-weather-row"><td colspan="2"><section id="bpb-peak-weather"><header><div class="bpb-week-heading"><h2>Summit weather</h2><span class="bpb-week-location-name">At the summit</span><span class="bpb-week-map-hint">Right-click the map for weather at any point.</span></div><div class="bpb-week-actions"><button type="button">Refresh</button></div></header><p>Forecast</p></section></td></tr>
        ${snow ? '<tr id="bpb-peak-snow-row"><td colspan="2"><section id="bpb-peak-snow"><header><h2>Nearby snow</h2></header><div class="bpb-snow-station-controls"><label for="station">SNOTEL station</label><div class="bpb-snow-station-row"><select id="station"><option>Paradise</option></select><button type="button">Refresh</button></div></div><p>Snow readings</p></section></td></tr>' : ''}
        <tr id="native"><td>Native details</td></tr></tbody></table></form>`, { pretendToBeVisual: true });
    if (columns) {
        const details = dom.window.document.createElement('table');
        details.innerHTML = '<tr><td>Latitude/Longitude (WGS84)</td><td>46, -121</td></tr>';
        dom.window.document.querySelector('table').before(details);
    }
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
    if (columns) for (const [id, left] of [['details', 0], ['map', 320]]) {
        doc.getElementById(`bpb-peak-${id}-column`).getBoundingClientRect = () => ({ left, right: left + 300, top: 0, bottom: 700, width: 300, height: 700 });
    }
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

test('weather and snow use a dedicated disclosure row and keep actions inside their expanded content', async () => {
    const env = setup();
    try {
        await tick();
        for (const key of ['weather', 'snow']) {
            const card = env.card(key), header = card.querySelector('header'), body = card.querySelector('.bpb-peak-card-body');
            const toggle = header.querySelector('.bpb-peak-card-toggle'), refresh = body.querySelector('button');
            assert.equal(header.querySelectorAll('button').length, 2, 'only disclosure and reorder belong in the first row');
            assert.equal(toggle.lastElementChild.tagName.toLowerCase(), 'svg');
            assert.equal(toggle.lastElementChild.getAttribute('aria-hidden'), 'true');
            assert.equal(toggle.lastElementChild.querySelector('polyline').getAttribute('points'), '3 6 8 11 13 6');
            refresh.click(); await tick();
            assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'Refresh does not toggle the disclosure');
            toggle.click(); await tick(); assert.equal(body.hidden, true);
            assert.equal(header.contains(refresh), false, 'collapsed cards have no exposed Refresh action');
            toggle.click(); await tick(); assert.equal(body.hidden, false);
        }
        const context = env.card('weather').querySelector('.bpb-peak-card-body .bpb-week-heading');
        assert.equal(context.querySelector('.bpb-week-location-name').textContent, 'At the summit');
        assert.match(context.querySelector('.bpb-week-map-hint').textContent, /Right-click/);
        assert.equal(env.card('snow').querySelector('.bpb-peak-card-toolbar'), null, 'snow has no empty toolbar reserving another row');
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


test('native peak columns expose a keyboard-resizable divider without moving unrelated tables', async () => {
    const dom = new JSDOM(readFileSync(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8'), {
        url: 'https://www.peakbagger.com/peak.aspx?pid=2296', pretendToBeVisual: true,
    });
    const doc = dom.window.document;
    const map = doc.getElementById('Gmap'), mapTable = map.closest('table'), details = mapTable.previousElementSibling;
    const state = schema.clean({});
    const layout = createPeakCardLayout({ document: doc, settings: {
        DEFAULTS: schema.DEFAULTS, clean: schema.clean, requireCurrent: async () => state,
        subscribe: () => () => {}, set: async () => {},
    } });
    try {
        const handle = doc.querySelector('#bpb-peak-table-resize-handle');
        assert.ok(handle, 'peak details and map need a visible, keyboard-operable divider');
        assert.equal(handle.getAttribute('role'), 'separator');
        assert.equal(doc.getElementById('bpb-peak-details-column').firstElementChild, details);
        assert.equal(doc.getElementById('bpb-peak-map-column').firstElementChild, mapTable);
        assert.equal(doc.getElementById('Gmap'), map, 'the existing map element is retained');
        handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        assert.equal(handle.getAttribute('aria-valuenow'), '75');
        assert.equal(JSON.parse(dom.window.localStorage.getItem('pbPeakTableSplit.v1')).leftPercent, 75);
        handle.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
        assert.equal(handle.getAttribute('aria-valuenow'), '49');
    } finally { layout.lifecycle.dispose(); dom.window.close(); }
});


test('column movement preserves node identity, disclosures, persistence and vertical order', async () => {
    const env = setup({ columns: true, saved: { peakSnowCollapsed: true } });
    try {
        await tick();
        const snow = env.card('snow'), weather = env.card('weather');
        env.key('snow', 'ArrowLeft'); env.key('weather', 'ArrowLeft'); await tick();
        const left = () => [...env.doc.querySelectorAll('#bpb-peak-details-column [data-bpb-peak-card]')].map(card => card.dataset.bpbPeakCard);
        assert.deepEqual(left(), ['snow', 'weather']);
        assert.equal(env.card('snow'), snow); assert.equal(env.card('weather'), weather);
        assert.equal(snow.querySelector('.bpb-peak-card-body').hidden, true);
        env.key('weather', 'ArrowUp'); await tick(); assert.deepEqual(left(), ['weather', 'snow']);
        assert.equal(env.doc.activeElement, env.handle('weather'));
        assert.deepEqual(env.state.peakCardColumns, { sun: 'map', weather: 'details', snow: 'details' });
        const next = setup({ columns: true, saved: env.state });
        try { await tick(); assert.deepEqual(next.order(), env.order()); } finally { next.close(); }
        env.key('weather', 'ArrowRight'); await tick();
        assert.equal(env.card('weather').closest('#bpb-peak-map-column')?.id, 'bpb-peak-map-column');
        assert.equal(env.doc.querySelector('#Gmap').closest('tr').id, 'map');
    } finally { env.close(); }
});

test('an empty opposite column accepts a pointer drop only on release and the grip offers move buttons', async () => {
    const env = setup({ columns: true });
    try {
        await tick();
        env.pointer('pointerdown', 360, env.handle('snow'), 370); env.pointer('pointermove', 110, env.win, 50);
        assert.equal(env.state.peakCardColumns.snow, 'map'); assert.equal(env.writes.length, 0);
        env.pointer('pointerup', 110, env.win, 50); await tick();
        assert.equal(env.state.peakCardColumns.snow, 'details');
        env.handle('weather').click();
        const menu = [...env.doc.querySelectorAll('.bpb-layout-menu')].find(node => !node.hidden);
        assert.ok(menu); [...menu.querySelectorAll('button')].find(button => button.textContent === 'Move to left column').click(); await tick();
        assert.equal(env.state.peakCardColumns.weather, 'details');
        assert.equal(env.doc.activeElement, env.handle('weather'));
        const before = env.order();
        env.pointer('pointerdown', 360, env.handle('snow'), 50); env.pointer('pointermove', 110, env.win, 370);
        env.win.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        env.pointer('pointerup', 110, env.win, 370); await tick();
        assert.deepEqual(env.order(), before); assert.equal(env.state.peakCardColumns.snow, 'details');
    } finally { env.close(); }
});
