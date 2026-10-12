// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';
import { verifyWeatherDaySwitches, verifyWeatherTabWrapping, verifyWeatherConditions } from './verify-weather-day-switches.mjs';
import { verifyWeatherTabStyles } from './verify-weather-tab-styles.mjs';

// Reuse the real extension/HTTPS/browser transports and their teardown rather
// than launch a second browser or substitute a content-script-only demo.
export async function verifyPeakWeatherCases({ origin, evaluate, navigate, click, press, resize, screenshot, screenshotPage, setSettings, wait, setMode, release, evidence, metadataEvidence, networkErrors, live, firefoxMode }) {
    const output = process.env.BPB_VERIFY_WEATHER_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const card = '#bpb-peak-weather';
    const assertHourlyTabOrder = async () => assert.deepEqual(
        await evaluate(() => [...document.querySelectorAll('.bpb-week-day[open] [data-metric]')].map(tab => tab.textContent)),
        ['Conditions', 'Temperature', 'Rain/snow', 'Wind', 'Gusts']);
    const openPage = async (kind = 'map') => {
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=${kind}`);
        await wait(() => document.getElementById('bpb-peak-weather'), 'real isolated peak weather bundle mounts');
        await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'center' }));
        await wait(() => document.querySelectorAll('.bpb-week-day').length === 16
            && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'sixteen summit-local forecast days');
        assert.equal(await evaluate(() => document.querySelector('[data-period="forecast"]').getAttribute('aria-selected')), 'true');
        if (!live) await click(`${card} [data-period="past"]`);
    };
    const geometry = () => {
        const card = document.getElementById('bpb-peak-weather'), right = card.closest('table'), frame = document.getElementById('Gmap');
        const r = card.getBoundingClientRect(), t = right.getBoundingClientRect(), m = frame?.getBoundingClientRect();
        return { width: r.width, tableWidth: t.width, left: r.left, right: r.right, parentLeft: t.left, parentRight: t.right,
            belowMap: !m || r.top >= m.bottom, nativeAlign: right.getAttribute('align'),
            overflow: [...card.querySelectorAll('select, .bpb-week-model-description, summary, button, header, footer, .bpb-week-range, .bpb-week-help, .bpb-week-accuracy:not([hidden]), .bpb-week-source[open] .bpb-week-models, .bpb-week-tabs, .bpb-week-chart:not([hidden]), .bpb-week-conditions:not([hidden])')].filter(node => {
                if (!node.getClientRects().length) return false;
                const n = node.getBoundingClientRect(); return n.left < r.left - 1 || n.right > r.right + 1;
            }).map(node => node.className || node.tagName),
            pageWidth: document.documentElement.scrollWidth, bg: getComputedStyle(card).backgroundColor,
            period: card.querySelector('[data-period][aria-selected="true"]').dataset.period,
            days: [...card.querySelectorAll('.bpb-week-day')].map(node => node.dataset.date) };
    };
    const assertGeometry = state => {
        assert.equal(state.nativeAlign, 'right', JSON.stringify(state));
        assert.equal(state.belowMap, true, JSON.stringify(state));
        assert.ok(state.left >= state.parentLeft - 1 && state.right <= state.parentRight + 1, JSON.stringify(state));
        assert.deepEqual(state.overflow, [], JSON.stringify(state));
        assert.equal(new Set(state.days).size, 16);
        assert.ok(state.days.every((date, index) => !index || (state.period === 'past' ? date < state.days[index - 1] : date > state.days[index - 1])), JSON.stringify(state));
    };
    await setSettings({ theme: 'light', units: 'imperial' });
    await openPage(); await resize(1440, 1100);
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-attribution').textContent), 'Powered by Open-Meteo');
    if (!live) {
        assert.equal(await evaluate(() => document.querySelector('[data-period="past"]').textContent), 'Past 16 days');
        assert.ok(await evaluate(() => document.querySelector('.bpb-week-sub').textContent.includes('16 completed days')));
        await click(`${card} .bpb-week-day:last-child > summary`);
        await wait(() => document.querySelector('.bpb-week-day[open] [data-metric="code"][aria-selected="true"]'), 'Conditions is the initial hourly tab');
        await verifyWeatherConditions(evaluate);
        for (const width of [1440, 375]) {
            await resize(width, 1100); assertGeometry(await evaluate(geometry));
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-default-conditions-${width}.png`));
        }
        await click(`${card} .bpb-week-day[open] [data-metric="wind"]`);
        await press(firefoxMode ? '\uE014' : 'ArrowRight');
        await wait(() => document.querySelector('.bpb-week-day[open] [data-metric="gust"][aria-selected="true"]'), 'keyboard gust choice');
        await openPage();
        await click(`${card} .bpb-week-day:last-child > summary`);
        await wait(() => document.querySelector('.bpb-week-day[open] [data-metric="gust"][aria-selected="true"]'), 'saved hourly tab survives navigation');
        const restoredRequests = evidence.length;
        await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
        await wait(() => document.querySelector('.bpb-week-day:last-child[open] .bpb-week-line'), 'oldest historical day has an hourly graph');
        assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-day:last-child .bpb-week-point').length), 24);
        assert.equal(evidence.length, restoredRequests, 'oldest history expansion reuses the combined response');
        await click(`${card} .bpb-week-day:last-child > summary`);
    }
    const assertForecastInfo = async () => {
        assert.equal(await evaluate(() => document.querySelector('.bpb-week-accuracy').hidden), false);
        assert.ok(await evaluate(() => document.querySelector('.bpb-week-accuracy').textContent.includes('may be inaccurate')));
        assert.ok(await evaluate(() => document.querySelector('.bpb-week-models').textContent.includes('GFS, 13 km')));
        assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').value), 'gfs_global');
        assert.ok(await evaluate(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using GFS')));
    };
    if (live) {
        await assertForecastInfo();
        assertGeometry(await evaluate(geometry));
        await click(`${card} [data-period="past"]`); assertGeometry(await evaluate(geometry));
        await click(`${card} [data-period="forecast"]`); assertGeometry(await evaluate(geometry));
        await click(`${card} .bpb-week-day:first-child > summary`);
        await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
        await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'live forecast hourly graph');
        await click(`${card} .bpb-week-source > summary`);
        await wait(() => document.querySelectorAll('[data-update-model]').length > 1 && !document.querySelector('.bpb-week-updates').textContent.includes('Loading'), 'live model metadata settles');
        assert.ok(await evaluate(() => [...document.querySelectorAll('[data-update-model="gfs_global"] td')].every(cell => !cell.textContent.includes('Unavailable'))), 'live GFS update clocks are available');
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-live-forecast.png`));
        assert.equal(evidence.length, 1, 'live past and forecast views must share one HTTP request');
        assert.deepEqual(metadataEvidence.map(request => request.path).sort(),
            ['/data/ncep_gfs013/static/meta.json', '/data/ncep_gfs025/static/meta.json']);
        assert.ok(metadataEvidence.every(request => request.host === 'api.open-meteo.com' && !request.query));
        assert.deepEqual(networkErrors, []);
        return { liveCors: 'passed', weatherRequests: evidence.length, metadataRequests: metadataEvidence.length, viewport: { width: 1440, height: 1100 } };
    }
    const widths = [1440, 768, 375], shapes = [];
    for (const theme of ['light', 'dark']) {
        await setSettings({ theme, units: theme === 'dark' ? 'metric' : 'imperial' });
        await openPage(); await resize(1440, 1100);
        await waitForCondition(async () => await evaluate(() => document.documentElement.getAttribute('data-bpb-theme')) === theme,
            { description: 'peak weather theme', timeoutMs: 20_000 });
        for (const width of widths) {
            await resize(width, 1100);
            await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'center' }));
            const state = await evaluate(geometry); assertGeometry(state); shapes.push({ theme, viewport: width, cardWidth: state.width });
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-${width}.png`));
            const before = evidence.length;
            await click(`${card} .bpb-week-day:first-child > summary`);
            await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
            await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'selected day’s hourly line graph');
            await assertHourlyTabOrder();
            await wait(() => {
                const chart = document.querySelector('.bpb-week-day[open] .bpb-week-chart');
                return Math.abs(Number(chart.querySelector('svg').getAttribute('viewBox').split(' ')[2]) - chart.getBoundingClientRect().width) < 1;
            }, 'hourly graph adapts to the card width');
            const opened = await evaluate(geometry); assertGeometry(opened);
            assert.ok(opened.pageWidth <= state.pageWidth + 1, 'hourly graph must fit inside the card without widening the peak page');
            assert.equal(evidence.length, before, 'hourly disclosure reuses the weekly response');
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-hourly-${width}.png`));
            for (const metric of ['precipitation', 'wind', 'gust', 'code']) {
                await click(`${card} .bpb-week-day[open] [data-metric="${metric}"]`);
                await waitForCondition(async () => await evaluate(() => document.querySelector('.bpb-week-day[open] [aria-selected="true"]').dataset.metric) === metric,
                    { description: 'hourly data tab selection', timeoutMs: 20_000 });
                assertGeometry(await evaluate(geometry));
                assert.equal(evidence.length, before, 'data tabs must not fetch weather');
                if (metric === 'code') {
                    await verifyWeatherConditions(evaluate);
                    if (output) {
                        await evaluate(() => document.querySelector('.bpb-week-day[open]').scrollIntoView({ block: 'start', behavior: 'instant' }));
                        await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-conditions-viewport-${width}.png`));
                    }
                }
                if (output && (width === 1440 || metric === 'code')) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-${metric}-${width}.png`));
            }
            await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
            await verifyWeatherTabStyles(evaluate, '.bpb-week-day[open] .bpb-week-tabs button');
            assert.deepEqual(await verifyWeatherTabWrapping(evaluate), [], 'selection must not change tab row count at wrapping thresholds');
            await click(`${card} .bpb-week-day:first-child > summary`);
            await click(`${card} [data-period="forecast"]`);
            assertGeometry(await evaluate(geometry));
            assert.equal(await evaluate(() => document.querySelector('.bpb-week-date strong').textContent), 'Today');
            assert.ok(await evaluate(() => document.querySelector('.bpb-week-sub').textContent.includes('Today + 15 days')));
            await assertForecastInfo();
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-forecast-${width}.png`));
            if (!await evaluate(() => document.querySelector('.bpb-week-day').open)) await click(`${card} .bpb-week-day:first-child > summary`);
            await wait(() => document.querySelector('.bpb-week-day:first-child[open] .bpb-week-line')
                && document.querySelectorAll('.bpb-week-day[open]').length === 1, 'first forecast day replaces the remembered final-day graph');
            await assertHourlyTabOrder();
            assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-day[open] .bpb-week-point').length), 24);
            await click(`${card} .bpb-week-day[open] [data-metric="precipitation"]`);
            await wait(() => document.querySelector('.bpb-week-day[open] [data-metric="precipitation"]').getAttribute('aria-selected') === 'true', 'forecast precipitation tab');
            assertGeometry(await evaluate(geometry));
            assert.equal(evidence.length, before, 'both periods and hourly graphs reuse one response');
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-forecast-hourly-${width}.png`));
            const updatesBefore = metadataEvidence.length;
            await click(`${card} .bpb-week-source > summary`);
            assert.equal(await evaluate(() => document.querySelector('.bpb-week-source').open), true);
            assertGeometry(await evaluate(geometry));
            if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-models-${width}.png`));
            await wait(() => document.querySelector('.bpb-week-source').open && document.querySelector('.bpb-week-updates').clientHeight > 0 && document.querySelectorAll('[data-update-model]').length > 1 && !document.querySelector('.bpb-week-updates').textContent.includes('Loading'), 'model update metadata settles');
            assert.equal(await evaluate(() => document.querySelectorAll('[data-update-model]').length), 2);
            assert.equal(await evaluate(() => document.querySelectorAll('[data-update-model="gfs_global"]').length), 2);
            assert.equal(metadataEvidence.length - updatesBefore, width === widths[0] ? 2 : 0, 'only GFS products load, once per page');
            assert.ok(metadataEvidence.slice(updatesBefore).every(request => ['/data/ncep_gfs013/static/meta.json', '/data/ncep_gfs025/static/meta.json'].includes(request.path)));
            assert.ok(await evaluate(() => document.querySelector('.bpb-week-updates').textContent.includes('Update interval')));
            assert.deepEqual(await evaluate(() => [...document.querySelectorAll('[data-update-model] td:last-child')].map(cell => cell.textContent)), ['Every 6 h', 'Every 6 h']);
            if (output) {
                await evaluate(() => document.querySelector('.bpb-week-updates').scrollIntoView({ block: 'start', behavior: 'instant' }));
                await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-updates-${width}.png`));
            }
            await click(`${card} .bpb-week-source > summary`);
            await click(`${card} .bpb-week-day:last-child > summary`);
            await wait(() => document.querySelector('.bpb-week-day:last-child[open] .bpb-week-line'), 'last forecast day remains expandable');
            assert.ok(await evaluate(() => {
                const last = document.querySelector('.bpb-week-day:last-child');
                return !last.querySelector('.bpb-week-metrics').textContent.includes('(partial)')
                    || last.querySelector('.bpb-week-partial')?.textContent.includes('Incomplete hours');
            }), 'truncated final-day totals must be labelled incomplete');
            assert.equal(evidence.length, before, 'model disclosure and final-day expansion make no weather requests');
            if (output && width === 375) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-last-day-${width}.png`));
            await click(`${card} [data-period="past"]`);
        }
        await resize(1440, 1100);
        await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'center' }));
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-${theme}-right-column.png`));
    }
    await openPage();
    const chooseModel = async id => evaluate(value => {
        const select = document.querySelector('#bpb-peak-weather-model');
        select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    }, id);
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').options[0].value), 'best_match');
    await chooseModel('best_match');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using Best Match')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'Best Match history with named forecast');
    assert.ok(await evaluate(() => document.querySelector('.bpb-week-models').textContent.includes('Open-Meteo automatic blend; source models vary')));
    const blendMetadataBefore = metadataEvidence.length;
    await click(`${card} .bpb-week-source > summary`);
    await wait(() => document.querySelector('[data-update-model="best_match"] td')?.textContent === 'Varies by model', 'blend does not invent a single update clock');
    assert.equal(await evaluate(() => document.querySelectorAll('[data-update-model]').length), 1);
    assert.equal(metadataEvidence.length, blendMetadataBefore, 'Best Match does not fetch other models update clocks');
    await click(`${card} .bpb-week-source > summary`);
    await click(`${card} [data-period="forecast"]`);
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').value), 'gfs_global');
    await chooseModel('best_match');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using Best Match')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'Best Match forecast uses a deduplicated blend request');
    const blendRequests = evidence.length;
    for (const width of [1440, 375]) {
        await resize(width, 1100); assertGeometry(await evaluate(geometry));
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-best-match-${width}.png`));
    }
    await click(`${card} [data-period="past"]`);
    assert.equal(evidence.length, blendRequests, 'switching between Best Match periods reuses the response');
    await openPage();
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').value), 'best_match', 'Best Match choice survives navigation');
    await chooseModel('gfs_global');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using GFS')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'restore named history');
    await click(`${card} [data-period="forecast"]`); await chooseModel('gfs_global');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using GFS')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'restore named forecast');
    await click(`${card} [data-period="past"]`);
    const beforeModels = evidence.length;
    assert.ok(await evaluate(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using GFS')));
    await chooseModel('icon_global');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using ICON Global')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'explicit historical model');
    assertGeometry(await evaluate(geometry));
    assert.equal(evidence.length, beforeModels + 1);
    const selectedMetadataBefore = metadataEvidence.length;
    await click(`${card} .bpb-week-source > summary`);
    await wait(() => document.querySelectorAll('[data-update-model]').length === 1
        && document.querySelector('[data-update-model="icon_global"]')
        && !document.querySelector('.bpb-week-updates').textContent.includes('Loading'), 'only selected ICON update clocks');
    assert.equal(metadataEvidence.length, selectedMetadataBefore + 1);
    assert.equal(metadataEvidence.at(-1).path, '/data/dwd_icon/static/meta.json');
    for (const width of [1440, 375]) {
        await resize(width, 1100); assertGeometry(await evaluate(geometry));
        if (output) {
            await evaluate(() => document.querySelector('.bpb-week-updates').scrollIntoView({ block: 'center', behavior: 'instant' }));
            await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-selected-updates-${width}.png`));
        }
    }
    await click(`${card} [data-period="forecast"]`);
    await wait(() => document.querySelectorAll('[data-update-model]').length === 2
        && document.querySelectorAll('[data-update-model="gfs_global"]').length === 2
        && !document.querySelector('.bpb-week-updates').textContent.includes('Loading'), 'period switch replaces ICON with GFS clocks');
    assert.equal(metadataEvidence.length, selectedMetadataBefore + 3);
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').value), 'gfs_global');
    await chooseModel('gfs_hrrr');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using HRRR')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'short-range explicit forecast');
    await wait(() => document.querySelectorAll('[data-update-model]').length === 1
        && document.querySelector('[data-update-model="gfs_hrrr"]')
        && !document.querySelector('.bpb-week-updates').textContent.includes('Loading'), 'model change replaces GFS clocks with HRRR');
    assert.equal(metadataEvidence.length, selectedMetadataBefore + 4);
    assert.equal(metadataEvidence.at(-1).path, '/data/ncep_hrrr_conus/static/meta.json');
    assert.ok(await evaluate(() => document.querySelectorAll('.bpb-week-day').length <= 3));
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-model-description').textContent), 'Using HRRR · 3 km · up to 2 days');
    for (const width of [1440, 375]) {
        await resize(width, 1100);
        const state = await evaluate(geometry);
        assert.deepEqual(state.overflow, []);
        assert.equal(state.belowMap, true);
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-short-model-${width}.png`));
    }
    await click(`${card} [data-period="past"]`);
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').value), 'icon_global');
    await wait(() => document.querySelectorAll('[data-update-model]').length === 1
        && document.querySelector('[data-update-model="icon_global"]')
        && !document.querySelector('.bpb-week-updates').textContent.includes('Loading'), 'returning period reuses ICON clocks');
    assert.equal(metadataEvidence.length, selectedMetadataBefore + 4);
    await click(`${card} .bpb-week-source > summary`);
    assertGeometry(await evaluate(geometry));
    await chooseModel('gfs_global');
    await click(`${card} [data-period="forecast"]`);
    await chooseModel('gfs_global');
    await wait(() => document.querySelectorAll('.bpb-week-day').length === 16 && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'reset saved models');
    await openPage();
    const daySwitches = await verifyWeatherDaySwitches({ evaluate, click, press, resize, firefoxMode });
    assert.equal(daySwitches.length, 27);
    await setSettings({ theme: 'light', units: 'imperial', fillTripInfo: true });
    await openPage();
    await wait(() => document.querySelector('.bpb-week-temp').textContent.includes('°F'), 'initial weather unit preference applied');
    await click('.bpb-week-day:first-child > summary');
    await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
    await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-chart').focus());
    await press(firefoxMode ? '\uE011' : 'Home');
    const pinned = await evaluate(() => {
        window.__bpbWeatherFocused = document.activeElement;
        return document.querySelector('.bpb-week-readout').textContent;
    });
    await setSettings({ theme: 'dark', units: 'imperial', fillTripInfo: false });
    await wait(() => document.documentElement.dataset.bpbTheme === 'dark', 'unrelated theme update applied');
    assert.equal(await evaluate(() => document.activeElement === window.__bpbWeatherFocused && window.__bpbWeatherFocused.isConnected), true,
        JSON.stringify(await evaluate(() => ({ before: window.__bpbWeatherFocused?.outerHTML.slice(0, 160), connected: window.__bpbWeatherFocused?.isConnected,
            after: document.activeElement.outerHTML.slice(0, 160), reading: document.querySelector('.bpb-week-readout').textContent }))));
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-readout').textContent), pinned);
    await setSettings({ theme: 'dark', units: 'metric', fillTripInfo: false });
    await wait(() => document.querySelector('.bpb-week-readout').textContent.includes('°C'), 'pinned reading changes units');
    assert.equal(await evaluate(() => document.activeElement.matches('.bpb-week-chart')), true);
    const metricPinned = await evaluate(() => document.querySelector('.bpb-week-readout').textContent);
    await evaluate(() => document.querySelector('.bpb-week-refresh').click());
    await wait(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'refresh preserves exploration state');
    assert.equal(await evaluate(() => document.activeElement.matches('.bpb-week-chart')), true);
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-readout').textContent), metricPinned);
    await evaluate(() => { delete window.__bpbWeatherFocused; });
    await openPage();
    // Native summary disclosure is operable by keyboard in both engines.
    await evaluate(() => document.querySelector('#bpb-peak-weather .bpb-week-day > summary').focus());
    await press(firefoxMode ? '\uE007' : 'Enter');
    await wait(() => document.querySelector('#bpb-peak-weather .bpb-week-day[open] .bpb-week-line'), 'keyboard disclosure');
    await evaluate(() => document.querySelector('.bpb-week-day[open] [data-metric="temperature"]').focus());
    await press(firefoxMode ? '\uE014' : 'ArrowRight');
    await wait(() => document.querySelector('.bpb-week-day[open] [data-metric="precipitation"]').getAttribute('aria-selected') === 'true', 'keyboard data tab');
    assert.equal(await evaluate(() => document.activeElement.dataset.metric), 'precipitation');
    await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-chart').focus());
    await press(firefoxMode ? '\uE010' : 'End');
    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-readout').textContent.includes('next midnight'), 'keyboard final precipitation interval');
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-day[open] .bpb-week-cursor').length), 1);
    await press(firefoxMode ? '\uE00C' : 'Escape');
    await wait(() => !document.querySelector('.bpb-week-day[open] .bpb-week-cursor'), 'Escape clears hourly selection');
    await click(`${card} .bpb-week-day[open] .bpb-week-chart`);
    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-cursor'), 'click pins an hourly reading');
    if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-cursor.png`));
    await openPage('no-map'); assertGeometry(await evaluate(geometry));
    setMode('negative-precipitation'); await openPage();
    await chooseModel('meteofrance_arpege_world');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using ARPEGE World')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'negative ARPEGE precipitation retains usable weather');
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-partial').length), 0);
    const negativeRequests = evidence.length;
    await click(`${card} [data-period="forecast"]`);
    assertGeometry(await evaluate(geometry));
    assert.ok(await evaluate(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using GFS')));
    await click(`${card} [data-period="past"]`);
    await click(`${card} .bpb-week-day:nth-last-child(2) > summary`);
    await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'negative precipitation day retains its temperature graph');
    await click(`${card} .bpb-week-day[open] [data-metric="precipitation"]`);
    await wait(() => document.querySelector('.bpb-week-day[open] [data-metric="precipitation"]').getAttribute('aria-selected') === 'true', 'negative precipitation graph selected');
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-day[open] .bpb-week-point').length), 24);
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-metrics').textContent.includes('(partial)')), false);
    for (const width of [1440, 375]) {
        await resize(width, 1100); assertGeometry(await evaluate(geometry));
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-negative-rain-${width}.png`));
    }
    assert.equal(evidence.length, negativeRequests, 'period switching and the hourly graph reuse the combined response');
    await chooseModel('gfs_global');
    await wait(() => document.querySelector('.bpb-week-model-description').textContent.includes('Using GFS')
        && document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false', 'reset historical model after negative precipitation');
    setMode('partial'); await openPage();
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-partial').length), 16);
    assert.ok(await evaluate(() => [...document.querySelectorAll('.bpb-week-metrics')].every(node => node.textContent.includes('Rain/snow —'))));
    await click(`${card} .bpb-week-day:first-child > summary`);
    await click(`${card} .bpb-week-day[open] [data-metric="temperature"]`);
    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'partial day graph');
    await click(`${card} .bpb-week-day[open] [data-metric="precipitation"]`);
    await wait(() => !document.querySelector('.bpb-week-day[open] .bpb-week-chart-empty').hidden, 'missing hourly field has no fabricated zero line');
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-day[open] .bpb-week-line').length), 0);
    if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-missing-rain.png`));
    setMode('error'); await click('.bpb-week-refresh');
    await wait(() => document.querySelector('.bpb-week-status').textContent.includes('Open-Meteo request limit reached'), 'rate limit explains failed refresh');
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-day').length), 16);
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-refresh').disabled), true);
    assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').disabled), true);
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-status').dataset.kind), 'rate-limit');
    const limitedRequests = evidence.length;
    await click(`${card} [data-period="forecast"]`);
    assertGeometry(await evaluate(geometry));
    assert.equal(await evaluate(() => document.querySelector('.bpb-week-status').dataset.kind), 'rate-limit');
    assert.equal(evidence.length, limitedRequests, 'period switching during a cooldown must not request weather');
    await click(`${card} [data-period="past"]`);
    for (const width of [1440, 375]) {
        await resize(width, 1100);
        await evaluate(() => document.querySelector('.bpb-week-status').scrollIntoView({ block: 'center' }));
        assertGeometry(await evaluate(geometry));
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-rate-limit-${width}.png`));
    }
    setMode('empty'); await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map`);
    await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView());
    await wait(() => document.querySelector('.bpb-week-status').textContent.includes('unavailable for this summit'), 'empty response never appears as sixteen clear dry days');
    if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-unavailable.png`));
    setMode('loading'); await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map`);
    await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView());
    await wait(() => document.querySelector('.bpb-week-status').textContent.includes('Loading'), 'visible weekly loading feedback');
    if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-loading.png`));
    setMode('complete'); release();
    await wait(() => document.querySelectorAll('.bpb-week-day').length === 16, 'held weather response settles');
    assert.ok(evidence.every(request => request.host === 'api.open-meteo.com' && ['best_match', 'best_match,gfs_global', 'gfs_global,best_match', 'gfs_global', 'gfs_global,gfs_hrrr', 'icon_global,gfs_hrrr', 'icon_global,gfs_global', 'meteofrance_arpege_world,gfs_global'].includes(request.model)));
    assert.ok(metadataEvidence.every(request => request.host === 'api.open-meteo.com' && !request.query));
    assert.deepEqual(networkErrors, []);
    return { viewports: widths, themes: ['light', 'dark'], shapes, fixtures: ['right-column', 'forecast', 'selected-model-updates', 'best-match', 'single-request-periods', 'hourly-graphs', 'data-tabs', 'local-hourly-tab', 'conditions', 'keyboard', 'cursor', 'no-map', 'negative-precipitation', 'partial', 'rate-limit', 'empty', 'loading'], requests: evidence, metadataRequests: metadataEvidence };
}
