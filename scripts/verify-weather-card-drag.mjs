// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifyWeatherCardDrag({ evaluate, navigate, click, press, resize, movePointer, pointerDown, pointerUp, wait, readLocal,
    setSettings, origin, evidence, screenshotPage, output, firefoxMode }) {
    const cardSelector = '#bpb-ascent-weather', handleSelector = `${cardSelector} .bpb-card-drag-handle`;
    const open = async () => {
        await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=gpx`);
        await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView({ block: 'center', behavior: 'instant' }));
        await wait(() => document.querySelector('.bpb-weather-model-description')?.textContent.includes('Using Best Match')
            && document.querySelectorAll('#bpb-ascent-gpx-details .bpb-map-handoff-button').length === 4, 'weather and GPS controls before card movement');
    };
    const assertColumn = async id => {
        await waitForCondition(() => evaluate(id => {
            const card = document.getElementById('bpb-ascent-weather'), svg = card.querySelector('.bpb-weather-chart');
            return { parent: card.parentElement.id, expected: `bpb-ascent-${id}-column`,
                animating: card.getAnimations().some(item => item.playState === 'running'),
                chartHidden: !!svg.closest('[hidden]'), chartWidth: svg.getBoundingClientRect().width,
                viewBoxWidth: Number(svg.getAttribute('viewBox')?.split(' ')[2]) };
        }, id), { description: 'moved weather card and responsive chart settle', timeoutMs: 20_000,
            isReady: state => state.parent === state.expected && !state.animating && (state.chartHidden || Math.abs(state.viewBoxWidth - state.chartWidth) < 1) });
        const state = await evaluate(id => {
            const card = document.getElementById('bpb-ascent-weather'), column = document.getElementById(`bpb-ascent-${id}-column`);
            const box = card.getBoundingClientRect(), bounds = column.getBoundingClientRect();
            const gps = document.getElementById('bpb-ascent-gpx-details');
            return { parent: card.parentElement.id, withinColumn: box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
                gpsColumn: gps.parentElement.id, handles: document.querySelectorAll('.bpb-card-drag-handle').length,
                overflow: [...card.querySelectorAll('*')].filter(node => {
                    if (!node.getClientRects().length || node.closest('[hidden]') || node.closest('.bpb-card-drag-status')
                        || node.parentElement?.closest('.bpb-weather-hourly-scroll') || (node.closest('details:not([open])') && !node.closest('summary'))) return false;
                    const rect = node.getBoundingClientRect(); return rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1);
                }).map(node => node.className || node.tagName) };
        }, id);
        assert.equal(state.parent, `bpb-ascent-${id}-column`); assert.equal(state.withinColumn, true, JSON.stringify(state));
        assert.equal(state.gpsColumn, 'bpb-ascent-summary-column'); assert.equal(state.handles, 1); assert.deepEqual(state.overflow, []);
    };
    const waitForSaved = id => waitForCondition(() => readLocal('bpbAscentWeatherColumn').then(saved => saved.bpbAscentWeatherColumn === id),
        { description: `local weather column saved as ${id}`, timeoutMs: 5000 });
    const coordinates = id => evaluate(id => {
        const card = document.getElementById('bpb-ascent-weather'), handle = card.querySelector('.bpb-card-drag-handle');
        handle.scrollIntoView({ block: 'center', behavior: 'instant' });
        const grip = handle.getBoundingClientRect(), target = document.getElementById(`bpb-ascent-${id}-column`).getBoundingClientRect();
        return { from: { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 }, to: { x: target.right - grip.width / 2 - 12, y: grip.top + grip.height / 2 } };
    }, id);
    for (const theme of ['light', 'dark']) {
        await setSettings({ theme, units: 'metric' }); await resize(1440, 1100); await open();
        await click('.bpb-weather-disclosure'); await click('[data-metric="temperature"]');
        const requests = evidence.length;
        const first = await coordinates('report');
        await pointerDown(first.from.x, first.from.y); await movePointer(first.to.x, first.to.y);
        await wait(() => document.getElementById('bpb-ascent-weather').hasAttribute('data-bpb-card-dragging')
            && !document.querySelector('.bpb-card-drop-preview').hidden, 'lifted weather and destination preview');
        assert.equal((await readLocal('bpbAscentWeatherColumn')).bpbAscentWeatherColumn, theme === 'light' ? undefined : 'summary', 'dragging never persists a tentative position');
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-weather-dragging.png`));
        await pointerUp(); await assertColumn('report'); await waitForSaved('report');
        assert.equal(evidence.length, requests, 'moving weather never refetches its data');
        assert.equal((await readLocal('bpbAscentWeatherColumn')).bpbAscentWeatherColumn, 'report');
        assert.equal(await evaluate(() => document.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded')), 'true');
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-weather-left.png`));
        await resize(375, 1100); await assertColumn('report');
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-weather-stacked.png`));
        await resize(1440, 1100); await open(); await assertColumn('report');
        await evaluate(() => document.querySelector('#bpb-ascent-weather .bpb-card-drag-handle').focus({ preventScroll: true }));
        await press(firefoxMode ? '\uE014' : 'ArrowRight'); await assertColumn('summary'); await waitForSaved('summary');
        const cancel = await coordinates('report');
        await pointerDown(cancel.from.x, cancel.from.y); await movePointer(cancel.to.x, cancel.to.y);
        await wait(() => document.getElementById('bpb-ascent-weather').hasAttribute('data-bpb-card-dragging'), 'drag before Escape');
        await press(firefoxMode ? '\uE00C' : 'Escape'); await pointerUp(); await assertColumn('summary');
        assert.equal((await readLocal('bpbAscentWeatherColumn')).bpbAscentWeatherColumn, 'summary', 'Escape leaves the previous saved choice');
        await click(handleSelector); await click('.bpb-layout-menu:not([hidden]) button:nth-child(2)'); await assertColumn('report');
        await click(handleSelector); await click('.bpb-layout-menu:not([hidden]) button:last-child'); await assertColumn('summary'); await waitForSaved('summary');
        await evaluate(() => document.querySelector('#bpb-ascent-weather .bpb-card-drag-handle').scrollIntoView({ block: 'center', behavior: 'instant' }));
        const within = await evaluate(() => {
            const grip = document.querySelector('#bpb-ascent-weather .bpb-card-drag-handle').getBoundingClientRect();
            const gps = document.getElementById('bpb-ascent-gpx-details').getBoundingClientRect();
            return { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2,
                toX: gps.left + gps.width / 2, toY: gps.top + Math.min(8, gps.height / 4) };
        });
        const stableGeometry = () => evaluate(() => {
            const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
            return { heading: rect(document.querySelector('h1')), summary: rect(document.querySelector('.bpb-ascent-table-split__summary')),
                report: rect(document.querySelector('.bpb-ascent-table-split__report')), gps: rect(document.getElementById('bpb-ascent-gpx-details')),
                scroll: [window.scrollX, window.scrollY], height: document.documentElement.scrollHeight };
        });
        const before = await stableGeometry();
        await pointerDown(within.x, within.y); await movePointer(within.toX, within.toY);
        await wait(() => !document.querySelector('.bpb-card-drop-preview').hidden, 'same-column insertion preview');
        assert.deepEqual(await stableGeometry(), before, 'same-column preview preserves surrounding native content and scroll');
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-weather-reorder-preview.png`));
        await pointerUp(); await assertColumn('summary');
        await wait(() => document.getElementById('bpb-ascent-weather').nextElementSibling?.id === 'bpb-ascent-gpx-details', 'weather moved above GPS links');
        await evaluate(() => document.querySelector('#bpb-ascent-weather .bpb-card-drag-handle').focus({ preventScroll: true }));
        await press(firefoxMode ? '\uE013' : 'ArrowUp');
        await wait(() => document.getElementById('bpb-ascent-weather').nextElementSibling?.classList.contains('bpb-ascent-table-split__summary'), 'weather moved above summary');
        await waitForCondition(() => readLocal('bpbAscentWeatherSlot'), { description: 'same-column position saved', isReady: value => value.bpbAscentWeatherSlot === 'before' });
        await open();
        await wait(() => document.getElementById('bpb-ascent-weather').nextElementSibling?.classList.contains('bpb-ascent-table-split__summary'), 'same-column position restored');
        for (const width of [1440, 375]) {
            await resize(width, 1100); await assertColumn('summary');
            if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-weather-first-${width}.png`));
        }
        await resize(1440, 1100);
        await evaluate(() => document.querySelector('#bpb-ascent-weather .bpb-card-drag-handle').focus({ preventScroll: true }));
        await press(firefoxMode ? '\uE010' : 'End');
        await wait(() => document.getElementById('bpb-ascent-weather').previousElementSibling?.id === 'bpb-ascent-gpx-details', 'weather returned below GPS links');
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-weather-right.png`));
    }
}
