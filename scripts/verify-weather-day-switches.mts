// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame */
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitWeatherCondition as waitForCondition } from './weather-verification-types.mts';
import type { WeatherControls, WeatherEvaluate, WeatherFixtureElement } from './weather-verification-types.mts';
interface Bounds { top: number; left: number; width: number; height: number }
interface Measurement extends Bounds { scroll: number; context: Bounds[] }
declare global { interface Window { __bpbWeatherSwitch?: { records: (Measurement & { open: number; empty: boolean })[]; stopped: boolean; active: boolean; measure: () => Measurement } } }


export async function verifyWeatherDaySwitches({ evaluate, click, press, resize, setSettings, screenshotPage, output, firefoxMode }: WeatherControls & { output?: string }) {
    const measurements = [];
    await evaluate(() => {
        const style = document.createElement('style'); style.id = 'bpb-weather-disclosure-text'; document.head.append(style);
    });
    try {
        for (const theme of ['light', 'dark']) for (const textScale of [1, 2]) {
            await setSettings({ theme, units: 'imperial' });
            await waitForCondition(() => evaluate(() => document.documentElement.dataset.bpbTheme === 'dark'), {
                description: `disclosure theme ${theme}`, isReady: dark => dark === (theme === 'dark'),
            });
            await evaluate(scale => {
                document.getElementById('bpb-weather-disclosure-text')!.textContent = scale === 2
                    ? '#bpb-peak-weather .bpb-week-day > summary, #bpb-peak-weather .bpb-week-day > summary * {font-size:26px !important}' : '';
            }, textScale);
            for (const period of ['forecast', 'past']) {
                await click(`#bpb-peak-weather [data-period="${period}"]`);
                for (const width of [1440, 768, 375]) {
                    await resize(width, 1000);
                    for (const metric of ['code', 'temperature', 'precipitation']) {
                        await evaluate(() => document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day').forEach(day => { day.open = false; }));
                        await click('.bpb-week-day:first-child > summary');
                        await click(`.bpb-week-day[open] [data-metric="${metric}"]`);
                        await click('.bpb-week-day:nth-child(2) > summary');
                        await click(`.bpb-week-day:nth-child(2) [data-metric="${metric}"]`);
                        await click('.bpb-week-day:nth-child(2) > summary');
                        for (const [index, activation, expectedOpen] of [[1, 'pointer', 2], [0, 'Enter', 1], [0, 'Space', 2]] as const) {
                            const before = await evaluate(targetIndex => {
                                const target = document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day > summary')[targetIndex];
                                target.scrollIntoView({ block: 'center', behavior: 'instant' }); target.focus({ preventScroll: true });
                                const context = [document.querySelector<WeatherFixtureElement>('.bpb-sun-calculator'), document.querySelector<WeatherFixtureElement>('#bpb-peak-weather header'),
                                    document.querySelector<WeatherFixtureElement>('.bpb-week-overview'), ...[...document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day')].slice(0, targetIndex)]
                                    .filter((node): node is WeatherFixtureElement => node !== null);
                                const bounds = (node: Element) => {
                                    const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height };
                                };
                                const measure = () => ({ ...bounds(target), scroll: window.scrollY, context: context.map(bounds) });
                                window.__bpbWeatherSwitch = { records: [], stopped: false, active: false, measure };
                                const trace = window.__bpbWeatherSwitch!;
                                target.addEventListener('click', () => { trace.active = true; }, { capture: true, once: true });
                                const collect = () => {
                                    if (trace.stopped) return;
                                    const open = [...document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day[open]')];
                                    if (trace.active) trace.records.push({ ...measure(), open: open.length,
                                        empty: open.some(day => !day.querySelector<WeatherFixtureElement>('[role="tabpanel"]')) });
                                    requestAnimationFrame(collect);
                                };
                                requestAnimationFrame(collect);
                                return measure();
                            }, index);
                            const label = `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-${period}-${textScale}x-${width}-${metric}-${activation}`;
                            if (output && metric === 'code' && activation === 'pointer') await screenshotPage(path.join(output, `${label}-before.png`));
                            if (activation === 'pointer') await click(`.bpb-week-day:nth-child(${index + 1}) > summary`);
                            else await press(activation === 'Space' ? (firefoxMode ? '\uE00D' : 'Space') : (firefoxMode ? '\uE007' : 'Enter'));
                            const result = await evaluate(async ({ index: targetIndex, expectedOpen: expectedCount }) => {
                                const target = document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day > summary')[targetIndex];
                                let previous: number | undefined, stable = 0;
                                for (let frame = 0; frame < 120; frame++) {
                                    await new Promise<number>(resolve => requestAnimationFrame(resolve));
                                    const top = target.getBoundingClientRect().top;
                                    stable = document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day[open]').length === expectedCount && top === previous ? stable + 1 : 0; previous = top;
                                    if (stable >= 5) break;
                                }
                                const trace = window.__bpbWeatherSwitch!; trace.stopped = true;
                                const snapshot = { ...trace.measure(), records: trace.records,
                                    bottom: target.parentElement!.getBoundingClientRect().bottom,
                                    panelHeight: target.parentElement!.getBoundingClientRect().height, viewport: window.innerHeight,
                                    focused: document.activeElement === target, stable };
                                delete window.__bpbWeatherSwitch; return snapshot;
                            }, { index, expectedOpen });
                            if (output && metric === 'code' && activation === 'pointer') await screenshotPage(path.join(output, `${label}-after.png`));
                            assert.ok(result.stable >= 5, `day did not settle: ${JSON.stringify(result)}`);
                            assert.ok(result.records.length > 0, 'activation must be observed in rendered frames');
                            assert.ok(result.records.every(frame => frame.open === expectedOpen && !frame.empty), `intermediate disclosure state: ${JSON.stringify(result)}`);
                            for (const frame of [...result.records, result]) {
                                for (const key of ['top', 'left', 'width', 'height'] as const) assert.ok(Math.abs(frame[key] - before[key]) <= 1,
                                    `clicked day ${key} changed: ${label}: ${before[key]} -> ${frame[key]}`);
                                assert.ok(Math.abs(frame.scroll - before.scroll) <= 1, `page scroll changed: ${label}: ${before.scroll} -> ${frame.scroll}`);
                                frame.context.forEach((bounds, contextIndex) => {
                                    for (const key of ['top', 'left', 'width', 'height'] as const) assert.ok(Math.abs(bounds[key] - before.context[contextIndex][key]) <= 1,
                                        `context ${contextIndex} ${key} changed: ${label}: ${JSON.stringify({ before, frame })}`);
                                });
                            }
                            assert.equal(result.focused, true);
                            measurements.push({ theme, period, textScale, width, metric, activation, displacement: result.top - before.top, scroll: result.scroll - before.scroll });
                        }
                        // Opening near either viewport edge keeps the heading in place;
                        // users scroll into the hourly panel at their own pace.
                        for (const placement of ['bottom', 'top']) {
                            await evaluate(() => document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day').forEach(day => { day.open = false; }));
                            const before = await evaluate(position => {
                                const target = document.querySelector<WeatherFixtureElement>('.bpb-week-day > summary'), bounds = target!.getBoundingClientRect();
                                const desired = position === 'top' ? 72 : window.innerHeight - bounds.height - 16;
                                window.scrollBy({ top: bounds.top - desired, behavior: 'instant' });
                                return target!.getBoundingClientRect().top;
                            }, placement);
                            await click('.bpb-week-day:first-child > summary');
                            const state = await evaluate(async () => {
                                const detail = document.querySelector<WeatherFixtureElement>('.bpb-week-day[open]');
                                let previous: number | undefined, stable = 0, bounds: DOMRect | undefined;
                                for (let frame = 0; frame < 120 && stable < 5; frame++) {
                                    await new Promise<number>(resolve => requestAnimationFrame(resolve));
                                    bounds = detail!.getBoundingClientRect(); stable = bounds.top === previous ? stable + 1 : 0; previous = bounds.top;
                                }
                                return { top: bounds!.top, bottom: bounds!.bottom, height: bounds!.height, viewport: window.innerHeight, stable };
                            });
                            assert.ok(state.stable >= 5, `panel did not settle: ${JSON.stringify(state)}`);
                            assert.ok(Math.abs(state.top - before) <= 1, `visible panel moved unnecessarily: ${JSON.stringify(state)}`);
                        }
                    }
                }
            }
        }
    } finally {
        await evaluate(() => {
            document.getElementById('bpb-weather-disclosure-text')?.remove();
            if (window.__bpbWeatherSwitch) window.__bpbWeatherSwitch.stopped = true;
            delete window.__bpbWeatherSwitch;
            document.querySelectorAll<WeatherFixtureElement>('.bpb-week-day').forEach(day => { day.open = false; });
        });
    }
    return measurements;
}

export async function verifyWeatherConditions(evaluate: WeatherEvaluate) {
    const state = await evaluate(() => {
        const grid = document.querySelector<WeatherFixtureElement>('.bpb-week-day[open] .bpb-week-conditions');
        const pageWidth = document.documentElement.scrollWidth;
        const label = grid!.querySelector<WeatherFixtureElement>('.bpb-weather-hourly-table > tbody > tr > th'), before = label!.getBoundingClientRect().left;
        grid!.scrollLeft = 600;
        const result = { pageWidth, afterWidth: document.documentElement.scrollWidth, scroll: grid!.scrollLeft,
            labelDisplacement: label!.getBoundingClientRect().left - before, height: grid!.clientHeight, scrollHeight: grid!.scrollHeight,
            rowLabels: [...grid!.querySelectorAll<WeatherFixtureElement>('.bpb-weather-hourly-table > tbody > tr')].map(node => node.getAttribute('data-weather-row')),
            hours: grid!.querySelectorAll<WeatherFixtureElement>('.bpb-weather-conditions-hour').length };
        grid!.scrollLeft = 0; return result;
    });
    assert.ok(state.scroll > 0, `hourly grid did not scroll: ${JSON.stringify(state)}`);
    assert.ok(Math.abs(state.labelDisplacement) <= 1, `row label scrolled away: ${JSON.stringify(state)}`);
    assert.equal(state.afterWidth, state.pageWidth, 'scrolling hourly columns widened the page');
    assert.ok(state.scrollHeight <= state.height + 1, 'Conditions needs vertical scrolling');
    assert.equal(state.hours, 24);
    assert.deepEqual(state.rowLabels, ['code', 'temperature', 'wind', 'gust', 'direction', 'precipitation', 'cloud', 'apparent', 'freezing']);
}

export async function verifyWeatherTabWrapping(evaluate: WeatherEvaluate) {
    return evaluate(() => {
        const card = document.getElementById('bpb-peak-weather'), tabs = card!.querySelector<WeatherFixtureElement>('.bpb-week-day[open] .bpb-week-tabs');
        const buttons = [...tabs!.querySelectorAll<WeatherFixtureElement>('button')], original = buttons.find(button => button.getAttribute('aria-selected') === 'true');
        const previous = card!.style.cssText, results = [];
        card!.style.maxWidth = 'none'; card!.style.minWidth = '0';
        try {
            for (let width = 280; width <= 500; width += 2) {
                card!.style.width = `${width}px`;
                const heights = buttons.map(button => {
                    // This sweep checks selected-tab styling, not activation.
                    // Real clicks here enqueue hundreds of synced preference
                    // writes and exhaust Chrome's per-minute storage quota.
                    buttons.forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === button)));
                    return { metric: button.dataset.metric, height: tabs!.getBoundingClientRect().height,
                        overflow: tabs!.scrollWidth > tabs!.clientWidth + 1 };
                });
                const spread = Math.max(...heights.map(row => row.height)) - Math.min(...heights.map(row => row.height));
                if (spread > 1 || heights.some(row => row.overflow)) results.push({ width, heights });
            }
        } finally {
            card!.style.cssText = previous;
            buttons.forEach(button => button.setAttribute('aria-selected', String(button === original)));
        }
        return results;
    });
}
