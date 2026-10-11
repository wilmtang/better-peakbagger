// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, requestAnimationFrame */
import assert from 'node:assert/strict';

export async function verifyWeatherDaySwitches({ evaluate, click, press, resize, firefoxMode }) {
    const measurements = [];
    for (const width of [1440, 768, 375]) {
        await resize(width, 1000);
        for (const metric of ['temperature', 'code', 'precipitation']) {
            await evaluate(() => document.querySelectorAll('.bpb-week-day').forEach(day => { day.open = false; }));
            await click('.bpb-week-day:first-child > summary');
            await click(`.bpb-week-day[open] [data-metric="${metric}"]`);
            for (const [index, activation] of [[1, 'pointer'], [0, 'Enter'], [1, 'Space']]) {
                const before = await evaluate(index => {
                    const target = document.querySelectorAll('.bpb-week-day > summary')[index];
                    target.scrollIntoView({ block: 'center', behavior: 'instant' }); target.focus({ preventScroll: true });
                    window.__bpbWeatherSwitch = { records: [], stopped: false };
                    const trace = window.__bpbWeatherSwitch;
                    const collect = () => {
                        if (trace.stopped) return;
                        const open = [...document.querySelectorAll('.bpb-week-day[open]')];
                        trace.records.push({ top: target.getBoundingClientRect().top, open: open.length,
                            empty: open.some(day => !day.querySelector('[role="tabpanel"]')) });
                        requestAnimationFrame(collect);
                    };
                    requestAnimationFrame(collect);
                    return target.getBoundingClientRect().top;
                }, index);
                if (activation === 'pointer') await click(`.bpb-week-day:nth-child(${index + 1}) > summary`);
                else await press(activation === 'Space' ? (firefoxMode ? '\uE00D' : 'Space') : (firefoxMode ? '\uE007' : 'Enter'));
                const result = await evaluate(async index => {
                    const target = document.querySelectorAll('.bpb-week-day > summary')[index];
                    let previous, stable = 0;
                    for (let frame = 0; frame < 120; frame++) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        const top = target.getBoundingClientRect().top;
                        stable = target.parentElement.open && top === previous ? stable + 1 : 0; previous = top;
                        if (stable >= 5) break;
                    }
                    const trace = window.__bpbWeatherSwitch; trace.stopped = true;
                    const result = { records: trace.records, top: target.getBoundingClientRect().top,
                        bottom: target.parentElement.getBoundingClientRect().bottom,
                        height: target.parentElement.getBoundingClientRect().height, viewport: window.innerHeight,
                        focused: document.activeElement === target, stable };
                    delete window.__bpbWeatherSwitch; return result;
                }, index);
                assert.ok(result.stable >= 5, `day did not settle: ${JSON.stringify(result)}`);
                assert.ok(result.records.every(frame => frame.open <= 1 && !frame.empty), `intermediate empty/double expansion: ${JSON.stringify(result)}`);
                const expected = Math.max(16, Math.min(before, result.viewport - result.height - 16));
                assert.ok(Math.abs(result.top - expected) <= 1, `day visibility adjustment: ${width}/${metric}/${activation}: ${expected} -> ${result.top}`);
                assert.ok(result.height > result.viewport - 32 || result.bottom <= result.viewport - 15, `detail panel clipped: ${JSON.stringify(result)}`);
                const movements = result.records.filter((frame, index) => index && Math.abs(frame.top - result.records[index - 1].top) > 1);
                assert.ok(movements.length <= 1, `day jitters after activation: ${JSON.stringify(result)}`);
                assert.equal(result.focused, true);
                measurements.push({ width, metric, activation, displacement: result.top - before });
            }
            // A summary fully in view near the bottom should reveal its panel
            // once; a summary near the top should stay at the same position.
            for (const placement of ['bottom', 'top']) {
                await evaluate(() => document.querySelectorAll('.bpb-week-day').forEach(day => { day.open = false; }));
                const before = await evaluate(placement => {
                    const target = document.querySelector('.bpb-week-day > summary'), bounds = target.getBoundingClientRect();
                    const desired = placement === 'top' ? 72 : window.innerHeight - bounds.height - 16;
                    window.scrollBy({ top: bounds.top - desired, behavior: 'instant' });
                    return target.getBoundingClientRect().top;
                }, placement);
                await click('.bpb-week-day:first-child > summary');
                const state = await evaluate(async () => {
                    const detail = document.querySelector('.bpb-week-day[open]');
                    let previous, stable = 0, bounds;
                    for (let frame = 0; frame < 120 && stable < 5; frame++) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        bounds = detail.getBoundingClientRect(); stable = bounds.top === previous ? stable + 1 : 0; previous = bounds.top;
                    }
                    return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, viewport: window.innerHeight, stable };
                });
                assert.ok(state.stable >= 5, `panel did not settle: ${JSON.stringify(state)}`);
                if (placement === 'top') assert.ok(Math.abs(state.top - before) <= 1, `visible panel moved unnecessarily: ${JSON.stringify(state)}`);
                assert.ok(state.top >= 15 && state.bottom <= state.viewport - 15, `opened panel is clipped: ${JSON.stringify(state)}`);
            }
        }
    }
    return measurements;
}

