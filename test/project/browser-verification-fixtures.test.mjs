// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createSettingsStore, STORAGE_KEY } from '../../src/settings/settings.js';

import {
    activateToolbarTarget,
    assertMapToggleAnchor,
    installAnalyzerBfcacheProbe,
    readAnalyzerBfcacheState,
    readAnalyzerChartState,
    patchVerificationSettings,
    waitForAnalyzerDarkFocus,
    readDraftsManagerReadiness,
    readScaleChartState,
    readSunCalculatorGeometry,
    surfaceSelectors,
    waitForCondition,
    waitForBuddyHelperCleanup,
    waitForBuddyReportCache,
    waitForPageCondition,
    waitForWindowUrl,
    webdriverScript,
} from '../../scripts/browser-verification-fixtures.mjs';

const executePageFunction = (pageFunction, context, ...args) => vm.runInNewContext(
    `(() => { ${webdriverScript(pageFunction, ...args)} })()`,
    context,
);
const plain = value => JSON.parse(JSON.stringify(value));

test('map mode checks require an anchored action instead of identical renderer spacing', () => {
    const rect = { left: 400, top: 300, width: 44, height: 32 };
    assert.doesNotThrow(() => assertMapToggleAnchor(rect, { ...rect, top: 300.5 }));
    for (const key of Object.keys(rect)) {
        assert.throws(() => assertMapToggleAnchor(rect, { ...rect, [key]: rect[key] + 8 }),
            /Map mode toggle moved or resized/);
        assert.throws(() => assertMapToggleAnchor(rect, { ...rect, [key]: NaN }), /moved or resized/);
    }
    assert.throws(() => assertMapToggleAnchor(rect, null), /moved or resized/);
});

test('the report photo probe skips editor spacer images', () => {
    const dom = new JSDOM(`<div id="bpb-report-editor"><div class="bpb-re-surface"><figure>
        <img class="ProseMirror-separator" alt="">
        <span class="bpb-re-image-resize"><img src="/caption-photo.svg" alt="Ridge"></span>
        <figcaption>North ridge<img class="ProseMirror-separator" alt=""></figcaption>
    </figure></div></div>`);
    try {
        assert.equal(dom.window.document.querySelector(surfaceSelectors.reportPhoto)?.getAttribute('alt'),
            'Ridge', 'browser interaction must target the photo, not a ProseMirror spacer');
    } finally {
        dom.window.close();
    }
});

