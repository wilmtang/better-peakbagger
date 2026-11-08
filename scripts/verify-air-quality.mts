// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitWeatherCondition as waitForCondition } from './weather-verification-types.mts';
import type { WeatherControls, WeatherFixtureElement } from './weather-verification-types.mts';
import { verifyWeatherConditions } from './verify-weather-day-switches.mts';
declare global { interface Window { __bpbAQIViewport?: { signature: string; count: number } | null; __bpbConditionsViewport?: { signature: string; count: number } } }
interface AirQualityControls extends WeatherControls {
    origin: string; navigate: (url: string) => Promise<unknown>; setZoom: (zoom: number) => Promise<unknown>;
    wait: (fn: () => unknown, description: string) => Promise<unknown>; setMode: (mode: string) => void; release: () => void;
    evidence: { host: string }[]; networkErrors: string[];
}
import { mkdir } from 'node:fs/promises';
export async function verifyAirQuality({ origin, evaluate, navigate, click, press, resize, setZoom, setSettings, wait, setMode, release, evidence, networkErrors, screenshotPage, firefoxMode }: AirQualityControls) {
    const output = process.env.BPB_VERIFY_AQI_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const count = () => evidence.filter(request => request.host === 'air-quality-api.open-meteo.com').length;
    await setSettings({ showWeather: true, showSummitCloud: false, theme: 'light' });
    await navigate(`${origin}/peak.aspx?pid=2296&week-weather=map`);
    await evaluate(() => document.getElementById('bpb-peak-weather')!.scrollIntoView({ block: 'start' }));
    await wait(() => document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day').length === 16, 'weather ready before AQI activation');
    assert.equal(count(), 0, 'weather startup must not prefetch AQI');
    await click('.bpb-week-day:first-child > summary');
    const conditionCases = [];
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        await setZoom(1); await resize(width, 1100); await setSettings({ theme }); await setZoom(zoom);
        await wait(() => document.querySelector<WeatherFixtureElement>('.bpb-week-conditions:not([hidden])'), 'compact Conditions shown');
        await wait(() => {
            const scroll = document.querySelector<HTMLElement>('.bpb-week-conditions')!;
            const label = scroll.querySelector<HTMLElement>('tbody th')!;
            const signature = JSON.stringify([window.innerWidth, scroll.clientWidth, scroll.getBoundingClientRect().width, label.getBoundingClientRect().width, scroll.getBoundingClientRect().height]);
            const previous = window.__bpbConditionsViewport;
            window.__bpbConditionsViewport = { signature, count: previous?.signature === signature ? previous.count + 1 : 0 };
            return window.__bpbConditionsViewport.count >= 2;
        }, 'settled compact Conditions geometry after zoom/theme changes');
        await evaluate(() => { delete window.__bpbConditionsViewport; });
        await verifyWeatherConditions(evaluate);
        const strip = await evaluate(() => {
            const scroll = document.querySelector<WeatherFixtureElement>('.bpb-week-conditions')!;
            const table = scroll.querySelector<HTMLTableElement>('.bpb-weather-strip')!;
            const label = table.querySelector<WeatherFixtureElement>('tbody th')!;
            const value = table.querySelector<WeatherFixtureElement>('tbody td')!;
            return { height: scroll.getBoundingClientRect().height, hourWidth: value.getBoundingClientRect().width, viewportWidth: scroll.getBoundingClientRect().width, labelWidth: label.getBoundingClientRect().width,
                valueWindow: scroll.clientWidth - label.getBoundingClientRect().width,
                rows: table.tBodies[0].rows.length, rowKeys: [...table.tBodies[0].rows].map(row => row.getAttribute('data-weather-row')), border: getComputedStyle(value).borderRightWidth,
                wind: table.querySelector<WeatherFixtureElement>('[data-weather-row="wind"] td')!.style.getPropertyValue('--weather-strip-wind') };
        });
        assert.equal(strip.rows, 9, JSON.stringify(strip)); assert.ok(strip.hourWidth <= 44, JSON.stringify(strip));
        if (zoom === 1) assert.ok(strip.height < 300, `Conditions strip is not compact: ${JSON.stringify(strip)}`);
        assert.ok(strip.valueWindow >= strip.hourWidth - 1, `pinned labels cover the hourly values: ${JSON.stringify(strip)}`);
        assert.equal(strip.border, '0px'); assert.match(strip.wind, /^rgb\(/);
        if (output) {
            await evaluate(() => document.querySelector('.bpb-week-conditions')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
            await wait(() => Math.abs(document.querySelector('.bpb-week-conditions')!.getBoundingClientRect().top) <= 1, 'Conditions strip visible for screenshot');
            await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-conditions-${width}-${theme}-${zoom}.png`));
        }
        conditionCases.push({ width, theme, zoom, ...strip });
    }
    assert.equal(conditionCases.length, 8);
    await setZoom(1); await resize(1440, 1100); await setSettings({ theme: 'light' });
    await click('.bpb-week-day:first-child > summary');
    await click('[data-period="past"]'); assert.equal(count(), 0);
    await evaluate(() => document.querySelector<WeatherFixtureElement>('[data-period="past"]')!.focus());
    await press(firefoxMode ? '\uE014' : 'ArrowRight');
    await wait(() => document.querySelectorAll<WeatherFixtureElement>('.bpb-air-table tbody tr').length > 0, 'keyboard-selected AQI forecast');
    assert.equal(count(), 1);
    const shape = await evaluate(() => {
        const table = document.querySelector<HTMLTableElement>('.bpb-air-table')!;
        return { rows: table.tBodies[0].rows.length, hours: table.tHead!.rows[1].cells.length - 1,
            values: [...table.tBodies[0].rows].map(row => row.cells.length - 1), scale: document.querySelectorAll('.bpb-air-scale li').length };
    });
    assert.equal(shape.rows, 2); assert.ok(shape.hours > 0); assert.deepEqual(shape.values, [shape.hours, shape.hours]); assert.equal(shape.scale, 6);
    const geometry = () => evaluate(() => {
        const rect = (selector: string) => { const r = document.querySelector<WeatherFixtureElement>(selector)!.getBoundingClientRect(); return [r.x + window.scrollX, r.y + window.scrollY, r.width, r.height]; };
        return { refresh: rect('[aria-label="Refresh air quality"]'), tabs: rect('.bpb-week-periods'), panel: rect('#bpb-peak-weather-air'),
            footer: rect('#bpb-peak-weather footer'), scroll: window.scrollY,
            overflow: document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air')!.scrollWidth > document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air')!.clientWidth + 1 };
    });
    const stable = (before: Awaited<ReturnType<typeof geometry>>, after: Awaited<ReturnType<typeof geometry>>) => {
        assert.equal(after.overflow, false);
        for (const key of ['refresh', 'tabs', 'panel', 'footer'] as const) before[key].forEach((value, index) => assert.ok(Math.abs(value - after[key][index]) <= 1, `${key} shifted: ${JSON.stringify({ before, after })}`));
        assert.ok(Math.abs(before.scroll - after.scroll) <= 1, `reading position moved during refresh: ${JSON.stringify({ before, after })}`);
    };
    const cases = [];
    for (const width of [1440, 375]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        await setZoom(1); await resize(width, 1100); await setSettings({ theme, showSummitCloud: false }); await setZoom(zoom);
        await wait(() => {
            const button = document.querySelector<WeatherFixtureElement>('[aria-label="Refresh air quality"]');
            button!.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = button!.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
        }, 'AQI action visible after viewport and zoom changes');
        await wait(() => {
            const button = document.querySelector<WeatherFixtureElement>('[aria-label="Refresh air quality"]'), r = button!.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) { button!.scrollIntoView({ block: 'center', behavior: 'instant' }); window.__bpbAQIViewport = null; return false; }
            const signature = JSON.stringify([r.x, r.y, r.width, r.height, window.scrollY, window.innerWidth]);
            const previous = window.__bpbAQIViewport;
            window.__bpbAQIViewport = { signature, count: previous?.signature === signature ? previous.count + 1 : 0 };
            return window.__bpbAQIViewport.count >= 2;
        }, 'settled AQI viewport after resize/zoom');
        await evaluate(() => { delete window.__bpbAQIViewport; });
        const bandStyles = await evaluate(() => {
            const table = document.querySelector<HTMLTableElement>('.bpb-air-table')!;
            const neutral = getComputedStyle(table.querySelector('[data-air-row="pm"] td')!).backgroundColor;
            const cells = new Map([...table.querySelectorAll<HTMLElement>('td[data-band]')].map(cell => [cell.dataset.band, cell]));
            return [...cells].map(([band, cell]) => ({ band, background: getComputedStyle(cell).backgroundColor, color: getComputedStyle(cell).color, neutral,
                swatch: getComputedStyle(document.querySelector(`.bpb-air-swatch[data-band="${band}"]`)!).backgroundColor }));
        });
        assert.ok(bandStyles.length > 0);
        assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.bpb-air-days th[scope="colgroup"]')!).textAlign), 'left', 'day groups retain visible leading date labels');
        // The current UTC hour may remove an entire early band from the
        // forecast. Check all six legend colors as well as every present band.
        const palette = await evaluate(() => [...document.querySelectorAll<HTMLElement>('.bpb-air-swatch')].map(cell => ({
            band: cell.dataset.band, background: getComputedStyle(cell).backgroundColor, color: getComputedStyle(cell).color,
        })));
        assert.deepEqual(palette.map(band => band.band), ['0', '1', '2', '3', '4', '5']);
        const luminance = (color: string) => {
            const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        for (const band of bandStyles) {
            assert.equal(band.background, band.swatch, `AQI band does not match its legend: ${JSON.stringify(band)}`);
            assert.notEqual(band.background, band.neutral, 'AQI bands must remain distinct from neutral PM cells');
            assert.equal(band.color, palette.find(item => item.band === band.band)!.color);
        }
        for (const band of [...bandStyles, ...palette]) {
            const a = luminance(band.background), b = luminance(band.color);
            assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `AQI text contrast below 4.5:1: ${JSON.stringify(band)}`);
        }
        await evaluate(() => {
            const list = document.querySelector<HTMLElement>('.bpb-air-hours')!;
            list.scrollIntoView({ block: 'center', behavior: 'instant' }); list.focus({ preventScroll: true });
        });
        const inspectionBefore = await geometry(); assert.equal(inspectionBefore.overflow, false);
        await press(firefoxMode ? '\uE010' : 'End');
        await wait(() => {
            const row = document.querySelector<HTMLTableElement>('.bpb-air-table')!.tHead!.rows[1];
            return row.cells[row.cells.length - 1].getAttribute('aria-current') === 'time';
        }, 'keyboard selects the last AQI hour');
        stable(inspectionBefore, await geometry());
        const inspectionCount = count();
        await evaluate(() => document.querySelector<HTMLElement>('.bpb-air-table td[data-band="2"]')!.click());
        await wait(() => document.querySelector('.bpb-air-summary')!.textContent!.includes('Unhealthy for sensitive groups'), 'long AQI category visible');
        stable(inspectionBefore, await geometry()); assert.equal(count(), inspectionCount, 'hour inspection stays local');
        await press(firefoxMode ? '\uE011' : 'Home');
        await wait(() => document.querySelector<HTMLTableElement>('.bpb-air-table')!.tHead!.rows[1].cells[1].getAttribute('aria-current') === 'time', 'keyboard returns to first AQI hour');
        stable(inspectionBefore, await geometry());
        // Moving focus between controls may intentionally reveal an offscreen
        // target at 200% zoom. Compare each interaction from its visible target.
        await evaluate(() => {
            const button = document.querySelector<HTMLElement>('[aria-label="Refresh air quality"]')!;
            button.scrollIntoView({ block: 'center', behavior: 'instant' }); button.focus({ preventScroll: true });
        });
        await wait(() => {
            const r = document.querySelector('[aria-label="Refresh air quality"]')!.getBoundingClientRect();
            const signature = JSON.stringify([r.x, r.y, r.width, r.height, window.scrollY]);
            const previous = window.__bpbAQIViewport;
            window.__bpbAQIViewport = { signature, count: previous?.signature === signature ? previous.count + 1 : 0 };
            return window.__bpbAQIViewport.count >= 2;
        }, 'settled visible AQI action after inspection');
        await evaluate(() => { delete window.__bpbAQIViewport; });
        const before = await geometry();
        setMode('loading'); await click('[aria-label="Refresh air quality"]');
        await wait(() => document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air')!.getAttribute('aria-busy') === 'true', 'AQI pending');
        stable(before, await geometry());
        assert.equal(await evaluate(() => document.activeElement === document.querySelector('[aria-label="Refresh air quality"]')), true, 'busy action retains focus');
        const pendingCount = count();
        await evaluate(() => document.querySelector<WeatherFixtureElement>('[aria-label="Refresh air quality"]')!.click());
        assert.equal(count(), pendingCount, 'busy action rejects duplicate activation');
        setMode('complete'); release();
        await wait(() => document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air')!.getAttribute('aria-busy') === 'false', 'AQI completed');
        stable(before, await geometry());
        setMode('service-error'); await click('[aria-label="Refresh air quality"]');
        await wait(() => document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air [role="status"]')!.textContent.includes('Refresh failed'), 'AQI failed refresh retains forecast');
        stable(before, await geometry());
        setMode('complete'); await evaluate(() => document.querySelector<WeatherFixtureElement>('[aria-label="Refresh air quality"]')!.focus());
        await press(firefoxMode ? '\uE007' : 'Enter');
        await wait(() => document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air')!.getAttribute('aria-busy') === 'false'
            && !document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air [role="status"]')!.textContent.includes('failed'), 'keyboard retry');
        stable(before, await geometry());
        if (output) {
            const name = `${firefoxMode ? 'firefox' : 'chrome'}-aqi-${width}-${theme}-${zoom}`;
            await screenshotPage(path.join(output, `${name}.png`));
            await evaluate(() => document.querySelector('.bpb-air-hours')!.scrollIntoView({ block: 'center', behavior: 'instant' }));
            await wait(() => { const r = document.querySelector('.bpb-air-hours')!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, 'AQI strip visible for screenshot');
            await screenshotPage(path.join(output, `${name}-strip.png`));
        }
        cases.push({ width, theme, zoom, states: ['ready', 'keyboard-inspection', 'long-category', 'pending', 'success', 'error', 'keyboard-retry'] });
    }
    const loaded = count(); await click('[data-period="forecast"]'); await click('[data-period="aqi"]'); assert.equal(count(), loaded, 'returning tab reuses memory');
    setMode('aqi-weather-error');
    await evaluate(() => window.postMessage({ __bpbPeakWeather: true, type: 'select', latitude: 46.8, longitude: -121.7, x: 100, y: 100 }, window.location.origin));
    await waitForCondition(() => evaluate(() => ({
        weatherBusy: document.querySelector<WeatherFixtureElement>('#bpb-peak-weather')!.getAttribute('aria-busy'),
        status: document.querySelector<WeatherFixtureElement>('.bpb-week-status')!.textContent,
        aqiBusy: document.querySelector<WeatherFixtureElement>('#bpb-peak-weather-air')!.getAttribute('aria-busy'),
        location: document.querySelector<WeatherFixtureElement>('.bpb-week-location-name')!.textContent,
    })), { description: 'independent AQI success with failed location weather', timeoutMs: 20000,
        isReady: state => state.weatherBusy === 'false' && state.status.includes('Could not load') && state.aqiBusy === 'false' });
    assert.equal(await evaluate(() => document.querySelector<WeatherFixtureElement>('.bpb-week-location-name')!.textContent), '46.8000, -121.7000');
    await click('[data-period="forecast"]');
    assert.equal(await evaluate(() => document.querySelector<WeatherFixtureElement>('.bpb-week-location-name')!.textContent), 'At the summit');
    await click('[data-period="aqi"]');
    assert.equal(await evaluate(() => document.querySelector<WeatherFixtureElement>('.bpb-week-location-name')!.textContent), '46.8000, -121.7000');
    assert.equal(cases.length, 8); assert.deepEqual(networkErrors, []);
    return { conditionCases, cases, requests: count(), screenshots: output || null };
}
