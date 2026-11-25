// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://panel.better-peakbagger.test

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as nextTask } from 'node:timers/promises';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { makeChromeStub, evalBundle, waitFor } from '../helpers/fixture-page.mts';

const open = (theme: string) => Object.assign(new FixtureDom('<html><body></body></html>', {
    url: 'https://panel.better-peakbagger.test',
}), { chrome: makeChromeStub({ bpbSettings: { theme } }) });
type Panel = ReturnType<typeof open>;
const load = async ({ theme = 'light', cached = null, prepare = () => {} }: {
    theme?: string; cached?: string | null; prepare?: (dom: Panel) => void;
} = {}) => {
    const dom = open(theme);
    (dom.window as { chrome?: unknown }).chrome = dom.chrome;
    if (cached) dom.window.localStorage.setItem('bpbThemePref', cached);
    prepare(dom);
    await evalBundle(dom.window, 'options/options-head.js');
    return dom;
};
const rendered = (dom: Panel) => dom.window.document.documentElement.dataset.bpbTheme;

test('an open panel follows stored light/dark preferences and updates its mirror', async t => {
    const dom = await load(); t.after(() => dom.window.close());
    await waitFor(dom, () => dom.window.localStorage.getItem('bpbThemePref') === 'light');
    for (const theme of ['dark', 'light']) {
        await dom.chrome.storage.sync.set({ bpbSettings: { theme } });
        assert.equal(rendered(dom), theme);
        assert.equal(dom.window.localStorage.getItem('bpbThemePref'), theme);
    }
});

test('an old panel read cannot overwrite a later stored preference', async t => {
    let release: (() => void) | undefined;
    const dom = await load({ prepare: panel => {
        const get = panel.chrome.storage.sync.get;
        panel.chrome.storage.sync.get = async key => {
            const snapshot = await get(key);
            await new Promise<void>(resolve => { release = resolve; });
            return snapshot;
        };
    } }); t.after(() => dom.window.close());
    await waitFor(dom, () => !!release);
    await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'dark' } });
    release!();
    await nextTask(0); // Drain the released read's promise chain, not a timing gate.
    assert.equal(rendered(dom), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
});

test('a failed panel read preserves an explicit pre-paint mirror', async t => {
    let warnings = 0;
    const dom = await load({ cached: 'dark', prepare: panel => {
        panel.window.console.warn = () => { warnings++; };
        panel.chrome.storage.sync.get = async () => { throw new Error('storage unavailable'); };
    } }); t.after(() => dom.window.close());
    await waitFor(dom, () => warnings === 1);
    assert.equal(rendered(dom), 'dark');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'dark');
    await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'light' } });
    assert.equal(rendered(dom), 'light');
});

for (const legacy of [false, true]) {
    test(`panel follows system changes only in system mode (${legacy ? 'legacy' : 'modern'} listener)`, async t => {
        let listener: (() => void) | undefined;
        const media = { matches: false, [legacy ? 'addListener' : 'addEventListener']: (...args: unknown[]) => { listener = args.at(-1) as () => void; } };
        const dom = await load({ theme: 'system', prepare: panel => { panel.window.matchMedia = () => media as unknown as MediaQueryList; } });
        t.after(() => dom.window.close());
        await waitFor(dom, () => dom.window.localStorage.getItem('bpbThemePref') === 'system');
        media.matches = true; listener!();
        assert.equal(rendered(dom), 'dark');
        assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'system');
        await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'light' } });
        listener!();
        assert.equal(rendered(dom), 'light');
        await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'system' } });
        assert.equal(rendered(dom), 'dark');
    });
}