export async function verifyWeatherConditions(evaluate) {
    const state = await evaluate(() => {
        const grid = document.querySelector('.bpb-week-day[open] .bpb-week-conditions');
        const pageWidth = document.documentElement.scrollWidth;
        const label = grid.querySelector('.bpb-week-hourly-table > tbody > tr > th'), before = label.getBoundingClientRect().left;
        grid.scrollLeft = 600;
        const result = { pageWidth, afterWidth: document.documentElement.scrollWidth, scroll: grid.scrollLeft,
            labelDisplacement: label.getBoundingClientRect().left - before, height: grid.clientHeight, scrollHeight: grid.scrollHeight,
            rowLabels: [...grid.querySelectorAll('.bpb-week-hourly-table > tbody > tr > th')].map(node => node.textContent),
            hours: grid.querySelectorAll('.bpb-week-conditions-hour').length };
        grid.scrollLeft = 0; return result;
    });
    assert.ok(state.scroll > 0, `hourly grid did not scroll: ${JSON.stringify(state)}`);
    assert.ok(Math.abs(state.labelDisplacement) <= 1, `row label scrolled away: ${JSON.stringify(state)}`);
    assert.equal(state.afterWidth, state.pageWidth, 'scrolling hourly columns widened the page');
    assert.ok(state.scrollHeight <= state.height + 1, 'Conditions needs vertical scrolling');
    assert.equal(state.hours, 24);
    assert.deepEqual(state.rowLabels, ['Conditions', 'Temperature', 'Feels like', 'Rain/snow', 'Wind', 'Gusts', 'Wind from']);
}

export async function verifyWeatherTabWrapping(evaluate) {
    return evaluate(() => {
        const card = document.getElementById('bpb-peak-weather'), tabs = card.querySelector('.bpb-week-day[open] .bpb-week-tabs');
        const buttons = [...tabs.querySelectorAll('button')], original = buttons.find(button => button.getAttribute('aria-selected') === 'true');
        const previous = card.style.cssText, results = [];
        card.style.maxWidth = 'none'; card.style.minWidth = '0';
        try {
            for (let width = 280; width <= 500; width += 2) {
                card.style.width = `${width}px`;
                const heights = buttons.map(button => {
                    button.click();
                    return { metric: button.dataset.metric, height: tabs.getBoundingClientRect().height,
                        overflow: tabs.scrollWidth > tabs.clientWidth + 1 };
                });
                const spread = Math.max(...heights.map(row => row.height)) - Math.min(...heights.map(row => row.height));
                if (spread > 1 || heights.some(row => row.overflow)) results.push({ width, heights });
            }
        } finally { card.style.cssText = previous; original.click(); }
        return results;
    });
}
