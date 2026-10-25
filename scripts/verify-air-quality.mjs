// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
export async function verifyAirQuality({ origin, evaluate, navigate, click, press, resize, setZoom, setSettings, wait, setMode, release, evidence, networkErrors, screenshotPage, firefoxMode }) {
    const output = process.env.BPB_VERIFY_AQI_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const count = () => evidence.filter(request => request.host === 'air-quality-api.open-meteo.com').length;
    await setSettings({ showWeather: true, theme: 'light' });
    await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map`);
    await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start' }));
    await wait(() => document.querySelectorAll('.bpb-week-day').length === 16, 'weather ready before AQI activation');
    assert.equal(count(), 0, 'weather startup must not prefetch AQI');
    await click('[data-period="past"]'); assert.equal(count(), 0);
    await evaluate(() => document.querySelector('[data-period="past"]').focus());
    await press(firefoxMode ? '\uE014' : 'ArrowRight');
    await wait(() => document.querySelectorAll('.bpb-air-table tbody tr').length > 0, 'keyboard-selected AQI forecast');
    assert.equal(count(), 1);
    const geometry = () => evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x + window.scrollX, r.y + window.scrollY, r.width, r.height]; };
        return { refresh: rect('[aria-label="Refresh air quality"]'), tabs: rect('.bpb-week-periods'), panel: rect('#bpb-peak-weather-air'),
            footer: rect('#bpb-peak-weather footer'), scroll: window.scrollY,
            overflow: document.querySelector('#bpb-peak-weather-air').scrollWidth > document.querySelector('#bpb-peak-weather-air').clientWidth + 1 };
    });
    const stable = (before, after) => {
        assert.equal(after.overflow, false);
        for (const key of ['refresh', 'tabs', 'panel', 'footer']) before[key].forEach((value, index) => assert.ok(Math.abs(value - after[key][index]) <= 1, `${key} shifted: ${JSON.stringify({ before, after })}`));
        assert.ok(Math.abs(before.scroll - after.scroll) <= 1, `reading position moved during refresh: ${JSON.stringify({ before, after })}`);
    };
    const cases = [];
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        await setZoom(1); await resize(width, 1100); await setSettings({ theme }); await setZoom(zoom);
        await wait(() => {
            const button = document.querySelector('[aria-label="Refresh air quality"]');
            button.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = button.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
        }, 'AQI action visible after viewport and zoom changes');
        await wait(() => {
            const button = document.querySelector('[aria-label="Refresh air quality"]'), r = button.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) { button.scrollIntoView({ block: 'center', behavior: 'instant' }); window.__bpbAQIViewport = null; return false; }
            const signature = JSON.stringify([r.x, r.y, r.width, r.height, window.scrollY, window.innerWidth]);
            const previous = window.__bpbAQIViewport;
            window.__bpbAQIViewport = { signature, count: previous?.signature === signature ? previous.count + 1 : 0 };
            return window.__bpbAQIViewport.count >= 2;
        }, 'settled AQI viewport after resize/zoom');
        await evaluate(() => { delete window.__bpbAQIViewport; });
        const before = await geometry(); assert.equal(before.overflow, false);
        setMode('loading'); await click('[aria-label="Refresh air quality"]');
        await wait(() => document.querySelector('#bpb-peak-weather-air').getAttribute('aria-busy') === 'true', 'AQI pending');
        stable(before, await geometry());
        const pendingCount = count();
        await evaluate(() => document.querySelector('[aria-label="Refresh air quality"]').click());
        assert.equal(count(), pendingCount, 'busy action rejects duplicate activation');
        setMode('complete'); release();
        await wait(() => document.querySelector('#bpb-peak-weather-air').getAttribute('aria-busy') === 'false', 'AQI completed');
        stable(before, await geometry());
        setMode('service-error'); await click('[aria-label="Refresh air quality"]');
        await wait(() => document.querySelector('#bpb-peak-weather-air [role="status"]').textContent.includes('Refresh failed'), 'AQI failed refresh retains forecast');
        stable(before, await geometry());
        setMode('complete'); await evaluate(() => document.querySelector('[aria-label="Refresh air quality"]').focus());
        await press(firefoxMode ? '\uE007' : 'Enter');
        await wait(() => document.querySelector('#bpb-peak-weather-air').getAttribute('aria-busy') === 'false'
            && !document.querySelector('#bpb-peak-weather-air [role="status"]').textContent.includes('failed'), 'keyboard retry');
        stable(before, await geometry());
        if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-aqi-${width}-${theme}-${zoom}.png`));
        cases.push({ width, theme, zoom, states: ['ready', 'pending', 'success', 'error', 'keyboard-retry'] });
    }
    const loaded = count(); await click('[data-period="forecast"]'); await click('[data-period="aqi"]'); assert.equal(count(), loaded, 'returning tab reuses memory');
    assert.equal(cases.length, 8); assert.deepEqual(networkErrors, []);
    return { cases, requests: count(), screenshots: output || null };
}
