// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, Event */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifyPeakWeatherInteractions({ origin, evaluate, navigate, clickPoint, press, resize, setZoom,
    setSettings, wait, setMode, heldCount, release, evidence, networkErrors, firefoxMode, screenshotPage, writeLocal }) {
    const cases = [], output = process.env.BPB_VERIFY_WEATHER_INTERACTIONS_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const key = name => firefoxMode ? { Enter: '\uE007', Space: '\uE00D', ArrowDown: '\uE015', Tab: '\uE004' }[name] : name;
    const focus = selector => evaluate(selector => {
        const node = document.querySelector(selector); node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true });
    }, selector);
    const focused = selector => evaluate(selector => document.activeElement === document.querySelector(selector), selector);
    // Locator.click deliberately waits for aria-disabled to clear. Exercise a
    // real pointer click now, while unavailable, instead of after the timeout.
    const clickRefresh = async () => {
        const point = await evaluate(() => { const r = document.querySelector('.bpb-week-refresh').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await clickPoint(point.x, point.y);
    };
    const ready = () => wait(() => document.querySelectorAll('.bpb-week-day').length === 16
        && document.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false', 'settled weather');
    const geometry = () => evaluate(() => {
        const rect = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
        };
        return { action: rect('.bpb-week-refresh'), heading: rect('#bpb-peak-weather header'),
            panel: rect('#bpb-peak-weather'), following: rect('#bpb-peak-snow'), native: rect('h1'), scroll: window.scrollY };
    });
    const stable = (before, after, label) => {
        for (const [name, value] of Object.entries(before)) {
            if (typeof value === 'object') stable(value, after[name], `${label}.${name}`);
            else assert.ok(Math.abs(value - after[name]) <= 1, `${label}.${name}: ${value} → ${after[name]}`);
        }
    };
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        const label = `${width}-${theme}-zoom${zoom}`;
        console.log(`Weather interaction case: ${label}`);
        // Reset real tab zoom before changing BiDi viewport emulation. Firefox
        // can otherwise stall resizing directly from a zoomed desktop page.
        if (cases.length) await setZoom(1);
        await resize(width, 1100); setMode('complete');
        await writeLocal({ bpbPeakWeatherModelForecast: 'gfs_global', bpbPeakWeatherModelPast: 'gfs_global' });
        await setSettings({ theme, units: 'metric', showWeather: true, showSnotel: true, peakWeatherCollapsed: false });
        await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map-first`);
        await setZoom(zoom);
        await focus('.bpb-week-refresh'); await ready();
        // Settle the following card before comparing reading positions.
        await evaluate(() => document.querySelector('#bpb-peak-snow').scrollIntoView({ block: 'center' }));
        await wait(() => document.querySelector('.bpb-snow-status')?.textContent.includes('Hourly readings'), 'following snow ready');
        await focus('.bpb-week-refresh');
        const before = await geometry(), count = evidence.length;
        setMode('loading'); await press(key('Enter'));
        await waitForCondition(heldCount, { description: 'held weather response', isReady: count => count > 0 });
        assert.equal(await focused('.bpb-week-refresh'), true, `${label}: pending focus`);
        stable(before, await geometry(), `${label}: pending`);
        await press(key('Enter')); await press(key('Space')); await clickRefresh();
        assert.equal(evidence.length, count + 1, 'repeated keyboard and pointer activation does not duplicate work');
        if (output && width === 375 && theme === 'dark') await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${label}-pending.png`));
        setMode('service-error'); release(); await ready();
        await wait(() => document.querySelector('.bpb-week-status').textContent.includes('weather service is unavailable'), 'service failure');
        assert.equal(await focused('.bpb-week-refresh'), true, `${label}: failure focus`);
        stable(before.action, (await geometry()).action, `${label}: failed action`);
        setMode('loading'); await press(key('Space'));
        await waitForCondition(heldCount, { description: 'held retry response', isReady: count => count > 0 });
        assert.equal(await focused('.bpb-week-refresh'), true, `${label}: Space retry focus`);
        // A user may leave the busy action; completion must respect that choice.
        await press(key('Tab'));
        const nextFocus = await evaluate(() => document.activeElement.id || document.activeElement.tagName);
        const moved = await geometry();
        setMode('complete'); release(); await ready();
        assert.equal(await evaluate(() => document.activeElement.id || document.activeElement.tagName), nextFocus);
        const recovered = await geometry();
        stable({ ...before, scroll: recovered.scroll }, recovered, `${label}: recovered`);
        stable(moved.scroll, recovered.scroll, `${label}: completion reading position`);
        await focus('.bpb-week-refresh'); await press(key('Enter')); await ready();
        assert.equal(await focused('.bpb-week-refresh'), true, `${label}: success focus`);
        await focus('#bpb-peak-weather-model'); setMode('error');
        await evaluate(() => { const select = document.querySelector('#bpb-peak-weather-model'); select.value = 'best_match'; select.dispatchEvent(new Event('change')); });
        await wait(() => document.querySelector('.bpb-week-status').dataset.kind === 'rate-limit'
            && document.querySelector('#bpb-peak-weather').getAttribute('aria-busy') === 'false', 'model cooldown');
        assert.equal(await focused('#bpb-peak-weather-model'), true, `${label}: cooldown focus`);
        const limited = evidence.length;
        await press(key('ArrowDown'));
        await evaluate(() => { const select = document.querySelector('#bpb-peak-weather-model'); select.value = 'gfs_global'; select.dispatchEvent(new Event('change')); });
        assert.equal(await evaluate(() => document.querySelector('#bpb-peak-weather-model').value), 'best_match');
        await focus('.bpb-week-refresh'); await press(key('Enter')); await press(key('Space')); await clickRefresh();
        assert.equal(evidence.length, limited, 'cooldown rejects model and Refresh activation');
        assert.equal(await focused('.bpb-week-refresh'), true, `${label}: cooldown Refresh focus`);
        await press(key('Tab')); assert.equal(await focused('.bpb-week-refresh'), false, 'Tab remains usable during cooldown');
        cases.push({ width, theme, zoom, states: ['pending', 'duplicate-input', 'service-error', 'Space-retry', 'focus-moved', 'success', 'model-cooldown'] });
    }
    assert.equal(cases.length, 8, 'the complete interaction matrix executed');
    assert.deepEqual(networkErrors, []);
    return { cases, screenshots: output || null };
}
