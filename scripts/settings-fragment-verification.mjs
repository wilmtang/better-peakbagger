// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, location, scrollY, innerWidth, innerHeight, getComputedStyle, requestAnimationFrame */
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

const readScrollTracking = () => {
    const nav = document.querySelector('.side-nav'), list = nav.querySelector('.nav-list');
    const content = document.querySelector('.content'), active = nav.querySelector('[aria-current]');
    const link = active.getClientRects().length ? active
        : active.closest('li').parentElement.closest('li').querySelector('.nav-item');
    const scroller = getComputedStyle(list).overflowX === 'auto' ? list : nav;
    const rect = node => {
        const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
    };
    const row = link.getBoundingClientRect(), frame = scroller.getBoundingClientRect();
    return { current: active.hash, visible: row.width > 0 && row.height > 0
        && row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1
        && row.left >= frame.left - 1 && row.right <= frame.right + 1,
    row: rect(link), frame: rect(scroller), nav: rect(nav), content: rect(content),
    rootScroll: scrollY, bodyScroll: document.body.scrollTop, contentScroll: content.scrollTop,
    navScroll: { top: scroller.scrollTop, left: scroller.scrollLeft },
    focus: document.activeElement.id, viewport: { width: innerWidth, height: innerHeight } };
};

// Exercise passive scrolling independently of fragment/click navigation. The
// real extension supplies settings and layout; no navigation or geometry stubs.
export async function verifySettingsScrollTracking({ evaluate, navigate, resize, configure, screenshot }) {
    let cases = 0; const viewports = [];
    for (const [width, height, theme, enlarged] of [[1000, 760, 'light', false], [1000, 420, 'dark', false],
        [375, 760, 'light', false], [1000, 760, 'dark', true], [375, 760, 'dark', true]]) {
        const label = `scroll-${width}-${height}-${theme}${enlarged ? '-large-text' : ''}`;
        await resize(width, height);
        await configure({ theme, enableReportEditor: true, enableGarminInbox: true });
        await navigate('');
        await waitForCondition(() => evaluate(() => document.getElementById('enable-garmin-inbox').checked
            && !document.getElementById('capture-garmin').hidden), { description: `${label}/settings ready` });
        await evaluate(enlarged => {
            if (enlarged) for (const node of document.querySelectorAll('.side-nav a, .side-nav h1, .side-nav p')) {
                node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
            }
            document.getElementById('theme').focus({ preventScroll: true });
        }, enlarged);
        for (const id of ['general-units', 'map-chart-map', 'github-settings-backup', 'about',
            'github-connection', 'map-chart-chart', 'general-features', 'general']) {
            await evaluate(id => {
                const content = document.querySelector('.content'), target = document.getElementById(id);
                content.scrollTo({ top: content.scrollTop + target.getBoundingClientRect().top
                    - content.getBoundingClientRect().top - 24, behavior: 'instant' });
            }, id);
            const before = await evaluate(readScrollTracking);
            await waitForCondition(() => evaluate(readScrollTracking), {
                description: `${label}/${id}/active section`, isReady: state => state.current === `#${id}`,
            });
            const state = await evaluate(readScrollTracking), detail = `${label}/${id}: ${JSON.stringify(state)}`;
            assert.equal(state.visible, true, `active navigation row left its scroll viewport; ${detail}`);
            assert.equal(state.focus, 'theme', `passive navigation stole keyboard focus; ${detail}`);
            assert.equal(state.rootScroll, 0, detail); assert.equal(state.bodyScroll, 0, detail);
            assert.ok(Math.abs(state.contentScroll - before.contentScroll) <= 1, `revealing navigation moved the reading position; ${detail}`);
            for (const pane of ['nav', 'content']) for (const dimension of ['x', 'y', 'width', 'height']) {
                assert.ok(Math.abs(state[pane][dimension] - before[pane][dimension]) <= 1, `revealing navigation moved ${pane}.${dimension}; ${detail}`);
            }
            cases++;
            if (['github-settings-backup', 'map-chart-chart'].includes(id)) await screenshot?.(`${label}-${id}`);
        }
        // Readers may inspect another part of the menu. Small content scrolls
        // within the same section must not keep pulling the sidebar back.
        await evaluate(() => {
            const nav = document.querySelector('.side-nav'), list = nav.querySelector('.nav-list');
            nav.scrollTop = nav.scrollHeight; list.scrollLeft = list.scrollWidth;
            document.querySelector('.content').scrollTo({ top: 4, behavior: 'instant' });
        });
        const manual = await evaluate(readScrollTracking);
        await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const settled = await evaluate(readScrollTracking);
        assert.equal(settled.current, '#general', label);
        assert.deepEqual(settled.navScroll, manual.navScroll, `${label}: repeated scrolls must preserve manual menu browsing`);
        cases++; viewports.push(settled.viewport);
    }
    assert.equal(cases, 45, 'scroll tracking must execute every direction, viewport and text-size case');
    return { cases, viewports, passiveScroll: true, focusPreserved: true, enlargedNavigationText: true };
}

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
