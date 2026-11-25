// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { createSettingsStore, STORAGE_KEY } from '../../src/settings/settings.ts';

import {
    activateToolbarTarget,
    assertMapToggleAnchor,
    patchVerificationSettings,
    waitForAnalyzerDarkFocus,
    waitForCondition,
    waitForBuddyHelperCleanup,
    waitForBuddyReportCache,
    waitForPageCondition,
    waitForWindowUrl,
    webdriverScript,
} from '../../scripts/browser-verification-fixtures.mts';

type PageFunction = (...args: never[]) => unknown;
type Values = Record<string, unknown>;
const executePageFunction = (pageFunction: PageFunction, context: Values, ...args: unknown[]) => vm.runInNewContext(
    `(() => { ${webdriverScript(pageFunction, ...args)} })()`,
    context,
);

test('map mode checks require an anchored action instead of identical renderer spacing', () => {
    const rect = { left: 400, top: 300, width: 44, height: 32 };
    assert.doesNotThrow(() => assertMapToggleAnchor(rect, { ...rect, top: 300.5 }));
    for (const key of Object.keys(rect) as (keyof typeof rect)[]) {
        assert.throws(() => assertMapToggleAnchor(rect, { ...rect, [key]: rect[key] + 8 }),
            /Map mode toggle moved or resized/);
        assert.throws(() => assertMapToggleAnchor(rect, { ...rect, [key]: NaN }), /moved or resized/);
    }
    assert.throws(() => assertMapToggleAnchor(rect, null), /moved or resized/);
});

test('verifier theme changes preserve a pending page settings patch', async () => {
    let stored = { theme: 'light', mapViewportWidth: 450 };
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>(resolve => { signalRead = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    let reads = 0;
    const area = {
        get: async () => {
            const snapshot = { [STORAGE_KEY]: { ...stored } };
            if (++reads === 1) {
                signalRead();
                await readGate;
            }
            return snapshot;
        },
        set: async (values: Values) => { stored = values[STORAGE_KEY] as typeof stored; },
        remove: async () => {},
    };
    const local: Values = {};
    const localArea = { get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, local[key]])),
        set: async (patch: Values) => { Object.assign(local, patch); }, remove: async (key: string) => { delete local[key]; } };
    const worker = createSettingsStore({ area, localArea, sendMessage: null });
    const page = { evaluate: (fn: PageFunction, patch: unknown) => executePageFunction(fn, { chrome: {
        storage: { sync: area },
        runtime: { sendMessage: async (message: { type: string; patch: Values }) => {
            assert.equal(message.type, 'SETTINGS_PATCH');
            return { ok: true, settings: await worker.applyPatch(message.patch) };
        } },
    } }, patch) };
    const pendingMapWrite = worker.applyPatch({ mapViewportWidth: 520 });
    await readStarted;
    const themeWrite = patchVerificationSettings(page, { theme: 'dark' });
    // Drain a raw read/replace if the verifier bypasses the pending worker.
    // Then the delayed worker write would restore its stale light snapshot.
    await new Promise(resolve => setImmediate(resolve));
    releaseRead();
    await Promise.all([pendingMapWrite, themeWrite]);
    assert.equal(stored.theme, 'dark', 'a pending map patch must not restore the old light theme');
    assert.equal((local.bpbDeviceSettings as { settings: { mapViewportWidth: number } }).settings.mapViewportWidth, 520, 'the theme patch must preserve the page mutation');
});

test('verifier settings patches fail closed when the worker refuses the write', async () => {
    for (const response of [null, { ok: false, error: { message: 'storage failed' } }, { ok: true }]) {
        const page = { evaluate: (fn: PageFunction, patch: unknown) => executePageFunction(fn, { chrome: {
            runtime: { sendMessage: async () => response },
        } }, patch) };
        await assert.rejects(patchVerificationSettings(page, { theme: 'dark' }),
            /storage failed|Verification settings patch failed/);
    }
});

