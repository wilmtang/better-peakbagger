// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, chrome */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export async function verifySnotelOptions({ evaluate, click, resize, screenshot, reload, firefoxMode }) {
    const output = process.env.BPB_VERIFY_SNOW_MAP_SCREENSHOT_DIR;
    if (output) await mkdir(output, { recursive: true });
    const cases = [];
    const geometry = () => evaluate(() => {
        const control = document.getElementById('show-snotel');
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { checkbox: rect(control), row: rect(control.closest('.row')), heading: rect(document.getElementById('general-settings-heading')),
            following: rect(document.getElementById('general-units-heading')),
            scroll: { x: window.scrollX, y: window.scrollY, content: document.querySelector('.content').scrollTop } };
    });
    const stable = (before, after) => {
        for (const part of Object.keys(before)) for (const dimension of Object.keys(before[part])) {
            assert.ok(Math.abs(before[part][dimension] - after[part][dimension]) <= 1,
                `SNOTEL setting moved ${part}.${dimension}: ${JSON.stringify({ before, after })}`);
        }
    };
    const saved = enabled => waitForCondition(() => evaluate(async () => {
        const settings = (await chrome.storage.sync.get('bpbSettings')).bpbSettings;
        return { enabled: settings?.showSnotel, weather: settings?.showWeather,
            checked: document.getElementById('show-snotel').checked };
    }), { description: `saved SNOTEL preference ${enabled}`, timeoutMs: 10_000,
        isReady: state => state.enabled === enabled && state.checked === enabled && state.weather === true });
    // Firefox's headless window has a 500px minimum; privileged extension
    // pages cannot use BiDi's smaller content-viewport emulation.
    for (const width of [1000, firefoxMode ? 500 : 375]) for (const theme of ['light', 'dark']) {
        await resize(width, 1100);
        await waitForCondition(() => evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })), {
            description: `options ${width} × 1100 viewport`, timeoutMs: 10_000,
            isReady: viewport => viewport.width === width && viewport.height === 1100,
        });
        await evaluate(async patch => {
            const reply = await chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch });
            if (reply?.ok !== true) throw new Error('Could not prepare SNOTEL options');
        }, { showSnotel: true, showWeather: true, theme });
        await saved(true);
        await waitForCondition(() => evaluate(() => document.documentElement.dataset.bpbTheme), {
            description: `options ${theme} theme`, timeoutMs: 10_000, isReady: value => value === theme,
        });
        assert.equal(await evaluate(() => document.getElementById('show-snotel').closest('section').id), 'general');
        // Preposition immediately: the pane's smooth-scroll animation would
        // otherwise keep moving during the checkbox stability assertion.
        await evaluate(() => document.getElementById('show-snotel').closest('.row').scrollIntoView({ block: 'center', behavior: 'instant' }));
        const initial = await geometry();
        await click('#show-snotel'); await saved(false); stable(initial, await geometry());
        assert.equal(await evaluate(() => document.activeElement.id), 'show-snotel');
        if (output) await screenshot(path.join(output, `${firefoxMode ? 'firefox' : 'chrome'}-${width}-${theme}-snotel-options-off.png`));
        await reload(); await saved(false);
        await evaluate(() => document.getElementById('show-snotel').closest('.row').scrollIntoView({ block: 'center', behavior: 'instant' }));
        const restored = await geometry();
        await click('#show-snotel'); await saved(true); stable(restored, await geometry());
        cases.push({ width, theme, states: ['on', 'off', 'saved', 'reload', 'on'] });
    }
    assert.ok(cases.length > 0);
    return cases;
}
