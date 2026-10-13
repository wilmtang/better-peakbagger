// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { loadPage, PAGE_FIXTURES, makeChromeStub } from '../helpers/load-page.mjs';
import { enablePeakLinkOrder } from '../../src/maps/peak-link-order.js';
import { settingsSchema } from '../../src/settings/settings-schema.js';

// The built bundle (IIFE) stands in for the injected content script.
const source = await readFile(new URL('../../dist/content/peak-links.js', import.meta.url), 'utf8');

const loadPeak = fixture => loadPage(fixture, {
    url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
    bundles: ['content/peak-links.js'],
    fixtures: PAGE_FIXTURES
});

const linkByText = (document, text) => Array.from(document.querySelectorAll('#bpb-peak-links a'))
    .find(anchor => anchor.textContent === text);

test('web map additions identify BPB, preserve native links and target the displayed peak', async () => {
    for (const fixture of ['peak-rainier.html', 'peak-garibaldi.html']) {
        const dom = await loadPeak(fixture);
        const doc = dom.window.document, group = doc.getElementById('bpb-peak-map-links');
        const coordinate = [...doc.querySelectorAll('tr')].find(row => row.cells[0]?.textContent.trim() === 'Latitude/Longitude (WGS84)')
            .cells[1].textContent.match(/^([\d.-]+), ([\d.-]+)/);
        const [, lat, lon] = coordinate;
        assert.equal(group.getAttribute('aria-label'), 'Maps added by Better Peakbagger');
        assert.equal(group.closest('tr').cells[0].textContent, 'Web Map Links');
        const nativeLinks = [...group.parentElement.querySelectorAll('a')].filter(link => !group.contains(link));
        assert.ok(nativeLinks.some(link => link.textContent === 'CalTopo'));
        const originalLinks = nativeLinks.map(link => link.outerHTML);
        const [gaia, alltrails, onx] = group.querySelectorAll('a');
        assert.deepEqual([gaia, alltrails, onx].map(link => link.textContent), ['Gaia GPS', 'AllTrails', 'onX Backcountry']);
        assert.equal(new URL(gaia.href).searchParams.get('loc'), `13/${lon}/${lat}`);
        assert.equal(new URL(onx.href).searchParams.get('latlon'), `${lat},${lon},13`);
        const bounds = new URL(alltrails.href).searchParams;
        assert.ok(Number(bounds.get('b_br_lat')) < Number(lat) && Number(bounds.get('b_tl_lat')) > Number(lat));
        assert.ok(Number(bounds.get('b_tl_lng')) < Number(lon) && Number(bounds.get('b_br_lng')) > Number(lon));
        for (const link of group.querySelectorAll('a')) {
            assert.equal(link.target, '_blank');
            assert.equal(link.rel, 'noopener noreferrer');
        }
        dom.window.eval(source);
        assert.equal(doc.querySelectorAll('#bpb-peak-map-links').length, 1);
        assert.deepEqual(nativeLinks.map(link => link.outerHTML), originalLinks);
        dom.window.close();
    }
});

test('web map additions work without general Links, clip geographic bounds and reject ambiguous rows', () => {
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]]) {
        const dom = new JSDOM(`<table><tr><td>Latitude/Longitude (WGS84)</td><td>${lat}, ${lon} (Dec Deg)</td></tr></table>
            <table class="gray" align="right"><tr><td>Web Map Links</td><td><a href="https://caltopo.com/">CalTopo</a></td></tr></table>`,
        { url: 'https://www.peakbagger.com/Peak.aspx?pid=1', runScripts: 'outside-only' });
        dom.window.eval(source);
        const group = dom.window.document.getElementById('bpb-peak-map-links');
        const bounds = new URL([...group.querySelectorAll('a')].find(link => link.textContent === 'AllTrails').href).searchParams;
        for (const key of ['b_tl_lat', 'b_br_lat']) assert.ok(Math.abs(Number(bounds.get(key))) <= 90);
        for (const key of ['b_tl_lng', 'b_br_lng']) assert.ok(Math.abs(Number(bounds.get(key))) <= 180);
        group.remove();
        const table = dom.window.document.querySelector('table[align]');
        table.rows[0].after(table.rows[0].cloneNode(true));
        dom.window.eval(source);
        assert.equal(dom.window.document.getElementById('bpb-peak-map-links'), null);
        dom.window.close();
    }
});