test('dark analyzer focus waits for the rendered palette and diagnoses persistent failures', async () => {
    const ready = { theme: 'dark', focused: true, focusVisible: true,
        outlineStyle: 'solid', outlineWidth: '3px', outlineColor: 'rgb(121, 184, 255)' };
    // Use the same object identity as the real activeElement inside the realm.
    type FocusState = typeof ready;
    const canvas = (states: () => Partial<FocusState>) => ({ evaluate: (fn: PageFunction) => {
        const state = states();
        return vm.runInNewContext(`(${fn.toString()})(element)`, (() => {
            const element = { closest: () => ({ dataset: { theme: state.theme } }),
                matches: () => state.focusVisible };
            return { element, document: { activeElement: state.focused ? element : null },
                getComputedStyle: () => state };
        })());
    } });
    let reads = 0;
    const result = await waitForAnalyzerDarkFocus(canvas(() => ++reads < 3
        ? { ...ready, outlineColor: 'rgb(23, 105, 170)' } : ready), { intervalMs: 1 });
    assert.equal(reads, 3, 'the dark data attribute alone cannot prove the rendered palette');
    assert.equal(result.outlineColor, ready.outlineColor);
    for (const invalid of [{ theme: 'light' }, { focused: false }, { focusVisible: false },
        { outlineStyle: 'none' }, { outlineWidth: '0px' }, { outlineColor: 'rgb(23, 105, 170)' }]) {
        await assert.rejects(waitForAnalyzerDarkFocus(canvas(() => ({ ...ready, ...invalid })),
            { timeoutMs: 0, intervalMs: 1 }), /dark-theme focus ring.*last value:/s);
    }
});

test('toolbar capture selects its CDP target and waits for a visible loaded document', async () => {
    const calls: unknown[][] = [];
    let reads = 0;
    const cdp = { send: async (...args: unknown[]) => { calls.push(args); } };
    const page = { evaluate: (fn: PageFunction) => executePageFunction(fn, { document: {
        visibilityState: ++reads < 3 ? 'hidden' : 'visible',
        readyState: reads < 4 ? 'loading' : 'complete',
    } }) };
    const result = await activateToolbarTarget(cdp, page, 'provider-tab', { intervalMs: 1 });
    assert.deepEqual(calls, [['Target.activateTarget', { targetId: 'provider-tab' }]]);
    assert.equal(result.visibility, 'visible');
    assert.ok(reads >= 4, 'target discovery and command completion do not prove selection settled');
    for (const state of [
        { visibility: 'hidden', readyState: 'complete' },
        { visibility: 'visible', readyState: 'loading' },
    ]) {
        await assert.rejects(activateToolbarTarget(cdp, { evaluate: async () => state } as unknown as Parameters<typeof activateToolbarTarget>[1], 'provider-tab',
            { timeoutMs: 0, intervalMs: 1 }), /loaded toolbar target selection/);
    }
});

test('the working Buddy report finishes its own cache publication before an independent import begins', async () => {
    let reads = 0;
    const report = { evaluate: (fn: PageFunction) => executePageFunction(fn, { performance: { timeOrigin: 1200.75 } }) };
    const options = { evaluate: (fn: PageFunction, arg: unknown) => executePageFunction(fn, { chrome: { storage: { local: {
        get: async () => ({ bpbBuddyCache: { ownerCid: 900001, entries: Array(6).fill({ cid: 1 }),
            fetchedAt: ++reads < 3 ? 1100 : 1200 } }),
    } } } }, arg) };
    const state = await waitForBuddyReportCache(options, report, { ownerCid: 900001, count: 6 }, { intervalMs: 1 });
    assert.equal(state.fetchedAt, 1200, 'an already-fresh six-entry cache cannot prove this report visit finished');
    assert.ok(reads >= 3);
    for (const cache of [
        { ownerCid: 900002, fetchedAt: 1200, entries: Array(6).fill({}) },
        { ownerCid: 900001, fetchedAt: 1200, entries: [] },
    ]) {
        const wrong = { evaluate: (fn: PageFunction, arg: unknown) => executePageFunction(fn, { chrome: { storage: { local: {
            get: async () => ({ bpbBuddyCache: cache }),
        } } } }, arg) };
        await assert.rejects(waitForBuddyReportCache(wrong, report, { ownerCid: 900001, count: 6 },
            { timeoutMs: 0, intervalMs: 1 }), /working Buddy report cache publication/);
    }
});

