// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window */
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifyWeatherModelRefresh({ evaluate, navigate, click, resize, wait, setSettings,
    setMode, release, evidence, origin, screenshotPage, output, firefoxMode }) {
    const geometry = () => {
        const card = document.getElementById('bpb-ascent-weather'), bounds = card.getBoundingClientRect();
        return { height: bounds.height, top: bounds.top + window.scrollY, scrollY: window.scrollY,
            positions: ['.bpb-weather-result', '.bpb-weather-model select', '.bpb-weather-hourly', 'footer']
                .map(selector => card.querySelector(selector).getBoundingClientRect().top - bounds.top),
            values: [...card.querySelectorAll('[data-weather-value]')].map(node => node.textContent),
            condition: card.querySelector('h3').textContent,
            feedback: card.querySelector('.bpb-weather-status').textContent,
            expanded: card.querySelector('.bpb-weather-disclosure').getAttribute('aria-expanded'),
            metric: card.querySelector('[role="tab"][aria-selected="true"]').dataset.metric,
            focus: document.activeElement === card.querySelector('select') };
    };
    const assertStable = (before, after, label, checkHeight = true) => {
        for (const key of ['top', 'scrollY', ...(checkHeight ? ['height'] : [])]) {
            assert.ok(Math.abs(before[key] - after[key]) <= 1, `${label}: ${key} changed: ${JSON.stringify({ before, after })}`);
        }
        // The footer may move when the new model supplies different hourly
        // fields or timing notes; loading must never move any of these controls.
        const positions = checkHeight ? before.positions : before.positions.slice(0, 3);
        positions.forEach((value, index) => assert.ok(Math.abs(value - after.positions[index]) <= 1,
            `${label}: control ${index} moved: ${JSON.stringify({ before, after })}`));
    };
    for (const theme of ['light', 'dark']) {
        await setSettings({ theme, units: 'metric' });
        for (const width of [1440, 375]) {
            await resize(width, 1100);
            for (const view of ['closed', 'temperature', 'conditions']) {
                setMode('complete'); await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
                await evaluate(() => document.getElementById('bpb-ascent-weather').scrollIntoView({ block: 'start', behavior: 'instant' }));
                await wait(() => document.querySelector('.bpb-weather-model-description')?.textContent.includes('Using Best Match')
                    && document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'false', 'weather before model refresh');
                if (width === 1440) {
                    await evaluate(() => document.getElementById('bpb-ascent-table-resize-handle')
                        .dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Home' })));
                    await wait(() => document.getElementById('bpb-ascent-weather').getBoundingClientRect().width > 601,
                        'wide weather column with inline model controls');
                }
                if (view !== 'closed') {
                    await click('.bpb-weather-disclosure'); await click(`[data-metric="${view}"]`);
                }
                await evaluate(() => document.querySelector('.bpb-weather-model select').focus({ preventScroll: true }));
                const before = await evaluate(geometry), requestCount = evidence.length;
                setMode('loading');
                await evaluate(() => {
                    const select = document.querySelector('.bpb-weather-model select'); select.value = 'gfs_global'; select.dispatchEvent(new Event('change'));
                });
                await wait(() => document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'true'
                    && document.querySelector('.bpb-weather-model-description').textContent.includes('Updating… Showing Best Match'), 'in-place refresh feedback');
                // Wait for the intercepted response before releasing it; the
                // busy flag is set before the request reaches the transport.
                await waitForCondition(() => evidence.length === requestCount + 1,
                    { description: 'one intercepted model refresh request', timeoutMs: 20_000 });
                const pending = await evaluate(geometry), label = `${theme}/${width}/${view}`;
                assertStable(before, pending, `${label} pending`);
                for (const key of ['values', 'condition', 'feedback', 'expanded', 'metric', 'focus']) assert.deepEqual(pending[key], before[key], `${label}: ${key}`);
                // Element screenshots scroll the card into view. Page captures
                // leave the viewport untouched for the settled scroll check.
                if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-refresh-${view}-pending-${width}.png`));
                setMode('complete'); release();
                await wait(() => document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'false'
                    && document.querySelector('.bpb-weather-model-description').textContent.includes('Using GFS'), 'replacement weather settles');
                const after = await evaluate(geometry);
                assertStable(before, after, `${label} settled`, view !== 'conditions');
                assert.equal(after.expanded, before.expanded); assert.equal(after.metric, before.metric); assert.equal(after.focus, true);
                if (output) await screenshotPage(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${theme}-refresh-${view}-settled-${width}.png`));
            }
        }
    }
    // Restore the viewport expected by the following GPX fixture; its chart
    // must be created at the final width before pointer coordinates are read.
    await resize(1440, 1100);
    await evaluate(() => document.getElementById('bpb-ascent-table-resize-handle')
        .dispatchEvent(new document.defaultView.MouseEvent('dblclick')));
    setMode('complete'); await navigate(`${origin}/climber/ascent.aspx?aid=7654321&weather=no-gpx`);
    await wait(() => document.querySelector('.bpb-weather-model-description')?.textContent.includes('Using Best Match')
        && document.getElementById('bpb-ascent-weather').getAttribute('aria-busy') === 'false', 'restore the collapsed weather fixture');
}