test('Peak.aspx gains location-specific Windy and Copernicus links', async () => {
    const cases = [
        {
            fixture: 'peak-rainier.html',
            lat: '46.851731',
            lon: '-121.760395',
            // United States also gains the AirNow link.
            expectedLinks: 4
        },
        {
            fixture: 'peak-garibaldi.html',
            lat: '49.850562',
            lon: '-123.004672',
            // Canada also gains the AirNow link.
            expectedLinks: 4
        }
    ];

    for (const { fixture, lat, lon, expectedLinks } of cases) {
        const dom = await loadPeak(fixture);
        const { document } = dom.window;
        const panel = document.getElementById('bpb-peak-links');
        assert.ok(panel, `${fixture} should receive the planning-links panel`);
        assert.equal(panel.getAttribute('aria-labelledby'), 'bpb-peak-links-heading');
        assert.equal(
            panel.querySelector('.bpb-peak-links__heading').textContent,
            'Better Peakbagger links'
        );
        assert.equal(panel.querySelectorAll('.bpb-peak-links__item').length, expectedLinks);
        const avalanche = linkByText(document, fixture === 'peak-rainier.html'
            ? 'Avalanche forecasts — Avalanche.org' : 'Avalanche forecasts — Avalanche Canada');
        assert.equal(avalanche.href, fixture === 'peak-rainier.html'
            ? 'https://avalanche.org/' : `https://avalanche.ca/map?lat=${lat}&lng=${lon}`);
        assert.equal(avalanche.nextElementSibling.textContent, 'Find the regional bulletin for this peak.');
        assert.deepEqual([...panel.querySelectorAll('a')].map(link => link.textContent), [
            'Windy summit forecast', 'Copernicus satellite imagery', 'AirNow fire & smoke', avalanche.textContent,
        ]);

        const windy = linkByText(document, 'Windy summit forecast');
        assert.equal(windy.href, `https://www.windy.com/${lat}/${lon}`);

        const copernicus = linkByText(document, 'Copernicus satellite imagery');
        assert.equal(
            copernicus.href,
            `https://browser.dataspace.copernicus.eu/?zoom=13&lat=${lat}&lng=${lon}&themeId=DEFAULT-THEME`
        );
        assert.equal(
            copernicus.parentElement.querySelector('.bpb-peak-links__detail').textContent,
            'Browse images by date and cloud cover, or choose Sentinel-2 in the map’s layer menu.'
        );

        const fireSmoke = linkByText(document, 'AirNow fire & smoke');
        assert.equal(fireSmoke.href, `https://fire.airnow.gov/#9/${lat}/${lon}`);
        assert.equal(linkByText(document, 'NOAA snow depth'), undefined);

        for (const anchor of [avalanche, windy, copernicus, fireSmoke]) {
            assert.equal(anchor.target, '_blank');
            assert.equal(anchor.rel, 'noopener noreferrer');
        }

        const linksHeading = Array.from(panel.closest('td').querySelectorAll('b'))
            .find(element => element.textContent.trim() === 'Links');
        assert.ok(linksHeading.compareDocumentPosition(panel) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
        dom.window.close();
    }
});

const renderNationPeak = nation => {
    const nationRow = nation === null
        ? ''
        : `<tr><td valign="top">Nation</td><td>${nation}</td></tr>`;
    const dom = new JSDOM(
        '<!doctype html><table>'
        + '<tr><td>Latitude/Longitude (WGS84)</td><td>40.0, -105.0 (Dec Deg)</td></tr>'
        + nationRow
        + '<tr><td colspan="2"><b>Links</b><br><br>Native links</td></tr>'
        + '</table>',
        { url: 'https://www.peakbagger.com/Peak.aspx?pid=1', runScripts: 'outside-only' }
    );
    dom.window.eval(source);
    return dom.window.document;
};

test('avalanche links and unconfigured notices follow all other planning links', () => {
    const cases = [
        ['France', ['Avalanche forecasts — EAWS bulletin map']],
        ['United States; Canada', ['Avalanche forecasts — Avalanche.org', 'Avalanche forecasts — Avalanche Canada']],
        ['United States; Chile', ['Avalanche forecasts — Avalanche.org', 'Avalanche forecasts']],
        ['Mexico', ['Avalanche forecasts']],
        ['Chile', ['Avalanche forecasts']],
        [null, ['Avalanche forecasts']],
    ];
    for (const [nation, avalancheLabels] of cases) {
        const document = renderNationPeak(nation);
        const labels = [...document.querySelectorAll('.bpb-peak-links__item')]
            .map(item => item.querySelector('a')?.textContent || item.firstElementChild.textContent);
        const expected = ['Windy summit forecast', 'Copernicus satellite imagery'];
        if (nation && /United States|Canada|Mexico/.test(nation)) expected.push('AirNow fire & smoke');
        assert.deepEqual(labels, [...expected, ...avalancheLabels], nation ?? 'missing Nation row');
        document.defaultView.close();
    }
});

test('AirNow links follow the service coverage area', () => {
    const hasLink = (document, text) => Boolean(linkByText(document, text));

    const usa = renderNationPeak('United States');
    assert.ok(hasLink(usa, 'AirNow fire & smoke'), 'US peaks show fire & smoke');

    for (const nation of ['Canada', 'Mexico']) {
        const document = renderNationPeak(nation);
        assert.ok(hasLink(document, 'AirNow fire & smoke'), `${nation} shows fire & smoke`);
    }

    // Outside North America, and when the Nation row is missing, AirNow hides.
    for (const document of [renderNationPeak('France'), renderNationPeak(null)]) {
        assert.ok(!hasLink(document, 'AirNow fire & smoke'));
        // The universal links are always present.
        assert.ok(hasLink(document, 'Windy summit forecast'));
    }
});

const renderMinimalPeak = (coordinateValue, { includeLinks = true } = {}) => {
    const links = includeLinks ? '<tr><td colspan="2"><b>Links</b><br><br>Native links</td></tr>' : '';
    const dom = new JSDOM(`<!doctype html><table><tr><td>Latitude/Longitude (WGS84)</td><td>${coordinateValue}</td></tr>${links}</table>`, {
        url: 'https://www.peakbagger.com/Peak.aspx?pid=1',
        runScripts: 'outside-only'
    });
    dom.window.eval(source);
    return dom;
};

test('coordinate parsing fails closed for ambiguous, malformed, or out-of-range values', () => {
    for (const coordinate of [
        '46° 51\' 6\'\' N, 121° 45\' 37\'\' W (DMS)',
        'unknown (Dec Deg)',
        '91.0, -121.0 (Dec Deg)',
        '46.0, -181.0 (Dec Deg)',
        '46.0, -121.0 (Dec Deg) 47.0, -122.0 (Dec Deg)'
    ]) {
        const dom = renderMinimalPeak(coordinate);
        assert.equal(dom.window.document.getElementById('bpb-peak-links'), null, coordinate);
    }

    const missingLinks = renderMinimalPeak('46.0, -121.0 (Dec Deg)', { includeLinks: false });
    assert.equal(missingLinks.window.document.getElementById('bpb-peak-links'), null);

    const duplicateCoordinates = renderMinimalPeak('46.0, -121.0 (Dec Deg)');
    duplicateCoordinates.window.document.querySelector('table').insertAdjacentHTML(
        'afterbegin',
        '<tr><td>Latitude/Longitude (WGS84)</td><td>47.0, -122.0 (Dec Deg)</td></tr>'
    );
    duplicateCoordinates.window.document.getElementById('bpb-peak-links').remove();
    duplicateCoordinates.window.eval(source);
    assert.equal(duplicateCoordinates.window.document.getElementById('bpb-peak-links'), null);
});

test('integer coordinates keep Windy-required decimal parts and injection is idempotent', () => {
    const dom = renderMinimalPeak('46, -121 (Dec Deg)');
    dom.window.eval(source);

    assert.equal(dom.window.document.querySelectorAll('#bpb-peak-links').length, 1);
    assert.equal(
        linkByText(dom.window.document, 'Windy summit forecast').href,
        'https://www.windy.com/46.0/-121.0'
    );
});

const settleOrder = async () => {
    // Storage uses a promise queue. A task boundary lets its acknowledgments run.
    await new Promise(resolve => setImmediate(resolve));
};
const orderKeys = doc => [...doc.querySelectorAll('#bpb-peak-links [data-link-key]')].map(item => item.dataset.linkKey);
const grip = (doc, key) => doc.querySelector(`[data-link-key="${key}"] .bpb-peak-links__grip`);
const press = (doc, key, code) => grip(doc, key).dispatchEvent(new doc.defaultView.KeyboardEvent('keydown',
    { key: code, bubbles: true, cancelable: true }));
const reorderedPeak = async (nation = 'United States', saved = {}) => {
    const doc = renderNationPeak(nation);
    // Recreate the bundle with extension storage available at module startup.
    doc.getElementById('bpb-peak-links').remove();
    const chrome = makeChromeStub({ bpbSettings: saved });
    doc.defaultView.chrome = chrome;
    doc.defaultView.eval(source);
    await settleOrder();
    return { doc, chrome };
};

test('grips reorder with the keyboard, retain focus, save only IDs and preserve link behavior', async () => {
    const { doc, chrome } = await reorderedPeak();
    const originalLinks = [...doc.querySelectorAll('#bpb-peak-links a')].map(a => a.outerHTML).sort();
    const handle = grip(doc, 'avalanche');
    assert.equal(handle.type, 'button');
    assert.match(handle.getAttribute('aria-label'), /Reorder Avalanche forecasts/);
    assert.match(doc.getElementById(handle.getAttribute('aria-describedby')).textContent, /Up and Down/);
    handle.focus();
    press(doc, 'avalanche', 'Home');
    await settleOrder();
    assert.deepEqual(orderKeys(doc), ['avalanche', 'windy', 'copernicus', 'airnow']);
    assert.equal(doc.activeElement, handle);
    assert.deepEqual(chrome._store.bpbSettings.peakLinkOrder.slice(0, 4), orderKeys(doc));
    assert.equal(JSON.stringify(chrome._store).includes('46.851'), false);
    assert.deepEqual([...doc.querySelectorAll('#bpb-peak-links a')].map(a => a.outerHTML).sort(), originalLinks);
    press(doc, 'avalanche', 'ArrowUp');
    assert.match(doc.querySelector('[role="status"]').textContent, /already first/);
    press(doc, 'avalanche', 'ArrowDown');
    await settleOrder();
    assert.deepEqual(orderKeys(doc), ['windy', 'avalanche', 'copernicus', 'airnow']);
    doc.defaultView.close();
});

test('saved order follows forecast slots across countries and retains unavailable links', async () => {
    const saved = { peakLinkOrder: ['avalanche', 'windy', 'airnow', 'copernicus', 'avalanche-2'] };
    const { doc, chrome } = await reorderedPeak('France', saved);
    assert.deepEqual(orderKeys(doc), ['avalanche', 'windy', 'copernicus']);
    press(doc, 'windy', 'Home');
    await settleOrder();
    assert.deepEqual(chrome._store.bpbSettings.peakLinkOrder.slice(0, 4), ['windy', 'avalanche', 'airnow', 'copernicus']);
    const border = await reorderedPeak('United States; Canada; Chile', chrome._store.bpbSettings);
    assert.deepEqual(orderKeys(border.doc), ['windy', 'avalanche', 'airnow', 'copernicus', 'avalanche-2']);
    assert.equal(border.doc.querySelectorAll('.bpb-peak-links__grip').length, 5);
    assert.match(border.doc.querySelector('.bpb-peak-links__list').lastElementChild.textContent, /No forecast source/);
    doc.defaultView.close(); border.doc.defaultView.close();
});

const pointer = (doc, type, x, y, pointerId = 1) => {
    const event = new doc.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    return event;
};
const mockLayout = doc => {
    const list = doc.querySelector('.bpb-peak-links__list');
    list.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 240 });
    for (const item of list.querySelectorAll('[data-link-key]')) {
        Object.defineProperty(item, 'offsetTop', { get: () => orderKeys(doc).indexOf(item.dataset.linkKey) * 60 });
        Object.defineProperty(item, 'offsetHeight', { get: () => 60 });
        item.getBoundingClientRect = () => ({ top: item.offsetTop });
    }
};