test('Buddy import waits for asynchronous helper teardown and preserves the original page', async () => {
    const url = 'https://www.peakbagger.com/report/report.aspx?r=b';
    const working = { url: () => url }, helper = { url: () => url };
    let reads = 0;
    const context = { pages: () => ++reads < 3 ? [working, helper] : [working] };
    const result = await waitForBuddyHelperCleanup(context, url, working, { intervalMs: 1 });
    assert.equal(result.closed, true, 'import completion precedes the helper tab close event');
    assert.ok(reads >= 3);
    assert.deepEqual(result.urls, [url]);
    for (const pages of [[helper], [working, { url: () => 'chrome-extension://fixture/options/buddy-refresh.html' }]]) {
        await assert.rejects(waitForBuddyHelperCleanup({ pages: () => pages }, url, working,
            { timeoutMs: 0, intervalMs: 1 }), /original page preserved/);
    }
});

test('page conditions await async false results and poll until the visible state is ready', async () => {
    let reads = 0;
    const page = { evaluate: async <R, Arg>(predicate: (arg: Arg) => R | Promise<R>, arg: Arg) => predicate(arg) };
    const state = await waitForPageCondition(page, async expected => {
        await Promise.resolve();
        reads++;
        return reads === 3 ? { status: expected } : false;
    }, 'saved', { timeout: 2000 });
    assert.deepEqual(state, { status: 'saved' });
    assert.equal(reads, 3);
    await assert.rejects(waitForPageCondition(page, async () => false, null, { timeout: 1 }),
        /Timed out waiting for page condition.*last value: false/s);
});

test('a moved tab is reacquired after its old handle closes and the new destination loads', async () => {
    const url = 'moz-extension://fixture/options/options.html#beta';
    let pass = 0;
    let current: string | undefined;
    const driver = {
        getAllWindowHandles: async () => { pass++; return pass === 1 ? ['closed', 'moved', 'other'] : ['moved', 'other']; },
        switchTo: () => ({ window: async (handle: string) => {
            if (handle === 'closed') throw Object.assign(new Error('removed browsing context'), { name: 'NoSuchWindowError' });
            current = handle;
        } }),
        getCurrentUrl: async () => current === 'moved'
            ? pass === 1 ? 'about:blank' : url
            : 'https://www.peakbagger.com/options/options.html#beta',
    };
    assert.equal(await waitForWindowUrl(driver, url, { intervalMs: 1 }), 'moved');
    assert.equal(pass, 2);
    assert.equal(current, 'moved', 'leave the driver in the exact destination, not the last inspected tab');
});

test('matching duplicate windows remain ambiguous and report their live destinations', async t => {
    const url = 'moz-extension://fixture/options/options.html#beta';
    let clock = 0;
    t.mock.method(Date, 'now', () => clock);
    const driver = {
        getAllWindowHandles: async () => ['one', 'two'],
        switchTo: () => ({ window: async () => {} }),
        getCurrentUrl: async () => { clock = 2; return url; },
    };
    await assert.rejects(waitForWindowUrl(driver, url, { timeoutMs: 1, intervalMs: 1 }),
        /Timed out waiting for window.*"matches":\[\{"handle":"one".*"handle":"two"/s);
});

test('condition polling rejects an early window and loading document before accepting readiness', async () => {
    const expectedUrl = 'moz-extension://fixture/options/drafts.html';
    const states = [
        { ready: false, url: 'about:blank', readyState: 'complete' },
        { ready: false, url: expectedUrl, readyState: 'loading' },
        { ready: false, url: expectedUrl, readyState: 'interactive' },
        { ready: true, url: expectedUrl, readyState: 'complete' },
    ];
    let reads = 0;
    const state = await waitForCondition(async () => states[reads++], {
        isReady: value => value.ready,
        intervalMs: 1,
        timeoutMs: 2000,
    });
    assert.deepEqual(state, states.at(-1));
    assert.equal(reads, 4, 'a window handle must not substitute for the loaded destination');
});

