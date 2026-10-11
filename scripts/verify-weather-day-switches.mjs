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
                    const collect = () => {
                        const trace = window.__bpbWeatherSwitch;
                        if (!trace || trace.stopped) return;
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
                        focused: document.activeElement === target, stable };
                    delete window.__bpbWeatherSwitch; return result;
                }, index);
                assert.ok(result.stable >= 5, `day did not settle: ${JSON.stringify(result)}`);
                assert.ok(result.records.every(frame => frame.open <= 1 && !frame.empty), `intermediate empty/double expansion: ${JSON.stringify(result)}`);
                assert.ok(Math.abs(result.top - before) <= 1, `clicked heading moved: ${width}/${metric}/${activation}: ${before} -> ${result.top}`);
                assert.equal(result.focused, true);
                measurements.push({ width, metric, activation, displacement: result.top - before });
            }
        }
    }
    return measurements;
}