test('pointer preview never saves; cancellation, outside drops and release respect the transaction', async () => {
    const { doc, chrome } = await reorderedPeak();
    mockLayout(doc);
    const original = orderKeys(doc), stored = JSON.stringify(chrome._store);
    for (const cancel of ['Escape', 'pointercancel', 'blur', 'outside']) {
        grip(doc, 'windy').dispatchEvent(pointer(doc, 'pointerdown', 12, 10));
        doc.defaultView.dispatchEvent(pointer(doc, 'pointermove', 12, 230));
        assert.deepEqual(orderKeys(doc), ['copernicus', 'airnow', 'avalanche', 'windy']);
        assert.equal(JSON.stringify(chrome._store), stored);
        if (cancel === 'Escape') doc.defaultView.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: cancel }));
        else if (cancel === 'outside') doc.defaultView.dispatchEvent(pointer(doc, 'pointerup', 500, 230));
        else doc.defaultView.dispatchEvent(cancel === 'blur' ? new doc.defaultView.Event('blur') : pointer(doc, cancel, 12, 230));
        assert.deepEqual(orderKeys(doc), original, cancel);
        assert.equal(doc.querySelector('[data-dragging]'), null);
        assert.equal(JSON.stringify(chrome._store), stored);
    }
    grip(doc, 'windy').dispatchEvent(pointer(doc, 'pointerdown', 12, 10));
    doc.defaultView.dispatchEvent(pointer(doc, 'pointermove', 12, 13));
    assert.equal(doc.querySelector('[data-dragging]'), null, 'small pointer movements are clicks');
    doc.defaultView.dispatchEvent(pointer(doc, 'pointermove', 12, 230, 2));
    assert.deepEqual(orderKeys(doc), original, 'another pointer cannot take over');
    doc.defaultView.dispatchEvent(pointer(doc, 'pointermove', 12, 230));
    doc.defaultView.dispatchEvent(pointer(doc, 'pointerup', 12, 230));
    await settleOrder();
    assert.deepEqual(chrome._store.bpbSettings.peakLinkOrder.slice(0, 4), ['copernicus', 'airnow', 'avalanche', 'windy']);
    doc.defaultView.close();
});

