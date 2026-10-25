// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { verifyWeatherConditions, verifyWeatherTabWrapping } from './verify-weather-day-switches.mjs';
import { waitForCondition } from './browser-verification-fixtures.mjs';

// Uses the existing hidden, real-manifest HTTPS fixture transport and teardown.
// Isolated from the older peak suite's unrelated location-header assertions.
export async function verifyWeatherClouds({ origin, evaluate, navigate, click: clickControl, press, resize, screenshotPage,
    setSettings, setZoom, wait, setMode, release, evidence, networkErrors, firefoxMode }) {
    const output = process.env.BPB_VERIFY_WEATHER_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const card = '#bpb-peak-weather', day = `${card} .bpb-week-day[open]`, cases = [];
    // Actual tab activations save synced preferences. Across the full matrix,
    // wait for Chrome's write budget rather than failing the next setup write.
    const configure = values => waitForCondition(async () => {
        await setSettings({ ...values, showSummitCloud: false }); return true;
    }, { description: 'weather fixture settings write', timeoutMs: 65_000, intervalMs: 1000 });
    // At 200% zoom on a narrow viewport the native Peakbagger table is wider
    // than the viewport. WebDriver's vertical-only reveal cannot expose every
    // tab; pan to the real control before asking the transport to click it.
    const click = async selector => {
        await evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }), selector);
        await clickControl(selector);
    };
    const visible = () => wait(() => document.getElementById('bpb-peak-weather')?.getClientRects().length > 0,
        'weather settings resolved and card visible before lazy-load scrolling');
    const ready = () => waitForCondition(() => evaluate(() => {
        const card = document.getElementById('bpb-peak-weather'), bounds = card?.getBoundingClientRect();
        return { days: card?.querySelectorAll('.bpb-week-day').length, busy: card?.getAttribute('aria-busy'),
            status: card?.querySelector('.bpb-week-status').textContent, visibility: document.visibilityState,
            hidden: card?.hidden, bounds: bounds && { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
    }), { description: 'cloud weather settled', timeoutMs: 20_000, isReady: state => state.days === 16 && state.busy === 'false' });
    const snapshot = () => {
        const card = document.getElementById('bpb-peak-weather'), day = card.querySelector('.bpb-week-day[open]');
        const bounds = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { boxes: [card, card.querySelector('header'), card.querySelector('.bpb-week-overview'),
            day.querySelector('summary'), day.querySelector('.bpb-week-tabs'), day.nextElementSibling, card.querySelector('footer'),
            card.closest('table')].filter(Boolean).map(bounds),
        scroll: window.scrollY, pageWidth: document.documentElement.scrollWidth };
    };
    const stable = (before, after, label) => {
        assert.equal(after.boxes.length, before.boxes.length, label);
        after.boxes.forEach((box, index) => {
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - before.boxes[index][key]) <= 1,
                `${label}: box ${index}.${key} shifted: ${JSON.stringify({ before, after })}`);
        });
        assert.ok(Math.abs(after.scroll - before.scroll) <= 1, `${label}: reading position moved`);
        assert.ok(Math.abs(after.pageWidth - before.pageWidth) <= 1, `${label}: document width moved`);
    };
    const graph = () => wait(() => document.querySelector('.bpb-week-day[open] [data-metric="cloud"][aria-selected="true"]')
        && document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'cloud graph rendered');
    for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) for (const width of [1440, 375]) {
        const units = theme === 'light' ? 'imperial' : 'metric';
        await configure({ theme, units }); await resize(width, 1100);
        setMode('complete'); const beforeLoad = evidence.length;
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=no-map`);
        await visible();
        await setZoom(zoom);
        await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start', behavior: 'instant' }));
        await ready();
        await wait(() => ['light', 'dark'].includes(document.documentElement.dataset.bpbTheme), 'theme applied');
        assert.equal(evidence.length - beforeLoad, 1, 'cloud cover arrives with the existing weather request');
        assert.ok(evidence.at(-1).fields.includes('cloud_cover'));
        assert.equal(evidence.at(-1).fields.includes('snowfall'), false, 'removed snowfall is not requested');
        assert.ok(evidence.at(-1).fields.includes('freezing_level_height'));
        for (const period of ['forecast', 'past']) {
            const label = `${firefoxMode ? 'firefox' : 'chrome'}-clouds-${theme}-${width}-${zoom}x-${period}`;
            await click(`${card} [data-period="${period}"]`);
            await click(`${card} .bpb-week-day:first-child > summary`);
            await click(`${day} [data-metric="code"]`);
            await verifyWeatherConditions(evaluate);
            assert.equal(await evaluate(() => document.querySelector('.bpb-week-day[open] [data-metric="snowfall"], .bpb-week-day[open] [data-weather-row="snowfall"]')), null);
            if (output) {
                await evaluate(() => document.querySelector('.bpb-week-day[open] > summary').scrollIntoView({ block: 'start', behavior: 'instant' }));
                await screenshotPage(path.join(output, `${label}-conditions.png`));
            }
            await click(`${day} [data-metric="freezing"]`);
            // Activate Clouds by keyboard, preserving its native tab semantics.
            await press(firefoxMode ? '\uE014' : 'ArrowRight'); await graph();
            assert.equal(await evaluate(() => document.activeElement.dataset.metric), 'cloud');
            assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.bpb-week-day[open] .bpb-week-axis')].slice(0, 3).map(node => node.textContent)), ['0%', '50%', '100%']);
            const values = await evaluate(() => [...document.querySelectorAll('.bpb-week-day[open] .bpb-week-point title')].map(node => node.textContent));
            for (const value of ['0%', '25%', '50%', '100%']) assert.ok(values.some(text => text.endsWith(`· ${value}`)), `${units}: ${value}`);
            const line = await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-line').getAttribute('d'));
            assert.ok(line.split('M').length > 2, 'missing cloud hours leave visible gaps');
            await evaluate(() => {
                const chart = document.querySelector('.bpb-week-day[open] .bpb-week-chart');
                chart.scrollIntoView({ block: 'center', behavior: 'instant' }); chart.focus({ preventScroll: true });
            });
            const before = await evaluate(snapshot);
            for (const key of [firefoxMode ? '\uE011' : 'Home', firefoxMode ? '\uE014' : 'ArrowRight', firefoxMode ? '\uE010' : 'End']) {
                await press(key);
                await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-cursor'), 'keyboard cloud reading');
                stable(before, await evaluate(snapshot), `${theme}/${width}/${zoom}/${period}: reading`);
            }
            for (const metric of ['temperature', 'precipitation', 'freezing', 'cloud', 'wind', 'gust', 'cloud']) {
                // Keep the target visible before measuring so transport scrolling
                // cannot masquerade as an application layout shift.
                await evaluate(metric => document.querySelector(`.bpb-week-day[open] [data-metric="${metric}"]`)
                    .scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }), metric);
                const before = await evaluate(snapshot);
                await evaluate(() => {
                    window.__bpbCloudFrames = []; window.__bpbCloudStopped = false;
                    const collect = () => {
                        if (window.__bpbCloudStopped) return;
                        const day = document.querySelector('.bpb-week-day[open]');
                        window.__bpbCloudFrames.push({ top: day.nextElementSibling?.getBoundingClientRect().top,
                            scroll: window.scrollY, tabs: day.querySelector('.bpb-week-tabs').getBoundingClientRect().height });
                        requestAnimationFrame(collect);
                    }; requestAnimationFrame(collect);
                });
                await click(`${day} [data-metric="${metric}"]`);
                await wait(() => window.__bpbCloudFrames.length >= 3, 'intermediate cloud frames captured');
                const frames = await evaluate(() => { window.__bpbCloudStopped = true; return window.__bpbCloudFrames; });
                stable(before, await evaluate(snapshot), `${theme}/${width}/${zoom}/${period}: ${metric}`);
                assert.ok(frames.every(frame => Math.abs(frame.scroll - before.scroll) <= 1
                    && Math.abs(frame.top - before.boxes[5].y) <= 1
                    && Math.abs(frame.tabs - before.boxes[4].height) <= 1), `intermediate graph movement: ${JSON.stringify(frames)}`);
                if (metric === 'temperature' || metric === 'wind') {
                    await evaluate(() => {
                        const chart = document.querySelector('.bpb-week-day[open] .bpb-week-chart');
                        chart.scrollIntoView({ block: 'center', behavior: 'instant' }); chart.focus({ preventScroll: true });
                    });
                    const initial = await evaluate(snapshot);
                    for (const key of [firefoxMode ? '\uE011' : 'Home', firefoxMode ? '\uE010' : 'End', firefoxMode ? '\uE00C' : 'Escape']) {
                        await press(key);
                        const text = await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-readout').textContent);
                        if (key === (firefoxMode ? '\uE00C' : 'Escape')) assert.match(text, /Low.*High/);
                        else assert.match(text, metric === 'temperature' ? /Feels like .*°[CF]/ : /Wind from SW \(225°\)/);
                        stable(initial, await evaluate(snapshot), `${label}: ${metric} detail reading`);
                        if (output && key === (firefoxMode ? '\uE011' : 'Home')) await screenshotPage(path.join(output, `${label}-${metric}-reading.png`));
                    }
                }
                if (metric === 'precipitation' || metric === 'freezing') {
                    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'rain/freezing plot rendered');
                    if (metric === 'freezing') assert.ok(await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-reference')));
                    if (output) {
                        await evaluate(() => document.querySelector('.bpb-week-day[open] > summary').scrollIntoView({ block: 'start', behavior: 'instant' }));
                        await screenshotPage(path.join(output, `${label}-${metric}.png`));
                    }
                    await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-info').scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
                    const helpBefore = await evaluate(snapshot);
                    await click(`${day} .bpb-week-info`);
                    await wait(() => !document.querySelector('.bpb-week-day[open] .bpb-week-explanation').hidden, 'clicked information appears');
                    if (metric === 'precipitation') {
                        const text = await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-explanation').textContent);
                        assert.match(text, /liquid water equivalent/);
                        assert.match(text, /snow portion.*fixed 1:7 water-to-snow depth ratio/);
                        assert.match(text, /1 cm of water → 7 cm of snow/);
                    }
                    stable(helpBefore, await evaluate(snapshot), 'information opens without reflow');
                    const popup = await evaluate(() => {
                        const r = document.querySelector('.bpb-week-day[open] .bpb-week-explanation').getBoundingClientRect();
                        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: document.documentElement.clientWidth, height: window.innerHeight };
                    });
                    assert.ok(popup.left >= 0 && popup.right <= popup.width + 1 && popup.top >= 0 && popup.bottom <= popup.height + 1,
                        `information must fit inside the visible viewport: ${JSON.stringify(popup)}`);
                    if (output && width === 375 && zoom === 1) await screenshotPage(path.join(output, `${label}-${metric}-info.png`));
                    await press(firefoxMode ? '\uE00C' : 'Escape');
                    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-explanation').hidden, 'Escape dismisses information');
                    stable(helpBefore, await evaluate(snapshot), 'information closes without reflow');
                    assert.equal(await evaluate(() => document.activeElement.classList.contains('bpb-week-info')), true);
                }
            }
            assert.deepEqual(await verifyWeatherTabWrapping(evaluate), [], 'Clouds must not cause selection-dependent wrapping');
            assert.equal(evidence.length - beforeLoad, 1, 'periods and cloud interactions reuse one response');
            if (output) {
                await evaluate(() => document.querySelector('.bpb-week-day[open] > summary').scrollIntoView({ block: 'start', behavior: 'instant' }));
                await screenshotPage(path.join(output, `${label}.png`));
            }
            cases.push({ theme, units, zoom, width, period });
            await click(`${day} > summary`);
        }
        await setZoom(1);
    }
    // Retain the cloud chart and its keyboard target through a held refresh,
    // service failure and a successful retry. Missing cloud data is supplemental.
    await configure({ theme: 'light', units: 'imperial' }); await resize(1440, 1100);
    setMode('complete'); await navigate(`${origin}/peak.aspx?pid=2296&week-weather=no-map`);
    await visible();
    await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start' })); await ready();
    await click(`${card} .bpb-week-day:first-child > summary`); await click(`${day} [data-metric="cloud"]`); await graph();
    await evaluate(() => {
        const chart = document.querySelector('.bpb-week-day[open] .bpb-week-chart');
        chart.scrollIntoView({ block: 'center' }); chart.focus({ preventScroll: true });
    });
    const initial = await evaluate(snapshot);
    setMode('loading');
    await evaluate(() => document.querySelector('.bpb-week-refresh').click());
    await wait(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'true', 'slow cloud refresh');
    stable(initial, await evaluate(snapshot), 'pending cloud refresh');
    assert.equal(await evaluate(() => document.activeElement.classList.contains('bpb-week-chart')), true);
    setMode('service-error'); release();
    await wait(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false'
        && document.querySelector('.bpb-week-status').textContent.includes('unavailable'), 'failed refresh retains clouds');
    stable(initial, await evaluate(snapshot), 'failed cloud refresh');
    setMode('loading'); await evaluate(() => document.querySelector('.bpb-week-refresh').click());
    await wait(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'true', 'cloud retry pending');
    setMode('complete'); release(); await ready(); await graph();
    stable(initial, await evaluate(snapshot), 'successful cloud retry');
    assert.equal(await evaluate(() => document.activeElement.classList.contains('bpb-week-chart')), true);
    setMode('missing-cloud'); await navigate(`${origin}/peak.aspx?pid=2296&week-weather=no-map`);
    await visible();
    await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start' })); await ready();
    // The forecast's final civil day can be truncated by the UTC API horizon.
    // Use completed history to distinguish absent clouds from that core gap.
    await click(`${card} [data-period="past"]`);
    assert.equal(await evaluate(() => document.querySelectorAll('.bpb-week-partial').length), 0, 'missing clouds do not invalidate core weather');
    await click(`${card} .bpb-week-day:first-child > summary`);
    for (const metric of ['cloud', 'freezing']) {
        await click(`${day} [data-metric="${metric}"]`);
        await wait(() => !document.querySelector('.bpb-week-day[open] .bpb-week-chart-empty').hidden, 'supplementary field unavailable state');
        assert.equal(await evaluate(() => document.querySelector('.bpb-week-day[open] .bpb-week-chart').tabIndex), -1);
    }
    const empty = await evaluate(snapshot);
    await click(`${day} [data-metric="temperature"]`);
    await wait(() => document.querySelector('.bpb-week-day[open] .bpb-week-line'), 'core temperature remains available');
    stable(empty, await evaluate(snapshot), 'missing clouds retain graph space');
    assert.deepEqual(networkErrors, []);
    assert.equal(cases.length, 16, 'all cloud configurations must execute');
    return { cases, transitions: ['keyboard', 'graph-tabs', 'slow-refresh', 'failure', 'retry', 'missing-cloud'], provider: 'stubbed', requests: evidence.length };
}
