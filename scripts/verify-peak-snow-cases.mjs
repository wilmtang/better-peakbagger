// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, getComputedStyle */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { verificationScreenshots } from './browser-verification-evidence.mjs';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export const readSnowCardPlacement = () => {
    const weather = document.getElementById('bpb-peak-weather-row');
    const snow = document.getElementById('bpb-peak-snow-row');
    const rows = Array.from(snow?.parentElement?.children || []);
    return { sameStack: !!weather && !!snow && weather.parentElement === snow.parentElement,
        followsWeather: rows.indexOf(weather) >= 0 && rows.indexOf(weather) < rows.indexOf(snow),
        order: rows.map(row => row.id).filter(Boolean) };
};

// Shared Chrome/Firefox cases exercise the real manifest and isolated bundle.
// Only provider responses and native fixture pages are substituted.
export async function verifyPeakSnowCases({ origin, evaluate, navigate, click, press, movePointer, clickPoint, resize, screenshot, screenshotPage,
    setSettings, setZoom, wait, writeLocal, setMode, release, snowEvidence, networkErrors, firefoxMode }) {
    const output = process.env.BPB_VERIFY_SNOW_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const captureRequested = verificationScreenshots();
    const browser = firefoxMode ? 'firefox' : 'chrome', cases = [];
    const key = name => firefoxMode ? { Enter: '\uE007', Space: '\uE00D', ArrowDown: '\uE015', ArrowLeft: '\uE012',
        ArrowRight: '\uE014', Home: '\uE011', End: '\uE010', Escape: '\uE00C' }[name] : name;
    const ready = () => wait(() => document.querySelector('#bpb-peak-snow')?.getAttribute('aria-busy') === 'false'
        && document.querySelector('.bpb-snow-status')?.textContent.includes('Hourly readings'), 'visible snow observations');
    const settleForecast = async description => {
        await wait(() => document.getElementById('bpb-peak-weather')?.hidden === false, 'neighboring forecast mount');
        // Forecast reads wait for viewport eligibility. Visit the neighbor
        // before focusing Snow, which can put Weather above the viewport.
        await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start' }));
        await waitForCondition(() => evaluate(() => ({ days: document.querySelectorAll('.bpb-week-day').length,
            busy: document.getElementById('bpb-peak-weather')?.getAttribute('aria-busy'),
            status: document.querySelector('.bpb-week-status')?.textContent })), {
            description, timeoutMs: 20_000, isReady: state => state.days === 16 && state.busy === 'false',
        });
    };
    const geometry = () => evaluate(() => {
        const card = document.getElementById('bpb-peak-snow');
        const rect = node => {
            const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const table = card.closest('table');
        const following = [...document.querySelectorAll('h2')].find(node => node.textContent.trim() === 'Other Photos');
        const bounds = card.getBoundingClientRect();
        const overflow = [...card.querySelectorAll('header, h2, button, select, p, strong, table, summary, footer')].filter(node => {
            const closed = node.closest('details:not([open])');
            if (closed && !closed.querySelector(':scope > summary')?.contains(node)) return false;
            if (!node.getClientRects().length || node.closest('[hidden]')) return false;
            const r = node.getBoundingClientRect(); return r.left < bounds.left - 1 || r.right > bounds.right + 1;
        }).map(node => node.className || node.tagName);
        return { button: rect(card.querySelector('.bpb-snow-refresh')), heading: rect(card.querySelector('h2')), card: rect(card),
            column: rect(table), following: following ? rect(following) : null,
            scroll: { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight },
            overflow, focus: document.activeElement?.className, busy: card.getAttribute('aria-busy'),
            selection: card.querySelector('select').value, background: getComputedStyle(card).backgroundColor };
    });
    const stable = (before, after, label) => {
        for (const name of ['button', 'heading', 'card', 'column', 'following', 'scroll']) {
            assert.ok(before[name] && after[name], `${label}: missing ${name}`);
            for (const dimension of Object.keys(before[name])) assert.ok(Math.abs(before[name][dimension] - after[name][dimension]) <= 1,
                `${label}: ${name}.${dimension} moved: ${before[name][dimension]} → ${after[name][dimension]}; ${JSON.stringify({ before, after })}`);
        }
        assert.deepEqual(after.overflow, [], `${label}: ${JSON.stringify(after)}`);
    };
    const focusRefresh = async () => {
        await wait(() => document.getElementById('bpb-peak-snow')?.hidden === false, 'visible snow card');
        return evaluate(() => {
            const card = document.getElementById('bpb-peak-snow');
            card.scrollIntoView({ block: 'start' }); card.querySelector('.bpb-snow-refresh').focus({ preventScroll: true });
        });
    };
    const pending = () => waitForCondition(() => evaluate(() => ({
        busy: document.querySelector('#bpb-peak-snow')?.getAttribute('aria-busy'),
        status: document.querySelector('.bpb-snow-status')?.textContent,
        station: document.getElementById('bpb-peak-snow-station')?.value,
        focus: document.activeElement?.outerHTML?.slice(0, 350),
    })), { description: 'pending snow request', timeoutMs: 10_000, isReady: state => state.busy === 'true' });
    const image = async (name, reference = false) => {
        if (!output || !captureRequested(reference)) return;
        // Firefox element screenshots scroll even when the element already fits
        // the viewport. Capture the current page so evidence cannot move the
        // user's reading position between geometry assertions.
        if (firefoxMode) await screenshotPage(path.join(output, `${browser}-${name}.png`));
        else { await screenshot(path.join(output, `${browser}-${name}.png`)); await screenshotPage(path.join(output, `${browser}-${name}-page.png`)); }
    };
    const inspectChart = async (name, zoomed = false) => {
        await evaluate(() => {
            const chart = document.querySelector('.bpb-snow-graph');
            chart.scrollIntoView({ block: 'center', behavior: 'instant' }); chart.focus({ preventScroll: true });
            window.__snowChartFrames = [];
            window.__snowChartTrace = true;
            const trace = () => {
                if (!window.__snowChartTrace) return;
                window.__snowChartFrames.push([...document.querySelectorAll('#bpb-peak-snow, .bpb-snow-range, .bpb-snow-graph, .bpb-snow-dates')].map(node => {
                    const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
                }));
                window.requestAnimationFrame(trace);
            };
            window.requestAnimationFrame(trace);
        });
        await movePointer(1, 1);
        const before = await geometry(), requests = snowEvidence.length;
        assert.equal(await evaluate(() => document.querySelector('.bpb-snow-graph').tabIndex), 0);
        for (const direction of ['Home', 'ArrowRight', 'End', 'ArrowLeft']) {
            await press(key(direction));
            assert.equal(await evaluate(() => Boolean(document.querySelector('.bpb-snow-selected'))), true);
            stable(before, await geometry(), `${name}: chart ${direction}`);
        }
        const reading = () => evaluate(() => document.querySelector('.bpb-snow-range > span').textContent);
        const pinned = await reading();
        const points = await evaluate(() => {
            const chart = document.querySelector('.bpb-snow-graph svg'), r = chart.getBoundingClientRect();
            return [...chart.querySelectorAll('circle:not(.bpb-snow-selected)')].map(dot => ({
                x: r.left + Number(dot.getAttribute('cx')), y: r.top + Number(dot.getAttribute('cy')),
            }));
        });
        await movePointer(points[0].x, points[0].y);
        assert.notEqual(await reading(), pinned, 'hover previews another day');
        stable(before, await geometry(), `${name}: hover preview`);
        await movePointer(1, 1); assert.equal(await reading(), pinned, 'leaving restores the pinned day');
        await clickPoint(points[2].x, points[2].y); const clicked = await reading();
        await movePointer(1, 1); assert.equal(await reading(), clicked, 'a pointer click pins a daily reading');
        stable(before, await geometry(), `${name}: pinned pointer reading`);
        // Chromium's element screenshot scrolls the page at tab zoom. Keep
        // the compositor viewport unchanged while the geometry trace is live.
        if (zoomed && output && captureRequested()) await screenshotPage(path.join(output, `${browser}-${name}-interactive-chart.png`));
        else await image(`${name}-interactive-chart`);
        await press(key('Escape'));
        assert.match(await reading(), /Hover, tap or use ← →/);
        assert.equal(await evaluate(() => Boolean(document.querySelector('.bpb-snow-cursor'))), false);
        stable(before, await geometry(), `${name}: cleared reading`);
        assert.equal(snowEvidence.length, requests, 'inspecting readings never fetches observations');
        const frames = await evaluate(() => { window.__snowChartTrace = false; return window.__snowChartFrames; });
        assert.ok(frames.length > 0, 'chart stability trace must execute frames');
        for (const frame of frames) frame.forEach((box, i) => box.forEach((value, j) =>
            assert.ok(Math.abs(value - frames[0][i][j]) <= 1, `${name}: chart changed geometry during interaction`)));
        cases.push(`${name}-chart-hover-click-keyboard-stability`);
    };

    for (const width of [1440, 681, 375]) for (const theme of ['light', 'dark']) {
        const name = `${width}-${theme}`;
        await resize(width, 1100); await setSettings({ theme, units: theme === 'dark' ? 'metric' : 'imperial' });
        await writeLocal({ bpbSnotelCatalogV1: null }); setMode('loading');
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=${width === 681 ? 'map-first' : 'normal'}`);
        await settleForecast('settled neighboring forecast');
        await focusRefresh(); await pending(); const initial = await geometry();
        assert.deepEqual(initial.overflow, []);
        setMode('complete'); release(); await ready(); stable(initial, await geometry(), `${name}: initial load`);
        const swe = await evaluate(() => {
            const metric = document.querySelectorAll('.bpb-snow-metric')[1];
            return { label: metric.querySelector('.bpb-snow-label').textContent,
                value: metric.querySelector('strong').textContent,
                heading: document.querySelector('#bpb-peak-snow thead th:last-child').textContent };
        });
        assert.equal(swe.label, 'Water equivalent (SWE)', `${name}: SWE must be recognizable beside snow depth`);
        assert.equal(swe.heading, 'SWE', `${name}: daily readings must identify SWE`);
        assert.equal(swe.value, theme === 'dark' ? '312.4 mm' : '12.30 in', `${name}: SWE uses its own measurement and units`);
        const axis = await evaluate(() => {
            const dates = [...document.querySelectorAll('.bpb-snow-details tbody th')].map(node => node.textContent);
            const ticks = [...document.querySelectorAll('.bpb-snow-dates span')];
            const plot = document.querySelector('.bpb-snow-graph').getBoundingClientRect();
            return { dates: [dates[0], dates[4], dates[7]], labels: ticks.map(node => node.textContent),
                readable: ticks.every((node, index) => {
                    const r = node.getBoundingClientRect(), previous = ticks[index - 1]?.getBoundingClientRect();
                    return r.width > 0 && r.left >= plot.left - 1 && r.right <= plot.right + 1 && (!previous || r.left >= previous.right + 4);
                }), title: document.querySelector('.bpb-snow-graph circle title')?.textContent };
        });
        assert.deepEqual(axis.labels, axis.dates, `${name}: horizontal axis identifies observation dates`);
        assert.equal(axis.readable, true, `${name}: date ticks fit without overlap`);
        assert.match(axis.title, new RegExp(`${axis.dates[0]}.*${theme === 'dark' ? 'cm' : 'in'}`));
        const placement = await evaluate(readSnowCardPlacement);
        assert.ok(placement.sameStack && placement.followsWeather,
            `snow must follow weather in the default card stack: ${JSON.stringify(placement)}`);
        await image(`${name}-ready`, true);
        await inspectChart(name);
        await click('#bpb-peak-snow summary'); await focusRefresh();
        const expanded = await geometry();
        setMode('loading'); const count = snowEvidence.length;
        await press(key('Enter')); await pending();
        stable(expanded, await geometry(), `${name}: pending refresh with daily readings open`);
        assert.equal((await geometry()).focus, 'bpb-snow-refresh');
        await press(key('Enter')); await press(key('Space'));
        assert.equal(snowEvidence.length, count + 1, 'busy keyboard activation must not duplicate requests');
        await image(`${name}-pending`);
        setMode('service-error'); release();
        await wait(() => document.querySelector('.bpb-snow-status')?.textContent.includes('Could not load'), 'failed refresh with retained readings');
        stable(expanded, await geometry(), `${name}: failed refresh`);
        assert.equal((await geometry()).focus, 'bpb-snow-refresh');
        await image(`${name}-error`);
        setMode('complete'); await press(key('Enter')); await ready();
        stable(expanded, await geometry(), `${name}: successful keyboard retry`);
        assert.equal((await geometry()).focus, 'bpb-snow-refresh');
        if (width !== 681) {
            // Hold a real transport past its production deadline. A synthetic
            // HTTP error cannot prove timeout classification or retry recovery.
            setMode('loading'); await press(key('Enter')); await pending();
            stable(expanded, await geometry(), `${name}: pending timed request`);
            await waitForCondition(() => evaluate(() => ({
                busy: document.getElementById('bpb-peak-snow').getAttribute('aria-busy'),
                status: document.querySelector('.bpb-snow-status').textContent,
                disabled: document.querySelector('.bpb-snow-refresh').getAttribute('aria-disabled'),
                opacity: getComputedStyle(document.querySelector('.bpb-snow-refresh')).opacity,
            })), { description: `${name}: explicit timeout with usable Refresh`, timeoutMs: 25_000,
                isReady: state => state.busy === 'false' });
            const timeout = await evaluate(() => ({
                status: document.querySelector('.bpb-snow-status').textContent,
                disabled: document.querySelector('.bpb-snow-refresh').getAttribute('aria-disabled'),
                opacity: getComputedStyle(document.querySelector('.bpb-snow-refresh')).opacity,
                depth: document.querySelector('.bpb-snow-metric strong').textContent,
            }));
            assert.match(timeout.status, /request timed out/i);
            assert.match(timeout.status, /Previous readings shown/);
            assert.equal(timeout.disabled, 'false'); assert.equal(timeout.opacity, '1');
            assert.equal(timeout.depth, theme === 'dark' ? '91.4 cm' : '36.0 in');
            stable(expanded, await geometry(), `${name}: timeout`);
            assert.equal((await geometry()).focus, 'bpb-snow-refresh');
            await image(`${name}-timeout`);
            // Release the abandoned response and retry without waiting for a
            // cooldown. Busy Enter/Space must still avoid duplicate requests.
            setMode('complete'); release(); await press(key('Enter')); await ready();
            stable(expanded, await geometry(), `${name}: recovered timeout`);
            cases.push(`${name}-timeout-retry`);
        }
        cases.push(name);
    }

    // Native select keyboard activation must keep its focus through the async
    // switch; placeholders prevent old readings being attributed to the target.
    await evaluate(() => {
        const select = document.getElementById('bpb-peak-snow-station'); select.scrollIntoView({ block: 'center' }); select.focus();
        window.__bpbSnowFormSubmits = 0;
        select.closest('form')?.addEventListener('submit', event => { window.__bpbSnowFormSubmits++; event.preventDefault(); });
    });
    // Native type-ahead selects Bumping Ridge without relying on an OS popup
    // that a headless browser cannot paint or expose through page screenshots.
    setMode('loading'); await press('b'); await pending(); await press(key('Enter'));
    assert.equal(await evaluate(() => window.__bpbSnowFormSubmits), 0, 'station selection must not submit the native Peakbagger form');
    assert.equal(await evaluate(() => document.getElementById('bpb-peak-snow-station').form === null), true);
    assert.equal((await geometry()).selection, '375:WA:SNTL');
    assert.equal(await evaluate(() => document.querySelector('.bpb-snow-metric strong').textContent), '—');
    assert.equal(await evaluate(() => document.activeElement.id), 'bpb-peak-snow-station');
    setMode('complete'); release(); await ready();
    assert.equal((await geometry()).selection, '375:WA:SNTL');
    assert.equal(await evaluate(() => document.activeElement.id), 'bpb-peak-snow-station');
    cases.push('station-keyboard-switch');

    // Begin with a cold page-memory cache so the alternate station cannot
    // bypass the held/error transport through an earlier successful selection.
    setMode('complete'); await navigate(`${origin}/peak.aspx?pid=2296&snow=recovery`);
    await settleForecast('settled forecast before failed station switch');
    await focusRefresh(); await ready();
    await focusRefresh();
    // A failed replacement restores Paradise. Refresh must keep that visible
    // station, rather than silently retrying the failed Bumping Ridge choice.
    const selected = await geometry(); setMode('loading');
    await evaluate(() => {
        const select = document.getElementById('bpb-peak-snow-station');
        select.value = '375:WA:SNTL'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pending(); stable(selected, await geometry(), 'pending replacement');
    setMode('service-error'); release();
    await wait(() => document.querySelector('.bpb-snow-status').textContent.includes('Could not load'), 'failed station replacement');
    assert.equal((await geometry()).selection, '679:WA:SNTL');
    stable(selected, await geometry(), 'restored station');
    await focusRefresh(); const restored = await geometry(), restoredCount = snowEvidence.length;
    setMode('loading'); await press(key('Enter')); await pending();
    assert.equal((await geometry()).selection, '679:WA:SNTL', 'Refresh must keep the station shown before activation');
    assert.equal(new URLSearchParams(snowEvidence[restoredCount].query).get('stationTriplets'), '679:WA:SNTL');
    stable(restored, await geometry(), 'refresh of restored station');
    setMode('complete'); release(); await ready(); stable(restored, await geometry(), 'refreshed restored station');
    cases.push('restored-station-refresh');
    await evaluate(() => {
        const select = document.getElementById('bpb-peak-snow-station');
        select.value = '375:WA:SNTL'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await ready();

    setMode('missing'); await click('.bpb-snow-refresh'); await ready();
    assert.equal(await evaluate(() => document.querySelector('.bpb-snow-metric strong').textContent), '—');
    assert.equal(await evaluate(() => document.querySelector('.bpb-snow-graph p').hidden), false);
    assert.equal(await evaluate(() => document.querySelector('.bpb-snow-graph').tabIndex), -1, 'a chart with no readings is not a dead Tab stop');
    await image('375-missing'); cases.push('missing-sensor');
    setMode('error'); await click('.bpb-snow-refresh');
    await wait(() => document.querySelector('.bpb-snow-status')?.textContent.includes('NRCS request limit'), 'NRCS rate-limit feedback');
    await focusRefresh(); const limited = await geometry(), limitedCount = snowEvidence.length;
    await press(key('Enter')); await press(key('Space')); assert.equal(snowEvidence.length, limitedCount);
    stable(limited, await geometry(), 'rate-limited activation'); await image('375-rate-limit'); cases.push('rate-limit');
    await evaluate(() => document.getElementById('bpb-peak-snow-station').focus({ preventScroll: true }));
    await press('p'); await press(key('Enter'));
    assert.equal((await geometry()).selection, '375:WA:SNTL'); assert.equal(snowEvidence.length, limitedCount);
    assert.equal(await evaluate(() => document.activeElement.id), 'bpb-peak-snow-station');

    await writeLocal({ bpbSnotelCatalogV1: null }); setMode('long-station');
    await navigate(`${origin}/peak.aspx?pid=2296&week-weather=no-map`);
    await settleForecast('settled mapless forecast before snow capture');
    await focusRefresh(); await ready();
    await focusRefresh();
    assert.deepEqual((await geometry()).overflow, []); await image('375-long-station-mapless'); cases.push('long-station-mapless');
    const beforeUnits = snowEvidence.length;
    await setSettings({ theme: 'dark', units: 'imperial' });
    await wait(() => document.querySelector('.bpb-snow-metric strong')?.textContent.includes('in'), 'updated snow units');
    assert.equal(snowEvidence.length, beforeUnits);
    // The native peak page has its own minimum width. Use the desktop viewport
    // for zoom QA so the whole card can be inspected without horizontal panning.
    await resize(1440, 1100);
    const originalRatio = await evaluate(() => window.devicePixelRatio);
    await setZoom(2);
    await waitForCondition(() => evaluate(() => window.devicePixelRatio), { description: '200% browser zoom',
        isReady: ratio => ratio >= originalRatio * 1.9 });
    await focusRefresh();
    await evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    assert.deepEqual((await geometry()).overflow, []);
    await inspectChart('1440-200-percent-zoom', true);
    await focusRefresh();
    // A viewport capture also avoids Chromium element-clip coordinates at zoom.
    if (output && captureRequested()) await screenshotPage(path.join(output, `${browser}-1440-200-percent-zoom.png`));
    const enlarged = await geometry(); setMode('loading');
    await press(key('Enter')); await pending(); stable(enlarged, await geometry(), '200% zoom pending refresh');
    setMode('service-error'); release();
    await wait(() => document.querySelector('.bpb-snow-status')?.textContent.includes('Could not load'), '200% zoom error');
    stable(enlarged, await geometry(), '200% zoom error');
    setMode('loading'); await press(key('Enter')); await pending();
    stable(enlarged, await geometry(), '200% zoom pending timeout');
    await wait(() => document.getElementById('bpb-peak-snow').getAttribute('aria-busy') === 'false'
        && document.querySelector('.bpb-snow-status').textContent.includes('request timed out'), '200% zoom timeout');
    stable(enlarged, await geometry(), '200% zoom timeout');
    assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.bpb-snow-refresh')).opacity), '1');
    assert.equal(await evaluate(() => document.activeElement.className), 'bpb-snow-refresh');
    if (output && captureRequested()) await screenshotPage(path.join(output, `${browser}-1440-200-percent-timeout.png`));
    setMode('complete'); release(); await press(key('Enter')); await ready();
    stable(enlarged, await geometry(), '200% zoom timeout recovery');
    cases.push('200-percent-timeout-retry');
    await setZoom(1);
    await waitForCondition(() => evaluate(() => window.devicePixelRatio), { description: 'restored browser zoom',
        isReady: ratio => ratio <= originalRatio * 1.1 });
    await resize(375, 1100);
    cases.push('200-percent-browser-zoom');

    await writeLocal({ bpbSnotelCatalogV1: null }); setMode('loading');
    await navigate(`${origin}/peak.aspx?pid=2296&week-weather=normal`);
    await settleForecast('settled forecast before coverage result');
    await focusRefresh(); await pending(); const beforeCoverage = await geometry();
    setMode('no-stations'); release();
    await wait(() => document.querySelector('.bpb-snow-status')?.textContent.includes('No SNOTEL'), 'no nearby station');
    assert.equal(await evaluate(() => document.querySelector('.bpb-snow-refresh').getAttribute('aria-disabled')), 'true');
    const empty = await evaluate(() => ({ height: document.getElementById('bpb-peak-snow').getBoundingClientRect().height,
        hiddenReadings: !document.querySelector('.bpb-snow-observations').getClientRects().length,
        hiddenDetails: !document.querySelector('.bpb-snow-details').getClientRects().length }));
    assert.ok(empty.height < 220 && empty.hiddenReadings && empty.hiddenDetails, `empty state must stay compact: ${JSON.stringify(empty)}`);
    const afterCoverage = await geometry();
    for (const name of ['button', 'heading']) for (const dimension of Object.keys(beforeCoverage[name])) {
        assert.ok(Math.abs(beforeCoverage[name][dimension] - afterCoverage[name][dimension]) <= 1, `coverage result must anchor ${name}.${dimension}`);
    }
    assert.ok(Math.abs(beforeCoverage.scroll.y - afterCoverage.scroll.y) <= 1, 'initial compact coverage result must not scroll');
    await image('375-no-stations'); cases.push('no-nearby-stations');
    const beforeDisabled = snowEvidence.length;
    await setSettings({ showWeather: true, showSnotel: false });
    await wait(() => document.getElementById('bpb-peak-snow-row')?.hidden, 'disabled snow card');
    assert.equal(snowEvidence.length, beforeDisabled);
    cases.push('snotel-preference');

    // Assertion infrastructure must fail on a real layout shift, not a setup
    // failure. Remove the status reservation in this disposable page and prove
    // that a wrapped message moves following content and is rejected.
    await setSettings({ showWeather: true, showSnotel: true });
    await wait(() => !document.getElementById('bpb-peak-snow-row')?.hidden, 'restored snow card');
    await focusRefresh(); const reserved = await geometry();
    await evaluate(() => {
        const status = document.querySelector('.bpb-snow-status');
        status.querySelectorAll('[data-sizing-text]').forEach(node => node.remove());
        status.firstElementChild.textContent = 'A long station response failed. '.repeat(12);
    });
    const shifted = await geometry();
    assert.throws(() => stable(reserved, shifted, 'deliberately shifted snow card'), /moved:/);
    cases.push('stability-assertion-negative-control');

    await waitForCondition(() => networkErrors.length === 0, { description: 'no browser transport errors', timeoutMs: 1000 });
    assert.deepEqual(networkErrors, []); assert.ok(cases.length > 0);
    return { verification: 'peak-snow', viewports: [375, 681, 1440], themes: ['light', 'dark'], cases,
        requests: snowEvidence.length, output: output || null, provider: 'intercepted NRCS JSON; no live provider requests' };
}
