// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifyPeakCards({ origin, evaluate, navigate, click, press, resize, screenshotPage, setSettings, readSettings,
    setZoom, wait, movePointer, pointerDown, pointerUp, setMode, heldCount, release, networkErrors, firefoxMode }) {
    const output = process.env.BPB_VERIFY_PEAK_CARDS_SCREENSHOT_DIR, cases = [];
    if (output) await mkdir(output, { recursive: true });
    const browser = firefoxMode ? 'firefox' : 'chrome';
    const key = name => firefoxMode ? { Enter: '\uE007', Space: '\uE00D', ArrowUp: '\uE013', ArrowDown: '\uE015', Home: '\uE011', End: '\uE010', Escape: '\uE00C', Tab: '\uE004' }[name] : name;
    const order = () => evaluate(() => [...document.querySelectorAll('[data-bpb-peak-card]')].map(card => card.dataset.bpbPeakCard));
    const saved = (field, value) => waitForCondition(readSettings, { description: `saved ${field}`, timeoutMs: 7000,
        isReady: settings => JSON.stringify(settings[field]) === JSON.stringify(value) });
    const image = async name => { if (output) await screenshotPage(path.join(output, `${browser}-${name}.png`)); };
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
    const ready = () => wait(() => document.querySelectorAll('[data-bpb-peak-card]').length === 3
        && document.querySelector('.bpb-sun-calculator--peak .bpb-sun-calculator__toggle')?.disabled === false
        && document.querySelectorAll('.bpb-week-day').length === 16
        && document.querySelector('#bpb-peak-weather')?.getAttribute('aria-busy') === 'false'
        && document.querySelector('.bpb-snow-status')?.textContent.includes('Hourly readings'), 'three ready cards');
    const open = async () => {
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
        await wait(() => document.querySelectorAll('[data-bpb-peak-card]').length === 3, 'card layout owner');
        await evaluate(() => document.querySelector('#bpb-peak-weather').scrollIntoView({ block: 'start' }));
        await wait(() => document.querySelectorAll('.bpb-week-day').length === 16, 'forecast data');
        await evaluate(() => document.querySelector('#bpb-peak-snow').scrollIntoView({ block: 'center' })); await ready();
    };
    const focus = (id, control) => evaluate(({ id, control }) => {
        const card = document.querySelector(`[data-bpb-peak-card="${id}"]`), target = card.querySelector(control);
        target.scrollIntoView({ block: 'center', inline: 'nearest' }); target.focus({ preventScroll: true });
    }, { id, control });
    const expanded = (id, expected) => waitForCondition(() => evaluate(id => {
        const card = document.querySelector(`[data-bpb-peak-card="${id}"]`), button = card.querySelector('.bpb-peak-card-toggle, .bpb-sun-calculator__toggle');
        return button.getAttribute('aria-expanded');
    }, id), { description: `${id} disclosure ${expected}`, isReady: value => value === String(expected) });
    const preferences = { sun: 'peakSunCollapsed', weather: 'peakWeatherCollapsed', snow: 'peakSnowCollapsed' };
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
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
        await resize(width, 1100); setMode('complete');
        await setSettings({ theme, units: 'metric', showWeather: true, showSnotel: true, showSunMoon: true }); await open();
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
            const row = await evaluate(id => {
                const card = document.querySelector(`[data-bpb-peak-card="${id}"]`);
                const header = card.querySelector('header, .bpb-peak-card-sun-header');
                const toggle = header.querySelector('.bpb-peak-card-toggle, .bpb-sun-calculator__toggle');
                const caret = toggle.querySelector('.bpb-peak-card-chevron, .bpb-sun-calculator__chevron');
                const t = toggle.getBoundingClientRect(), c = card.getBoundingClientRect(), r = caret.getBoundingClientRect();
                return { left: t.left - c.left, right: c.right - t.right, caretInset: c.right - r.right,
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
        const weatherBefore = await geometry(); setMode('loading'); await press(key('Enter'));
        await wait(() => document.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'true', 'weather refresh pending');
        await waitForCondition(heldCount, { description: 'weather response held by fixture', isReady: count => count > 0 });
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
        await focus('snow', '.bpb-peak-card-toggle'); await press(key('Enter')); await expanded('snow', false); await saved('peakSnowCollapsed', true);
        const closedPending = await geometry(); setMode('service-error'); release();
        await wait(() => document.querySelector('.bpb-snow-status').textContent.includes('Could not load'), 'hidden refresh error');
        stable(closedPending, await geometry(), 'background error cannot expand a collapsed card');
        await press(key('Enter')); await expanded('snow', true); await saved('peakSnowCollapsed', false);
        setMode('complete'); await click('.bpb-snow-refresh'); await ready();
        await focus('snow', '.bpb-peak-card-toggle'); await image(`${width}-${theme}-expanded`);
        const current = await readSettings(); await setSettings({ ...current, showSnotel: false });
        await wait(() => document.querySelector('#bpb-peak-snow-row').hidden, 'SNOTEL feature off');
        await setSettings({ ...current, showSnotel: true }); await ready(); assert.deepEqual(await order(), ['snow', 'weather', 'sun']);
        cases.push({ width, theme, states: ['header-hit-area', 'collapse', 'keyboard', 'pointer', 'cancel', 'reload', 'weather-refresh-error-retry', 'pending', 'closed-error', 'retry', 'feature-off-on'] });
    }
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
    await press(key('Tab')); await focus('snow', '.bpb-peak-card-toggle');
    const keyboardFocus = await evaluate(() => ({ control: document.activeElement.className,
        visible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.equal(keyboardFocus.outline, 'solid', `keyboard focus outlines the full header: ${JSON.stringify(keyboardFocus)}`);
    await image('200-percent');
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