test('verifier theme changes preserve a pending page settings patch', async () => {
    let stored = { theme: 'light', mapViewportWidth: 450 };
    let signalRead;
    let releaseRead;
    const readStarted = new Promise(resolve => { signalRead = resolve; });
    const readGate = new Promise(resolve => { releaseRead = resolve; });
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
        set: async values => { stored = values[STORAGE_KEY]; },
    };
    const local = {};
    const localArea = { get: async keys => Object.fromEntries(keys.map(key => [key, local[key]])),
        set: async patch => Object.assign(local, patch), remove: async key => { delete local[key]; } };
    const worker = createSettingsStore({ area, localArea, sendMessage: null });
    const page = { evaluate: (fn, patch) => executePageFunction(fn, { chrome: {
        storage: { sync: area },
        runtime: { sendMessage: async message => {
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
    assert.equal(local.bpbDeviceSettings.settings.mapViewportWidth, 520, 'the theme patch must preserve the page mutation');
});

test('verifier settings patches fail closed when the worker refuses the write', async () => {
    for (const response of [null, { ok: false, error: { message: 'storage failed' } }, { ok: true }]) {
        const page = { evaluate: (fn, patch) => executePageFunction(fn, { chrome: {
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
    const canvas = states => ({ evaluate: fn => {
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
    const calls = [];
    let reads = 0;
    const cdp = { send: async (...args) => { calls.push(args); } };
    const page = { evaluate: fn => executePageFunction(fn, { document: {
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
        await assert.rejects(activateToolbarTarget(cdp, { evaluate: async () => state }, 'provider-tab',
            { timeoutMs: 0, intervalMs: 1 }), /loaded toolbar target selection/);
    }
});

test('the working Buddy report finishes its own cache publication before an independent import begins', async () => {
    let reads = 0;
    const report = { evaluate: fn => executePageFunction(fn, { performance: { timeOrigin: 1200.75 } }) };
    const options = { evaluate: (fn, arg) => executePageFunction(fn, { chrome: { storage: { local: {
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
        const wrong = { evaluate: (fn, arg) => executePageFunction(fn, { chrome: { storage: { local: {
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

test('the captured peak report fixture loads a served HTTPS map instead of an MHTML archive frame', async () => {
    const html = await readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: 'https://www.peakbagger.com:45678/peak.aspx?pid=2296&ignored=1' });
    try {
        const frame = dom.window.document.querySelector('#Gmap');
        assert.ok(frame);
        const url = new URL(frame.src);
        assert.equal(url.origin, 'https://www.peakbagger.com:45678');
        assert.equal(url.pathname, '/map/MasterMap.aspx');
        assert.equal(url.searchParams.get('t'), 'P');
        assert.equal(url.searchParams.get('d'), '2296');
    } finally {
        dom.window.close();
    }
});

test('page conditions await async false results and poll until the visible state is ready', async () => {
    let reads = 0;
    const page = { evaluate: async (predicate, arg) => predicate(arg) };
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
    let current;
    const driver = {
        getAllWindowHandles: async () => { pass++; return pass === 1 ? ['closed', 'moved', 'other'] : ['moved', 'other']; },
        switchTo: () => ({ window: async handle => {
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

test('draft-manager readiness requires its exact complete extension document and storage surface', async t => {
    const expectedUrl = 'moz-extension://fixture/options/drafts.html';
    const dom = new JSDOM('<h1>Trip report drafts</h1><ul class="drafts-list"></ul>', { url: expectedUrl });
    try {
        let readyState = 'loading';
        Object.defineProperty(dom.window.document, 'readyState', { get: () => readyState });
        const context = {
            document: dom.window.document,
            window: { location: { href: 'about:blank' } },
            browser: { storage: { local: { set() {} } } },
        };
        const read = () => plain(executePageFunction(readDraftsManagerReadiness, context, expectedUrl));
        const states = [];
        const state = await waitForCondition(async () => {
            const value = read();
            states.push(value);
            if (states.length === 1) context.window.location.href = expectedUrl;
            else if (states.length === 2) readyState = 'interactive';
            else readyState = 'complete';
            return value;
        }, { isReady: value => value.ready, intervalMs: 1, timeoutMs: 2000 });
        assert.equal(states.length, 4);
        assert.equal(state.ready, true);
        assert.equal(state.url, expectedUrl);

        context.browser = undefined;
        assert.equal(read().ready, false, 'a static page cannot substitute for an extension storage surface');
        context.chrome = { storage: { local: { set() {} } } };
        assert.equal(read().ready, true, 'Chrome uses the same document readiness contract');
        dom.window.document.querySelector('.drafts-list').remove();
        assert.equal(read().ready, false, 'the manager surface must exist before writes');
        let clock = 0;
        t.mock.method(Date, 'now', () => clock);
        await assert.rejects(waitForCondition(() => {
            const value = read();
            clock = 2;
            return value;
        }, {
            description: 'draft-manager destination', isReady: value => value.ready, timeoutMs: 1, intervalMs: 1,
        }), /draft-manager destination.*last value:.*"url":"moz-extension:\/\/fixture\/options\/drafts.html".*"hasList":false/s);
    } finally {
        dom.window.close();
    }
});

const persistedEvent = (dom, type, persisted) => {
    const event = new dom.window.Event(type);
    Object.defineProperty(event, 'persisted', { value: persisted });
    return event;
};

test('the shared BFCache probe preserves one browser-neutral state contract', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <section id="bpb-gpx-analysis"></section>
      <input id="bpb-map-route-color" value="#347a3f">
      <div class="bpb-sun-calculator"></div>
      <div id="bpb-map-viewport"></div>
      <button id="bpb-terrain-toggle"></button>
    </body>`);
    const context = { document: dom.window.document, window: dom.window };

    executePageFunction(installAnalyzerBfcacheProbe, context);
    dom.window.dispatchEvent(persistedEvent(dom, 'pagehide', true));
    dom.window.dispatchEvent(persistedEvent(dom, 'pageshow', true));
    const message = new dom.window.Event('message');
    Object.defineProperties(message, {
        source: { value: dom.window },
        data: { value: { __bpb: true, dir: 'toCS', kind: 'get' } },
    });
    dom.window.dispatchEvent(message);

    assert.deepEqual(
        plain(executePageFunction(readAnalyzerBfcacheState, context, '#347a3f')),
        {
            token: 'preserve-this-document',
            hidePersisted: true,
            showPersisted: true,
            settingsGets: 1,
            panels: 1,
            calculators: 1,
            viewports: 1,
            toggles: 1,
        },
    );
    assert.equal(executePageFunction(readAnalyzerBfcacheState, context, '#ffffff'), false);
    assert.throws(() => webdriverScript(null), /page function/i);
});

test('the shared analyzer probes report chart scale and Sun geometry without transport state', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <section id="bpb-gpx-analysis"><div id="chart-parent"><canvas></canvas></div></section>
      <section class="bpb-sun-calculator" data-layout-state="selected">
        <button class="bpb-sun-calculator__toggle">
          <span class="bpb-sun-calculator__summary">114° ESE · 36° above horizon</span>
        </button>
        <div class="bpb-sun-calculator__panel">
          <div class="bpb-sun-calculator__layout"></div>
          <div class="bpb-sun-calculator__controls"></div>
          <div class="bpb-sun-calculator__field"></div>
          <div class="bpb-sun-calculator__field"></div>
          <div class="bpb-sun-calculator__reading"></div>
          <div class="bpb-sun-calculator__compass"></div>
          <div class="bpb-sun-calculator__facts"></div>
          <div class="bpb-sun-calculator__direction"></div>
          <div class="bpb-sun-calculator__elevation"></div>
          <div class="bpb-sun-calculator__moon"></div>
          <div class="bpb-sun-calculator__events"></div>
          <div class="bpb-sun-calculator__limitation"></div>
        </div>
      </section>
    </body>`);
    const canvas = dom.window.document.querySelector('canvas');
    canvas.parentElement.getBoundingClientRect = () => ({ width: 220 });
    canvas.getBoundingClientRect = () => ({ top: 14, height: 180 });
    const calculator = dom.window.document.querySelector('.bpb-sun-calculator');
    for (const element of calculator.querySelectorAll('*')) {
        element.getBoundingClientRect = () => ({ height: 42 });
    }
    calculator.getBoundingClientRect = () => ({ height: 420 });

    const first = [
        { _raw: { sourceIndex: 0, rawEleM: 200 } },
        { _raw: null },
        { _raw: { sourceIndex: 19_999, rawEleM: 3_000 } },
    ];
    const chart = {
        data: { datasets: [
            { label: 'Elevation by Distance', data: first },
            { label: 'Elevation by Time', data: first.slice() },
        ] },
        options: { animation: false },
    };
    const context = {
        document: dom.window.document,
        Chart: { getChart: candidate => candidate === canvas ? chart : null },
    };

    assert.deepEqual(plain(executePageFunction(readAnalyzerChartState, context)), {
        labels: ['Elevation by Distance', 'Elevation by Time'],
        pointCounts: [3, 3],
        pointBudget: 256,
        breakCounts: [1, 1],
        animation: false,
    });
    assert.deepEqual(plain(executePageFunction(readScaleChartState, context)), {
        pointCounts: [2, 2],
        pointBudget: 256,
        sourceIndexes: [0, 19_999],
        rawElevations: [200, 3_000],
        animation: false,
    });
    const geometry = plain(executePageFunction(readSunCalculatorGeometry, context));
    assert.equal(geometry.summary, '114° ESE · 36° above horizon');
    assert.equal(geometry.layoutState, 'selected');
    assert.equal(geometry.calculatorHeight, 420);
    assert.equal(geometry.panelHeight, 42);
    assert.equal(geometry.canvasTop, 14);
    assert.equal(geometry.canvasHeight, 180);
    assert.deepEqual(geometry.overflowingText, []);
    assert.deepEqual(geometry.overflowingContainers, []);
});