test('save failure is visible and a subsequent successful move clears it', async () => {
    const { doc, chrome } = await reorderedPeak();
    const save = chrome.storage.sync.set;
    chrome.storage.sync.set = async () => { throw new Error('Unavailable'); };
    press(doc, 'avalanche', 'Home');
    await settleOrder();
    const status = doc.querySelector('.bpb-peak-links__status');
    assert.match(status.textContent, /could not be saved/);
    assert.ok(status.hasAttribute('data-error'));
    assert.equal(status.classList.contains('bpb-peak-links__sr'), false);
    chrome.storage.sync.set = save;
    press(doc, 'avalanche', 'ArrowDown');
    await settleOrder();
    assert.equal(status.hasAttribute('data-error'), false);
    assert.match(status.textContent, /position 2 of 4/);
    doc.defaultView.close();
});

test('late hydration and an older failed save cannot override a newer move', async () => {
    const dom = new JSDOM('<section id="bpb-peak-links"><div class="bpb-peak-links__list">'
        + ['windy', 'copernicus', 'airnow', 'avalanche'].map(key => `<div data-link-key="${key}"><a>${key}</a></div>`).join('')
        + '</div></section>', { url: 'https://www.peakbagger.com/Peak.aspx?pid=1' });
    const doc = dom.window.document;
    let hydrate;
    const writes = [];
    enablePeakLinkOrder({ section: doc.querySelector('section'), list: doc.querySelector('.bpb-peak-links__list'), settings: {
        DEFAULTS: settingsSchema.DEFAULTS,
        get: () => new Promise(resolve => { hydrate = resolve; }),
        set: patch => new Promise((resolve, reject) => { writes.push({ patch, resolve, reject }); }),
    } });
    press(doc, 'avalanche', 'Home');
    hydrate(settingsSchema.clean({ peakLinkOrder: ['windy', 'airnow', 'copernicus', 'avalanche'] }));
    await settleOrder();
    assert.deepEqual(orderKeys(doc), ['avalanche', 'windy', 'copernicus', 'airnow']);
    press(doc, 'avalanche', 'ArrowDown');
    writes[1].resolve();
    await settleOrder();
    writes[0].reject(new Error('old write failed'));
    await settleOrder();
    assert.deepEqual(orderKeys(doc), ['windy', 'avalanche', 'copernicus', 'airnow']);
    assert.equal(doc.querySelector('.bpb-peak-links__status').hasAttribute('data-error'), false);
    dom.window.close();
});
