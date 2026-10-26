// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle, localStorage, MouseEvent */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { verificationScreenshots } from './browser-verification-evidence.mjs';
import { waitForCondition } from './browser-verification-fixtures.mjs';
import { assertPeakMapLinks, readPeakMapLinks } from './peak-map-links-verification.mjs';

export async function verifyPeakCards({ origin, evaluate, navigate, click, press, resize, screenshotPage, setSettings, readSettings,
    setZoom, wait, movePointer, pointerDown, pointerUp, setMode, heldCount, release, writeLocal, networkErrors, firefoxMode, placementOnly = false, weatherRequestCount }) {
    // This matrix covers the three original cards; the cloud card has its own
    // model/profile fixture and browser matrix.
    const applySettings = setSettings;
    setSettings = patch => applySettings({ showSummitCloud: false, ...patch });
    const output = process.env.BPB_VERIFY_PEAK_CARDS_SCREENSHOT_DIR, cases = [];
    if (output) await mkdir(output, { recursive: true });
    const captureRequested = verificationScreenshots();
    const browser = firefoxMode ? 'firefox' : 'chrome';
    const key = name => firefoxMode ? { Enter: '\uE007', Space: '\uE00D', ArrowUp: '\uE013', ArrowDown: '\uE015', ArrowLeft: '\uE012', ArrowRight: '\uE014', Home: '\uE011', End: '\uE010', Escape: '\uE00C', Tab: '\uE004' }[name] : name;
    const order = () => evaluate(() => [...document.querySelectorAll('[data-bpb-peak-card]:not([data-bpb-peak-card="cloud"])')].map(card => card.dataset.bpbPeakCard));
    const saved = (field, value) => waitForCondition(readSettings, { description: `saved ${field}`, timeoutMs: 7000,
        isReady: settings => isDeepStrictEqual(field === 'peakCardOrder' ? settings[field].filter(id => id !== 'cloud')
            : field === 'peakCardColumns' ? Object.fromEntries(Object.entries(settings[field]).filter(([id]) => id !== 'cloud')) : settings[field], value) });
    const image = async (name, reference = false) => { if (output && captureRequested(reference)) await screenshotPage(path.join(output, `${browser}-${name}.png`)); };
    const geometry = () => evaluate(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { cards: [...document.querySelectorAll('[data-bpb-peak-card]')].map(card => ({ key: card.dataset.bpbPeakCard, rect: rect(card) })),
            heading: rect(document.querySelector('h1')), nativeMap: rect(document.querySelector('#Gmap')),
            following: rect(document.querySelector('table.gray[align="right"] + br') || document.querySelector('h2')),
            scroll: { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight } };
    });
    // Native table border allocation can round by a fraction of a CSS pixel
    // after a row changes height. Permit at most one pixel, never real reflow.
    const stable = (before, after, label) => {
        if (typeof before === 'number') { assert.ok(Math.abs(after - before) <= 1, `${label}: ${before} → ${after}`); return; }
        if (before && typeof before === 'object') {
            assert.deepEqual(Object.keys(after), Object.keys(before), label);
            for (const key of Object.keys(before)) stable(before[key], after[key], `${label}.${key}`);
        } else assert.equal(after, before, label);
    };
    const ready = () => wait(() => document.querySelectorAll('[data-bpb-peak-card]:not([data-bpb-peak-card="cloud"])').length === 3
        && document.querySelector('.bpb-sun-calculator--peak .bpb-sun-calculator__toggle')?.disabled === false
        && (document.querySelector('#bpb-peak-weather')?.dataset.bpbCardCollapsed === 'true'
            || document.querySelectorAll('.bpb-week-day').length === 16)
        && document.querySelector('#bpb-peak-weather')?.getAttribute('aria-busy') === 'false'
        && document.querySelector('.bpb-snow-status')?.textContent.includes('Hourly readings'), 'three ready cards');
    const open = async () => {
        const before = weatherRequestCount();
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
        await wait(() => document.querySelectorAll('[data-bpb-peak-card]:not([data-bpb-peak-card="cloud"])').length === 3, 'card layout owner');
        await evaluate(() => document.querySelector('#bpb-peak-weather').scrollIntoView({ block: 'start' }));
        await wait(() => document.querySelector('#bpb-peak-weather')?.dataset.bpbCardCollapsed === 'true'
            || document.querySelectorAll('.bpb-week-day').length === 16, 'expanded forecast data or saved collapse');
        if (await evaluate(() => document.querySelector('#bpb-peak-weather').dataset.bpbCardCollapsed === 'true')) {
            assert.equal(weatherRequestCount(), before, 'restoring a collapsed card never loads hidden forecast data');
        }
        await evaluate(() => document.querySelector('#bpb-peak-snow').scrollIntoView({ block: 'center' })); await ready();
        assertPeakMapLinks(await evaluate(readPeakMapLinks));
    };
    const inspectMapLinks = async label => {
        await evaluate(() => document.getElementById('bpb-peak-map-links').scrollIntoView({ block: 'center' }));
        const geometry = () => evaluate(() => {
            const group = document.getElementById('bpb-peak-map-links');
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            return { group: rect(group), cell: rect(group.parentElement),
                links: [...group.querySelectorAll('a')].map(rect), scroll: window.scrollY };
        });
        const before = await geometry();
        for (const link of before.links) {
            assert.ok(link.width > 0 && link.height > 0 && link.x >= before.group.x - 1
                && link.x + link.width <= before.group.x + before.group.width + 1,
            `map link must fit its inset (${label}): ${JSON.stringify(before)}`);
        }
        await evaluate(() => document.querySelector('#bpb-peak-map-links a').focus({ preventScroll: true }));
        await press(key('Tab'));
        assert.equal(await evaluate(() => document.activeElement?.textContent), 'AllTrails');
        stable(before, await geometry(), 'map-link keyboard focus preserves layout');
        await image(`${label}-map-links`);
    };
    const focus = (id, control) => evaluate(({ id, control }) => {
        const card = document.querySelector(`[data-bpb-peak-card="${id}"]`), target = card.querySelector(control);
        target.scrollIntoView({ block: 'center', inline: 'nearest' }); target.focus({ preventScroll: true });
    }, { id, control });
    const placement = async (id, below) => {
        await waitForCondition(() => evaluate(id => {
            const native = document.querySelector('#bpb-peak-details-column > .bpb-peak-native-table').getBoundingClientRect();
            const card = document.querySelector(`[data-bpb-peak-card="${id}"]`).getBoundingClientRect();
            return { top: card.top, bottom: card.bottom, nativeTop: native.top, nativeBottom: native.bottom,
                focused: document.activeElement.getAttribute('aria-label'), message: document.querySelector('.bpb-peak-card-status').textContent };
        }, id), { description: `${id} ${below ? 'below' : 'above'} the native peak details`,
            isReady: bounds => below ? bounds.top >= bounds.nativeBottom : bounds.bottom <= bounds.nativeTop });
    };
    const gripFocused = async id => assert.equal(await evaluate(id => document.activeElement ===
        document.querySelector(`[data-bpb-peak-card="${id}"] .bpb-peak-card-grip`), id), true, `${id} keeps keyboard focus after moving`);
    const moveMenu = async id => {
        await focus(id, '.bpb-peak-card-grip');
        // Let the scroll requested by focus reach the compositor before a
        // physical click. A queued scroll event correctly dismisses menus.
        await evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        await click(`[data-bpb-peak-card="${id}"] .bpb-peak-card-grip`);
        await wait(() => [...document.querySelectorAll('.bpb-layout-menu')].some(menu => !menu.hidden), 'single-pointer move menu');
    };
    const expanded = (id, expected) => waitForCondition(() => evaluate(id => {
        const card = document.querySelector(`[data-bpb-peak-card="${id}"]`), button = card.querySelector('.bpb-peak-card-toggle, .bpb-sun-calculator__toggle');
        return { expanded: button.getAttribute('aria-expanded'), focus: document.activeElement?.outerHTML?.slice(0, 300),
            visibility: document.visibilityState, focused: document.hasFocus() };
    }, id), { description: `${id} disclosure ${expected}`, isReady: value => value.expanded === String(expected) });
    const preferences = { sun: 'peakSunCollapsed', weather: 'peakWeatherCollapsed', snow: 'peakSnowCollapsed' };
    const compactSnow = async label => {
        const layout = await evaluate(() => {
            const card = document.querySelector('#bpb-peak-snow');
            const refresh = card.querySelector('.bpb-snow-refresh').getBoundingClientRect();
            const station = card.querySelector('select').getBoundingClientRect();
            const header = card.querySelector('header').getBoundingClientRect();
            const icon = card.querySelector('h2 .bpb-snow-icon');
            return { refresh: { top: refresh.top, height: refresh.height, left: refresh.left },
                station: { top: station.top, height: station.height, right: station.right }, headerBottom: header.bottom,
                icon: icon ? { hidden: icon.getAttribute('aria-hidden'), focusable: icon.getAttribute('focusable'),
                    width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height } : null };
        });
        assert.ok(Math.abs(layout.refresh.top - layout.station.top) <= 1, `${label}: Refresh shares the station selector row: ${JSON.stringify(layout)}`);
        assert.ok(Math.abs(layout.refresh.height - layout.station.height) <= 1, `${label}: station actions have matching heights`);
        assert.ok(layout.refresh.left - layout.station.right >= 6 && layout.refresh.left - layout.station.right <= 12, `${label}: station actions keep a compact gap`);
        assert.ok(layout.station.top - layout.headerBottom <= 30, `${label}: no standalone Refresh row above the selector`);
        assert.ok(layout.icon?.width > 20 && layout.icon.width < 24 && Math.abs(layout.icon.height - layout.icon.width) <= .1,
            `${label}: a snow icon matches the other title icons: ${JSON.stringify(layout.icon)}`);
        assert.equal(layout.icon.hidden, 'true'); assert.equal(layout.icon.focusable, 'false');
    };
    const headerTargets = id => evaluate(id => {
        const card = document.querySelector(`[data-bpb-peak-card="${id}"]`);
        const header = card.querySelector('header, .bpb-peak-card-sun-header');
        const toggle = header.querySelector('.bpb-peak-card-toggle, .bpb-sun-calculator__toggle');
        const h = header.getBoundingClientRect(), c = card.getBoundingClientRect(), t = toggle.getBoundingClientRect();
        const points = [c.left + 6, h.left + h.width / 3, h.left + h.width * 2 / 3, c.right - 6]
            .flatMap(x => [h.top + 8, h.top + h.height / 2].map(y => ({ x, y })));
        const grip = header.querySelector('.bpb-peak-card-grip').getBoundingClientRect();
        points.push({ x: grip.left - 2, y: h.top + h.height / 2 });
        const samples = points.filter(({ x, y }) => {
            // The native page can extend past the viewport; sample only page
            // pixels that a pointer can actually reach at this scroll.
            if (x < 0 || x >= document.documentElement.clientWidth || y < 0 || y >= window.innerHeight) return false;
            const hit = document.elementFromPoint(x, y), control = hit?.closest('button, a, input, select');
            return !control || control === toggle;
        });
        const title = toggle.querySelector('.bpb-peak-card-title, .bpb-sun-calculator__title');
        const blank = samples.find(({ x, y }) => !title.contains(document.elementFromPoint(x, y)));
        return { blank, covered: samples.every(({ x, y }) => document.elementFromPoint(x, y)?.closest('button') === toggle),
            bounds: { card: { left: c.left, right: c.right }, header: { left: h.left, right: h.right }, toggle: { left: t.left, right: t.right },
                client: document.documentElement.clientWidth, inner: window.innerWidth, visual: window.visualViewport?.width },
            missed: samples.filter(({ x, y }) => document.elementFromPoint(x, y)?.closest('button') !== toggle).map(({ x, y }) => ({ x, y,
                hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 160) })),
            controlsIndependent: [...header.querySelectorAll('button')].filter(button => button !== toggle
                && getComputedStyle(button).visibility !== 'hidden' && button.getClientRects().length).every(button => {
                const r = button.getBoundingClientRect();
                return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === button;
            }) };
    }, id);
    // Keep this interaction matrix in its own run: combining it with the
    // disclosure/refresh matrix exceeds storage.sync's per-minute write quota.
    if (placementOnly) {
        for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
            await resize(width, 1100); setMode('complete');
            await setSettings({ theme, units: 'metric', showWeather: true, showSnotel: true, showSunMoon: true,
                peakSunCollapsed: true, peakWeatherCollapsed: true, peakSnowCollapsed: true });
            await open(); await focus('weather', '.bpb-peak-card-grip'); await press(key('ArrowLeft'));
            await saved('peakCardColumns', { sun: 'map', weather: 'details', snow: 'map' });
            await focus('weather', '.bpb-peak-card-grip'); await press(key('End'));
            await placement('weather', true); await gripFocused('weather');
            await saved('peakCardColumns', { sun: 'map', weather: 'details-bottom', snow: 'map' });
            await image(`${width}-${theme}-below-details`);
            await focus('weather', '.bpb-peak-card-grip'); await press(key('ArrowUp')); await placement('weather', false); await gripFocused('weather');
            await press(key('ArrowDown')); await placement('weather', true); await gripFocused('weather');
            await press(key('Home')); await placement('weather', false); await gripFocused('weather');
            await moveMenu('weather');
            await click('.bpb-layout-menu:not([hidden]) button:nth-child(3)'); await placement('weather', true);
            await moveMenu('weather'); await image(`${width}-${theme}-below-details-menu`);
            await click('.bpb-layout-menu:not([hidden]) button:nth-child(3)'); await placement('weather', false);
            // The native details table is taller than one viewport. Keep the
            // pointer held while scrolling to its lower half, as a long drag does.
            await focus('weather', '.bpb-peak-card-grip');
            const dragBelow = async cancel => {
                const start = await evaluate(() => {
                    const r = document.activeElement.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                });
                await pointerDown(start.x, start.y);
                const target = await evaluate(() => {
                    const native = document.querySelector('#bpb-peak-details-column > .bpb-peak-native-table');
                    native.scrollIntoView({ block: 'end', inline: 'nearest' }); window.scrollBy(0, 200);
                    const r = native.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.bottom - 20, bottom: r.bottom };
                });
                const before = await geometry();
                await movePointer(target.x, target.y);
                await wait(() => !document.querySelector('.bpb-peak-card-insertion').hidden, 'below-details insertion preview');
                const preview = await evaluate(() => document.querySelector('.bpb-peak-card-insertion').getBoundingClientRect().top);
                assert.ok(Math.abs(preview - target.bottom) <= 1, 'the empty lower destination previews the native details boundary');
                stable(before, await geometry(), 'below-details preview preserves native content and scroll');
                if (cancel) {
                    await image(`${width}-${theme}-below-details-drag`);
                    await press(key('Escape')); await pointerUp();
                    stable(before, await geometry(), 'canceling a lower placement preserves native content and scroll');
                    await placement('weather', false);
                } else { await pointerUp(); await placement('weather', true); }
            };
            await dragBelow(true);
            await focus('weather', '.bpb-peak-card-grip');
            await dragBelow(false);
            await open(); await placement('weather', true);
            await focus('weather', '.bpb-peak-card-toggle'); await press(key('Enter')); await expanded('weather', true);
            // Finish this case's visible read before the next iteration takes
            // its no-hidden-requests baseline. Disclosure alone precedes the
            // lazy read and can otherwise charge it to the next page.
            await wait(() => document.querySelectorAll('.bpb-week-day').length === 16
                && document.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false',
            'expanded placement forecast settled');
            await placement('weather', true); await image(`${width}-${theme}-below-details-expanded`, true);
            if (width === 375 && theme === 'dark') {
                await setZoom(2); await focus('weather', '.bpb-peak-card-toggle');
                await placement('weather', true); await image('below-details-200-percent'); await setZoom(1);
            }
            cases.push({ width, theme, states: ['above-below-keyboard', 'above-below-menu', 'below-details-pointer',
                'below-details-cancel', 'below-details-expanded', 'below-details-reload', 'stable-preview', 'retained-focus'] });
        }
        assert.deepEqual(networkErrors, []); assert.ok(cases.length > 0);
        return { verification: 'peak-card-placement', cases, output: output || null, providers: 'fixture responses; no live provider requests' };
    }
    await resize(375, 1100); setMode('complete');
    await setSettings({ theme: 'dark', units: 'metric', showWeather: true, showSnotel: false, showSunMoon: false,
        peakWeatherCollapsed: true, bpbPeakWeatherModelPast: 'gfs_global', bpbPeakWeatherModelForecast: 'gfs_global' });
    const beforeCollapsedLoad = weatherRequestCount();
    await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
    await wait(() => document.querySelector('#bpb-peak-weather')?.dataset.bpbCardCollapsed === 'true', 'saved collapsed weather');
    await evaluate(() => {
        window.__preferenceReadVisibility = [];
        window.__preferenceReadListener = () => window.__preferenceReadVisibility.push(document.visibilityState);
        document.addEventListener('visibilitychange', window.__preferenceReadListener);
    });
    await readSettings();
    const visibility = await evaluate(() => {
        document.removeEventListener('visibilitychange', window.__preferenceReadListener);
        return window.__preferenceReadVisibility;
    });
    assert.deepEqual(visibility, [], 'reading saved preferences must not hide or blur the interaction fixture');
    await evaluate(() => document.querySelector('#bpb-peak-weather').scrollIntoView({ block: 'center' }));
    await evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    assert.equal(weatherRequestCount(), beforeCollapsedLoad, 'collapsed header in viewport never requests weather');
    await click('#bpb-peak-weather .bpb-peak-card-toggle');
    await wait(() => document.querySelectorAll('.bpb-week-day').length === 16
        && document.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false', 'expanded weather');
    assert.equal(weatherRequestCount(), beforeCollapsedLoad + 1);
    await evaluate(() => { window.bpbReadGateDay = document.querySelector('.bpb-week-day'); });
    setMode('loading'); await click('.bpb-week-refresh');
    await waitForCondition(() => heldCount() > 0, { description: 'held weather refresh' });
    await click('#bpb-peak-weather .bpb-peak-card-toggle');
    await wait(() => document.querySelector('#bpb-peak-weather').dataset.bpbCardCollapsed === 'true'
        && document.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false', 'collapse cancels pending read');
    const closedRefresh = await geometry(); setMode('complete'); release();
    await evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    stable(closedRefresh, await geometry(), 'cancelled weather completion cannot shift the closed card');
    await click('#bpb-peak-weather .bpb-peak-card-toggle');
    await wait(() => document.querySelector('#bpb-peak-weather').dataset.bpbCardCollapsed === 'false', 'weather reexpanded');
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-day') === window.bpbReadGateDay), true, 'retained result nodes survive');
    assert.equal(weatherRequestCount(), beforeCollapsedLoad + 2, 'fresh result resumes without another request');
    cases.push({ case: 'weather-read-gate', collapsedRequests: 0, expandedRequests: 1, cancelledRefresh: true });
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
        await resize(width, 1100); setMode('complete');
        await setSettings({ theme, units: 'metric', showWeather: true, showSnotel: true, showSunMoon: true }); await open();
        await inspectMapLinks(`${width}-${theme}`);
        const divider = await evaluate(() => {
            const handle = document.getElementById('bpb-peak-table-resize-handle');
            return { visible: handle.getBoundingClientRect().width > 0, role: handle.getAttribute('role') };
        });
        assert.equal(divider.role, 'separator'); assert.equal(divider.visible, width > 680);
        if (width > 680) {
            await evaluate(() => document.getElementById('bpb-peak-table-resize-handle').scrollIntoView({ block: 'start' }));
            const before = await evaluate(() => {
                const h = document.getElementById('bpb-peak-table-resize-handle'), r = h.getBoundingClientRect();
                return { value: h.getAttribute('aria-valuenow'), x: r.left + r.width / 2, y: 100,
                    width: document.getElementById('bpb-peak-details-column').getBoundingClientRect().width,
                    saved: localStorage.getItem('pbPeakTableSplit.v1') };
            });
            await pointerDown(before.x, before.y); await movePointer(before.x + 70, before.y);
            assert.ok(await evaluate(w => document.getElementById('bpb-peak-details-column').getBoundingClientRect().width > w + 50, before.width));
            assert.equal(await evaluate(() => localStorage.getItem('pbPeakTableSplit.v1')), before.saved);
            await press(key('Escape')); await pointerUp();
            assert.equal(await evaluate(() => document.getElementById('bpb-peak-table-resize-handle').getAttribute('aria-valuenow')), before.value);
            await pointerDown(before.x, before.y); await movePointer(before.x + 70, before.y); await pointerUp();
            assert.ok(await evaluate(() => JSON.parse(localStorage.getItem('pbPeakTableSplit.v1')).leftPercent > 50));
            const columnsFit = await evaluate(() => ['details', 'map'].map(id => {
                const column = document.getElementById(`bpb-peak-${id}-column`), r = column.getBoundingClientRect();
                return [...column.children].filter(node => !node.hidden).every(node => { const b = node.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; });
            }));
            assert.deepEqual(columnsFit, [true, true], 'resized native tables fit their columns');
            await image(`${width}-${theme}-divider`);
            await evaluate(() => document.getElementById('bpb-peak-table-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        }
        await compactSnow(`${width}/${theme}/ready`);
        const nativeHeading = await evaluate(() => {
            const heading = [...document.querySelectorAll('h2')].find(node => /^Elevation:/i.test(node.textContent.trim()));
            const previous = heading.textContent;
            heading.textContent = 'Elevation: 4391.0 meters, 14,406.2 feet';
            return previous;
        });
        const nativeUnits = { ...await readSettings(), elevationUnits: 'default', distanceUnits: 'default',
            temperatureUnits: 'default', precipitationUnits: 'default', windUnits: 'default' };
        await setSettings({ ...nativeUnits, units: 'imperial' });
        await wait(() => document.querySelector('.bpb-week-temp')?.textContent.includes('°F')
            && document.querySelector('.bpb-snow-metric strong')?.textContent.includes('in'), 'explicit imperial before automatic units');
        await setSettings({ ...nativeUnits, units: 'auto' });
        await wait(() => document.querySelector('.bpb-week-temp')?.textContent.includes('°C')
            && document.querySelector('.bpb-snow-metric strong')?.textContent.includes('cm'), 'automatic metric weather and snow');
        const automatic = await evaluate(() => ({ weather: document.querySelector('.bpb-week-sub').textContent,
            station: document.querySelector('#bpb-peak-snow-station').selectedOptions[0].textContent }));
        assert.match(automatic.weather, /4391 m/); assert.match(automatic.station, /km away.*1570 m/);
        assert.equal(await evaluate(() => document.documentElement.getAttribute('data-bpb-theme')), theme);
        await compactSnow(`${width}/${theme}/automatic-units`);
        await focus('snow', '.bpb-peak-card-toggle'); await image(`${width}-${theme}-automatic-units`, true);
        await evaluate(previous => {
            [...document.querySelectorAll('h2')].find(node => /^Elevation:/i.test(node.textContent.trim())).textContent = previous;
        }, nativeHeading);
        await setSettings({ ...await readSettings(), units: 'metric' });
        assert.deepEqual(await order(), ['sun', 'weather', 'snow']);
        for (const id of ['weather', 'snow', 'sun']) {
            const toggle = id === 'sun' ? '.bpb-sun-calculator__toggle' : '.bpb-peak-card-toggle';
            await focus(id, toggle);
            // The native page has a minimum width. Pan its right edge clear
            // of browser chrome before testing padding near the viewport edge.
            await evaluate(id => {
                const r = document.querySelector(`[data-bpb-peak-card="${id}"]`).getBoundingClientRect();
                if (r.right > window.innerWidth - 20) window.scrollBy(r.right - window.innerWidth + 20, 0);
            }, id);
            const appearance = await evaluate(id => {
                const read = card => {
                    const header = card.querySelector('.bpb-peak-card-header');
                    const button = header.querySelector('.bpb-peak-card-toggle, .bpb-sun-calculator__toggle');
                    const title = button.querySelector('.bpb-peak-card-title, .bpb-sun-calculator__title');
                    const c = getComputedStyle(card), h = getComputedStyle(header), b = getComputedStyle(button), t = getComputedStyle(title);
                    return { cardRadius: c.borderRadius, headerBackground: h.backgroundColor === 'rgba(0, 0, 0, 0)' ? c.backgroundColor : h.backgroundColor, buttonRadius: b.borderRadius,
                        color: t.color, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, lineHeight: t.lineHeight,
                        padding: b.padding };
                };
                return { actual: read(document.querySelector(`[data-bpb-peak-card="${id}"]`)), expected: read(document.querySelector('[data-bpb-peak-card="sun"]')) };
            }, id);
            assert.deepEqual(appearance.actual, appearance.expected, `${width}/${theme}/${id}: all headers share Sun & Moon's appearance`);
            const row = await evaluate(id => {
                const card = document.querySelector(`[data-bpb-peak-card="${id}"]`);
                const header = card.querySelector('header, .bpb-peak-card-sun-header');
                const toggle = header.querySelector('.bpb-peak-card-toggle, .bpb-sun-calculator__toggle');
                const caret = toggle.querySelector('.bpb-peak-card-chevron, .bpb-sun-calculator__chevron');
                const t = toggle.getBoundingClientRect(), c = card.getBoundingClientRect(), r = caret.getBoundingClientRect();
                // Firefox can report 62.000061 for a 62px edge. Quantize below
                // a thousandth of a CSS pixel; retain the 1px layout tolerance.
                const precise = value => Math.round(value * 1000) / 1000;
                return { left: precise(t.left - c.left), right: precise(c.right - t.right), caretInset: precise(c.right - r.right),
                    headerButtons: header.querySelectorAll('button').length };
            }, id);
            assert.ok(Math.abs(row.caretInset - 61) <= 1, `${width}/${theme}/${id}: the caret aligns at the right before the drag handle: ${JSON.stringify(row)}`);
            assert.ok(row.left <= 1 && row.right <= 1, `${width}/${theme}/${id}: the disclosure button fills the first row: ${JSON.stringify(row)}`);
            assert.equal(row.headerButtons, 2, 'the first row contains only the disclosure and its separate drag handle');
            const targets = await headerTargets(id);
            if (!targets.covered) await image(`${width}-${theme}-${id}-header-hit-failure`);
            assert.equal(targets.covered, true, `${width}/${theme}/${id}: the full header activates its native disclosure: ${JSON.stringify(targets)}`);
            assert.ok(targets.blank, 'the row includes a clickable point beyond its title text');
            assert.equal(targets.controlsIndependent, true, 'Refresh and drag handles retain their own hit targets');
            if (id === 'weather') await image(`${width}-${theme}-weather-header`);
            const before = await evaluate(() => {
                const r = document.activeElement.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height, scroll: window.scrollY };
            });
            await pointerDown(targets.blank.x, targets.blank.y); await pointerUp();
            await expanded(id, false); await saved(preferences[id], true);
            const after = await evaluate(() => {
                const r = document.activeElement.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height, scroll: window.scrollY };
            });
            stable(before, after, `${width}/${theme}/${id}: disclosure trigger and reading position stay anchored`);
            const closedTargets = await headerTargets(id);
            assert.equal(closedTargets.covered, true, 'the collapsed header remains clickable across its row');
            await pointerDown(closedTargets.blank.x, closedTargets.blank.y); await pointerUp();
            await expanded(id, true); await saved(preferences[id], false);
            await press(key('Enter')); await expanded(id, false); await saved(preferences[id], true);
            await press(key('Tab'));
            assert.equal(await evaluate(() => !!document.activeElement.closest('.bpb-peak-card-body, .bpb-sun-calculator__panel')), false,
                'collapsed contents leave keyboard navigation');
        }
        await focus('weather', '.bpb-peak-card-toggle'); await press(key('Enter')); await expanded('weather', true);
        await focus('weather', '.bpb-week-refresh');
        // Disclosure precedes the lazy forecast read. A screenshot used to
        // provide an accidental delay; refresh must start from a settled view.
        await waitForCondition(() => evaluate(() => ({
            expanded: document.querySelector('#bpb-peak-weather').dataset.bpbCardCollapsed,
            busy: document.querySelector('#bpb-peak-weather').getAttribute('aria-busy'),
            days: document.querySelectorAll('.bpb-week-day').length,
            unavailable: document.querySelector('.bpb-week-refresh').getAttribute('aria-disabled'),
            focused: document.activeElement === document.querySelector('.bpb-week-refresh'),
        })), { description: 'settled expanded forecast before keyboard refresh', timeoutMs: 20_000,
            isReady: state => state.expanded === 'false' && state.busy === 'false' && state.days === 16
                && state.unavailable !== 'true' && state.focused });
        const weatherBefore = await geometry(); setMode('loading'); await press(key('Enter'));
        await waitForCondition(() => evaluate(() => ({ busy: document.querySelector('#bpb-peak-weather').getAttribute('aria-busy'),
            status: document.querySelector('.bpb-week-status').textContent,
            action: document.querySelector('.bpb-week-refresh').outerHTML,
            focus: document.activeElement?.outerHTML?.slice(0, 300) })),
        { description: 'weather refresh pending', timeoutMs: 20_000, isReady: state => state.busy === 'true' });
        await waitForCondition(heldCount, { description: 'weather response held by fixture', isReady: count => count > 0 });
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('.bpb-week-refresh')), true,
            'weather Refresh keeps keyboard focus while unavailable');
        stable(weatherBefore, await geometry(), 'weather refresh keeps its header, panel and surrounding content anchored');
        const weatherAction = await evaluate(() => {
            const r = document.querySelector('.bpb-week-refresh').getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        setMode('service-error'); release();
        await waitForCondition(() => evaluate(() => ({ busy: document.querySelector('#bpb-peak-weather').getAttribute('aria-busy'),
            feedback: document.querySelector('.bpb-week-status').textContent })), { description: 'weather refresh error retains the forecast',
            isReady: state => state.busy === 'false' && state.feedback.includes('weather service is unavailable') });
        const weatherErrorAction = await evaluate(() => {
            const r = document.querySelector('.bpb-week-refresh').getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        stable(weatherAction, weatherErrorAction, 'weather error keeps Refresh anchored');
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('.bpb-week-refresh')), true,
            'weather Refresh keeps keyboard focus after failure');
        await image(`${width}-${theme}-weather-error`);
        setMode('complete'); await click('.bpb-week-refresh'); await ready();
        stable(weatherBefore, await geometry(), 'weather retry restores the settled layout');
        await focus('weather', '.bpb-peak-card-toggle'); await press(key('Enter')); await expanded('weather', false);
        await focus('weather', '.bpb-peak-card-grip'); await press(key('ArrowUp'));
        await saved('peakCardOrder', ['weather', 'sun', 'snow']); assert.deepEqual(await order(), ['weather', 'sun', 'snow']);
        assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Reorder Summit weather');
        await evaluate(() => document.querySelector('[data-bpb-peak-card="weather"]').scrollIntoView({ block: 'center' }));
        const points = await evaluate(() => {
            const grip = document.querySelector('[data-bpb-peak-card="snow"] .bpb-peak-card-grip').getBoundingClientRect();
            const target = document.querySelector('[data-bpb-peak-card="weather"]').getBoundingClientRect();
            return { from: { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, to: { x: target.x + target.width / 2, y: target.y + 8 } };
        });
        const dragBefore = await geometry();
        await pointerDown(points.from.x, points.from.y); await movePointer(points.to.x, points.to.y);
        await wait(() => !document.querySelector('.bpb-peak-card-insertion').hidden, 'drop preview');
        stable(dragBefore, await geometry(), 'drag preview does not reflow the page');
        await image(`${width}-${theme}-drag`); await press(key('Escape')); await pointerUp();
        stable(dragBefore, await geometry(), 'canceling the drag preserves page and scroll');
        await pointerDown(points.from.x, points.from.y); await movePointer(points.to.x, points.to.y); await pointerUp();
        await saved('peakCardOrder', ['snow', 'weather', 'sun']); assert.deepEqual(await order(), ['snow', 'weather', 'sun']);
        assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Reorder Nearby snow');
        await image(`${width}-${theme}-collapsed`);
        await open(); assert.deepEqual(await order(), ['snow', 'weather', 'sun']);
        for (const id of ['sun', 'weather', 'snow']) await expanded(id, false);
        assert.equal(await evaluate(() => document.querySelector('#Gmap').closest('tr').querySelector('.bpb-sun-calculator--peak')), null,
            'Sun & Moon can move independently of the native map and its legend');
        await focus('snow', '.bpb-peak-card-toggle'); await press(key('Space')); await expanded('snow', true); await saved('peakSnowCollapsed', false);
        const requestsBefore = await geometry(); setMode('loading'); await click('.bpb-snow-refresh');
        await wait(() => document.querySelector('#bpb-peak-snow').getAttribute('aria-busy') === 'true', 'refresh pending');
        await waitForCondition(heldCount, { description: 'snow response held by fixture', isReady: count => count > 0 });
        stable(requestsBefore, await geometry(), 'expanded pending state after reordering');
        await compactSnow(`${width}/${theme}/pending`);
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('.bpb-snow-refresh')), true,
            'the inline Refresh action keeps keyboard focus while unavailable');
        await focus('snow', '.bpb-peak-card-toggle'); await press(key('Enter')); await expanded('snow', false); await saved('peakSnowCollapsed', true);
        const closedPending = await geometry(); setMode('service-error'); release();
        await wait(() => document.querySelector('.bpb-snow-status').textContent.includes('Could not load'), 'hidden refresh error');
        stable(closedPending, await geometry(), 'background error cannot expand a collapsed card');
        await press(key('Enter')); await expanded('snow', true); await saved('peakSnowCollapsed', false);
        await compactSnow(`${width}/${theme}/error`);
        setMode('complete'); await click('.bpb-snow-refresh'); await ready();
        await compactSnow(`${width}/${theme}/retry`);
        await focus('snow', '.bpb-peak-card-toggle'); await image(`${width}-${theme}-expanded`);
        const current = await readSettings(); await setSettings({ ...current, showSnotel: false });
        await wait(() => document.querySelector('#bpb-peak-snow-row').hidden, 'SNOTEL feature off');
        await setSettings({ ...current, showSnotel: true }); await ready(); assert.deepEqual(await order(), ['snow', 'weather', 'sun']);
        cases.push({ width, theme, states: ['automatic-units', 'header-hit-area', 'collapse', 'keyboard', 'pointer', 'cancel', 'reload', 'weather-refresh-error-retry', 'pending', 'closed-error', 'retry', 'feature-off-on'] });
    }
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
        await resize(width, 1100);
        await setSettings({ ...await readSettings(), theme, peakCardColumns: { sun: 'map', weather: 'map', snow: 'map' },
            peakSunCollapsed: true, peakWeatherCollapsed: true, peakSnowCollapsed: true });
        await open();
        await focus('weather', '.bpb-peak-card-grip'); await press(key('ArrowLeft'));
        await saved('peakCardColumns', { sun: 'map', weather: 'details', snow: 'map' });
        await focus('snow', '.bpb-peak-card-grip'); await press(key('ArrowLeft'));
        await saved('peakCardColumns', { sun: 'map', weather: 'details', snow: 'details' });
        const leftOrder = () => evaluate(() => [...document.querySelectorAll('#bpb-peak-details-column [data-bpb-peak-card]')].map(card => card.dataset.bpbPeakCard));
        assert.deepEqual(await leftOrder(), ['weather', 'snow']);
        await focus('snow', '.bpb-peak-card-grip'); await press(key('ArrowUp'));
        assert.deepEqual(await leftOrder(), ['snow', 'weather']);
        await image(`${width}-${theme}-left-column`);
        await moveMenu('snow');
        await image(`${width}-${theme}-move-menu`);
        await click('.bpb-layout-menu:not([hidden]) button:last-child');
        await saved('peakCardColumns', { sun: 'map', weather: 'details', snow: 'map' });
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('[data-bpb-peak-card="snow"] .bpb-peak-card-grip')), true);
        if (width > 680) {
            await evaluate(() => { document.getElementById('bpb-peak-table-split').scrollIntoView({ block: 'start' }); window.scrollBy(0, -120); });
            const points = await evaluate(() => {
                const r = document.querySelector('[data-bpb-peak-card="snow"] .bpb-peak-card-grip').getBoundingClientRect();
                const target = document.querySelector('[data-bpb-peak-card="weather"]').getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2, toX: target.left + target.width / 2, toY: target.top + 8 };
            });
            const before = await geometry();
            await pointerDown(points.x, points.y); await movePointer(points.toX, points.toY);
            await wait(() => !document.querySelector('.bpb-peak-card-insertion').hidden, 'cross-column insertion preview');
            stable(before, await geometry(), 'cross-column preview preserves the page and reading position');
            await image(`${width}-${theme}-cross-column-drag`);
            await pointerUp(); await saved('peakCardColumns', { sun: 'map', weather: 'details', snow: 'details' });
            assert.deepEqual(await leftOrder(), ['snow', 'weather']);
        }
        await open();
        assert.equal(await evaluate(() => document.querySelector('[data-bpb-peak-card="weather"]').closest('#bpb-peak-details-column') !== null), true);
        cases.push({ width, theme, states: ['column-keyboard', 'column-reorder', 'move-menu', 'column-reload', ...(width > 680 ? ['cross-column-pointer', 'stable-preview'] : [])] });
    }
    await setSettings({ ...await readSettings(), peakSnowCollapsed: false, peakCardOrder: ['snow', 'weather', 'sun'], peakCardColumns: { sun: 'map', weather: 'map', snow: 'map' } });
    setMode('long-station'); await writeLocal({ bpbSnotelCatalogV1: null }); await open();
    await focus('snow', '.bpb-peak-card-toggle'); await compactSnow('375/dark/long-station');
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-snow-station').selectedOptions[0].textContent.includes('Experimental Mountain')), true,
        'the compact control exercises a long station name from the provider fixture');
    await image('375-dark-long-station'); cases.push({ width: 375, theme: 'dark', states: ['long-station'] });
    await resize(1440, 1100); await focus('snow', '.bpb-peak-card-grip');
    const edgeDrag = await evaluate(() => {
        const r = document.activeElement.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, bottom: window.innerHeight - 12, scroll: window.scrollY };
    });
    await pointerDown(edgeDrag.x, edgeDrag.y); await movePointer(edgeDrag.x, edgeDrag.bottom);
    await waitForCondition(() => evaluate(() => window.scrollY), { description: 'dragging an expanded card scrolls at the viewport edge',
        isReady: value => value > edgeDrag.scroll + 16 });
    await pointerUp(); await saved('peakCardOrder', ['weather', 'sun', 'snow']);
    cases.push({ states: ['expanded-card-drag', 'edge-autoscroll'] });
    await setZoom(2);
    await inspectMapLinks('200-percent');
    await press(key('Tab')); await focus('snow', '.bpb-peak-card-toggle');
    const keyboardFocus = await evaluate(() => ({ control: document.activeElement.className,
        visible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.equal(keyboardFocus.outline, 'solid', `keyboard focus outlines the full header: ${JSON.stringify(keyboardFocus)}`);
    await image('200-percent');
    await compactSnow('200-percent');
    assert.equal((await headerTargets('snow')).covered, true, 'the full header remains clickable at 200% zoom');
    assert.equal(await evaluate(() => {
        const card = document.querySelector('#bpb-peak-snow'), bounds = card.getBoundingClientRect();
        return [...card.querySelectorAll('.bpb-peak-card-toggle, .bpb-peak-card-grip, .bpb-snow-dates span')].every(node => {
            const r = node.getBoundingClientRect(); return r.left >= bounds.left && r.right <= bounds.right;
        });
    }), true, 'controls and dates fit at 200% zoom');
    await setZoom(1);
    assert.deepEqual(networkErrors, []); assert.ok(cases.length > 0);
    return { verification: 'peak-cards', cases, output: output || null, providers: 'fixture responses; no live provider requests' };
}
