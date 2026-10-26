// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, location, scrollY, innerWidth, innerHeight, getComputedStyle */
import assert from 'node:assert/strict';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export function readSettingsFragmentLanding() {
    const pane = document.querySelector('.content'), target = document.getElementById(location.hash.slice(1));
    if (!target) return { hash: location.hash, missing: true };
    const box = target.getBoundingClientRect(), frame = pane.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    const owner = [...document.querySelectorAll('.side-nav a')].reverse().find(link => {
        const group = document.getElementById(link.hash.slice(1));
        return group === target || group?.contains(target);
    });
    return { hash: location.hash, scroll: pane.scrollTop,
        expected: Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, pane.scrollTop + box.top - frame.top - margin)),
        targetTop: box.top, paneTop: frame.top, paneBottom: frame.bottom,
        current: document.querySelector('.side-nav [aria-current]')?.hash, owner: owner?.hash,
        rootScroll: scrollY, bodyScroll: document.body.scrollTop, behavior: pane.style.scrollBehavior,
        viewport: { width: innerWidth, height: innerHeight } };
}

export const settingsFragmentLanded = (value, hash) => value.hash === hash && !value.missing && Math.abs(value.scroll - value.expected) <= 1
    && value.current === value.owner && value.rootScroll === 0 && value.bodyScroll === 0 && value.behavior === '';

export async function verifySettingsFragments({ evaluate, navigate, reload, back, forward, resize, keyboardLink, configure, screenshot }) {
    let cases = 0; const viewports = [];
    const land = async (hash, label) => {
        const read = () => evaluate(readSettingsFragmentLanding);
        try { await waitForCondition(read, { description: label, timeoutMs: 5000, isReady: value => settingsFragmentLanded(value, hash) }); }
        catch (error) { assert.fail(`${label}: anchored content did not land: ${JSON.stringify(await read())}. ${error.message}`); }
        cases++; return read();
    };
    for (const [width, theme, expanded] of [[1000, 'light', true], [375, 'dark', true], [1000, 'dark', false], [375, 'light', false]]) {
        const label = `${width}-${theme}-${expanded ? 'expanded' : 'compact'}`;
        await resize(width, 760);
        await configure({ theme, enableReportEditor: expanded, enableGarminInbox: expanded });
        for (const hash of ['#map-chart-chart', '#map-chart-map', '#custom-map-layers', '#ignored-github', '#about']) {
            await navigate(hash); await land(hash, `${label}/${hash}/open`);
            await reload(); await land(hash, `${label}/${hash}/refresh`);
            await evaluate(() => document.querySelector('.content').scrollTo({ top: 0, behavior: 'instant' }));
            await reload();
            const state = await land(hash, `${label}/${hash}/refresh-after-manual-scroll`);
            if (hash === '#map-chart-chart') { viewports.push(state.viewport); await screenshot?.(`${label}-chart`); }
        }
        await navigate('#map-chart-chart'); await land('#map-chart-chart', `${label}/history-start`);
        if (width === 1000) await keyboardLink('#custom-map-layers');
        else await evaluate(() => { location.hash = '#custom-map-layers'; });
        await land('#custom-map-layers', `${label}/hash-navigation`);
        await back(); await land('#map-chart-chart', `${label}/back`);
        await forward(); await land('#custom-map-layers', `${label}/forward`);
        await reload(); await land('#custom-map-layers', `${label}/refresh-after-history`);
        // Settings updates after navigation must not keep snapping to the URL.
        await evaluate(async () => {
            document.querySelector('.content').scrollTo({ top: 0, behavior: 'instant' });
            const api = globalThis.browser || globalThis.chrome;
            const saved = await api.storage.sync.get('bpbSettings');
            await api.storage.sync.set({ bpbSettings: { ...saved.bpbSettings, theme: saved.bpbSettings.theme === 'light' ? 'dark' : 'light' } });
        });
        await waitForCondition(() => evaluate(() => ({ scroll: document.querySelector('.content').scrollTop,
            theme: document.documentElement.dataset.bpbTheme })), {
            description: `${label}/manual reading survives settings updates`,
            isReady: value => value.theme !== theme && value.scroll === 0,
        });
        cases++;
    }
    assert.ok(cases >= 80, 'fragment verification must execute its load, refresh and history cases');
    return { cases, viewports, anchors: 5, refresh: true, backForward: true, manualReading: true };
}
