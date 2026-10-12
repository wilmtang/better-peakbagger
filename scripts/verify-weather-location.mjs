// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame */
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifyWeatherLocation({ evaluate, click, clickPoint, press, resize, wait, setSettings,
    setMode, release, evidence, screenshotPage, output, firefoxMode }) {
    const measurements = [];
    for (const theme of ['light', 'dark']) {
        await setSettings({ theme, units: 'imperial' });
        await waitForCondition(() => evaluate(() => document.documentElement.getAttribute('data-bpb-theme')).then(value => value === theme), { description: 'weather theme ready' });
        for (const width of [1440, 375]) {
            await resize(width, 1100);
            const pointer = await evaluate(offset => {
                const frame = document.getElementById('Gmap');
                frame.scrollIntoView({ block: 'center', behavior: 'instant' });
                const rect = frame.getBoundingClientRect();
                // Stay clear of the native zoom and overlaid 3D toggle.
                return { x: rect.right - 90 - offset, y: rect.bottom - 150 };
            }, measurements.length * 8);
            const before = evidence.length;
            await evaluate(() => {
                window.__bpbMenuMessages = [];
                window.__bpbMenuListener = event => { if (event.data?.__bpbPeakWeather) window.__bpbMenuMessages.push(event.data); };
                window.addEventListener('message', window.__bpbMenuListener);
            });
            await clickPoint(pointer.x, pointer.y, 'right');
            try { await wait(() => !document.getElementById('bpb-peak-weather-menu').hidden, 'native map weather context menu'); }
            catch (error) {
                const state = await evaluate(() => ({ messages: window.__bpbMenuMessages, mounted: !!document.querySelector('#bpb-map-viewport'),
                    hidden: document.getElementById('bpb-peak-weather').hidden,
                    projection: typeof document.getElementById('Gmap').contentWindow.mapsPlaceholder?.mouseEventToLatLng,
                    frame: document.getElementById('Gmap').getBoundingClientRect().toJSON() }));
                throw new Error(`${error.message}: ${JSON.stringify(state)}`);
            }
            assert.equal(evidence.length, before, 'opening a map menu sends no weather request');
            const menu = await evaluate(() => {
                const menu = document.getElementById('bpb-peak-weather-menu'), rect = menu.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                    width: window.innerWidth, height: window.innerHeight, focused: document.activeElement === menu.querySelector('button') };
            });
            assert.ok(menu.left >= 7 && menu.right <= menu.width - 7 && menu.top >= 7 && menu.bottom <= menu.height - 7, JSON.stringify(menu));
            assert.equal(menu.focused, true);
            if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-location-menu-${theme}-${width}.png`));
            await press(firefoxMode ? '\uE00C' : 'Escape');
            assert.equal(await evaluate(() => document.getElementById('bpb-peak-weather-menu').hidden), true);
            await clickPoint(pointer.x, pointer.y, 'right');
            await wait(() => !document.getElementById('bpb-peak-weather-menu').hidden, 'reopened weather menu');
            setMode('loading');
            const original = await evaluate(() => {
                const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top + window.scrollY, height: r.height }; };
                window.__bpbLocationTrace = { stopped: false, frames: [] };
                const trace = window.__bpbLocationTrace;
                const collect = () => {
                    if (trace.stopped) return;
                    trace.frames.push({ scroll: window.scrollY, days: rect(document.querySelector('.bpb-week-days')).top });
                    requestAnimationFrame(collect);
                };
                requestAnimationFrame(collect);
                return { scroll: window.scrollY, days: rect(document.querySelector('.bpb-week-days')).top, card: rect(document.getElementById('bpb-peak-weather')) };
            });
            await click('#bpb-peak-weather-menu button');
            await wait(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'true', 'selected-location loading state');
            assert.equal(await evaluate(() => document.querySelector('.bpb-week-location-name').textContent), 'At the summit');
            assert.ok(await evaluate(() => document.querySelector('.bpb-week-status').textContent.startsWith('Loading ')));
            setMode('complete'); release();
            await wait(() => document.getElementById('bpb-peak-weather').getAttribute('aria-busy') === 'false'
                && document.querySelector('.bpb-week-location-name').textContent !== 'At the summit', 'selected location replaces summit weather');
            const trace = await evaluate(async () => {
                for (let frame = 0; frame < 5; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
                window.__bpbLocationTrace.stopped = true;
                const frames = window.__bpbLocationTrace.frames; delete window.__bpbLocationTrace; return frames;
            });
            assert.ok(trace.every(frame => Math.abs(frame.scroll - original.scroll) <= 1 && Math.abs(frame.days - original.days) <= 1), `location load shifted the page: ${JSON.stringify({ original, trace })}`);
            const selected = await evaluate(() => ({ label: document.querySelector('.bpb-week-location-name').textContent,
                elevation: document.querySelector('.bpb-week-models').textContent, enabled: !document.querySelector('.bpb-week-location-reset').disabled }));
            assert.match(selected.label, /^46\.\d{4}, -121\.\d{4}$/); assert.equal(selected.enabled, true);
            assert.ok(selected.elevation.includes('Terrain elevation'));
            await evaluate(() => document.getElementById('bpb-peak-weather').scrollIntoView({ block: 'start', behavior: 'instant' }));
            if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-peak-selected-location-${theme}-${width}.png`));
            const selectedRequests = evidence.length;
            await click('.bpb-week-location-reset');
            await wait(() => document.querySelector('.bpb-week-location-name').textContent === 'At the summit', 'reset restores summit result');
            assert.equal(evidence.length, selectedRequests, 'reset immediately reuses the summit response');
            await evaluate(() => {
                window.removeEventListener('message', window.__bpbMenuListener);
                delete window.__bpbMenuListener; delete window.__bpbMenuMessages;
            });
            measurements.push({ theme, width, stableFrames: trace.length, menuFits: true });
        }
    }
    await setSettings({ theme: 'light', units: 'imperial' });
    return measurements;
}
