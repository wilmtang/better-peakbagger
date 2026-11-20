// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The verifiers' page-side probes, run in real fixture pages the way the
// verifiers serialize them into a browser.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import {
    installAnalyzerBfcacheProbe,
    readAnalyzerBfcacheState,
    readAnalyzerChartState,
    readDraftsManagerReadiness,
    readScaleChartState,
    readSunCalculatorGeometry,
    surfaceSelectors,
    webdriverScript,
} from '../../scripts/page-probes.mts';
import { waitForCondition } from '../../scripts/wait-for-condition.mts';

const realms: FixtureDom[] = [];
test.afterEach(() => { for (const realm of realms.splice(0)) realm.window.close(); });
// Runs a probe as WebDriver's executeScript does: in a fresh realm whose free
// names are the given page objects. The probes also read some of these from
// globalThis, so they are defined there too; window and document, which a
// realm cannot redefine, are parameters only.
const executePageFunction = (pageFunction: (...args: never[]) => unknown, context: Record<string, unknown>, ...args: unknown[]) => {
    const realm = new FixtureDom('', { takeFocus: false });
    realms.push(realm);
    // Like the verifiers' extension-free pages, no extension API unless the
    // case supplies one (Chromium windows carry a native chrome object).
    for (const [name, value] of Object.entries({ chrome: undefined, browser: undefined, ...context })) {
        if (name !== 'window' && name !== 'document') Object.defineProperty(realm.window, name, { value, configurable: true });
    }
    return realm.window.Function(...Object.keys(context), webdriverScript(pageFunction, ...args))(...Object.values(context));
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const persistedEvent = (dom: FixtureDom, type: string, persisted: boolean) => {
    const event = new dom.window.Event(type);
    Object.defineProperty(event, 'persisted', { value: persisted });
    return event;
};

test('the report photo probe skips editor spacer images', () => {
    const dom = new FixtureDom(`<div id="bpb-report-editor"><div class="bpb-re-surface"><figure>
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

test('the captured peak report fixture loads a served HTTPS map instead of an MHTML archive frame', async () => {
    const html = await readFile(new URL('../fixtures/pages/peak-rainier.html', import.meta.url), 'utf8');
    const pageUrl = 'https://www.peakbagger.com:45678/peak.aspx?pid=2296&ignored=1';
    // Parsed only: the frame's src resolves against the served page URL.
    const dom = { window: { document: new DOMParser().parseFromString(html, 'text/html'), close() {} } };
    try {
        const frame = dom.window.document.querySelector('#Gmap');
        assert.ok(frame);
        const url = new URL(frame.getAttribute('src')!, pageUrl);
        assert.equal(url.origin, 'https://www.peakbagger.com:45678');
        assert.equal(url.pathname, '/map/MasterMap.aspx');
        assert.equal(url.searchParams.get('t'), 'P');
        assert.equal(url.searchParams.get('d'), '2296');
    } finally {
        dom.window.close();
    }
});

test('draft-manager readiness requires its exact complete extension document and storage surface', async t => {
    const expectedUrl = 'moz-extension://fixture/options/drafts.html';
    const dom = new FixtureDom('<h1>Trip report drafts</h1><ul class="drafts-list"></ul>');
    // The probe reads the URL from the stubbed window below, not the document.
    try {
        let readyState = 'loading';
        Object.defineProperty(dom.window.document, 'readyState', { get: () => readyState });
        type Storage = { storage: { local: { set(): void } } };
        const context: { document: unknown; window: { location: { href: string } }; browser?: Storage; chrome?: Storage } = {
            document: dom.window.document,
            window: { location: { href: 'about:blank' } },
            browser: { storage: { local: { set() {} } } },
        };
        const read = () => plain(executePageFunction(readDraftsManagerReadiness, context, expectedUrl));
        const states: { ready: boolean }[] = [];
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

test('the shared BFCache probe preserves one browser-neutral state contract', () => {
    const dom = new FixtureDom(`<!doctype html><body>
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
    // Not a function, on purpose.
    assert.throws(() => webdriverScript(null as unknown as () => unknown), /page function/i);
});

test('the shared analyzer probes report chart scale and Sun geometry without transport state', () => {
    const dom = new FixtureDom(`<!doctype html><body>
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
    // The probes read only these fields.
    canvas.parentElement!.getBoundingClientRect = () => ({ width: 220 }) as DOMRect;
    canvas.getBoundingClientRect = () => ({ top: 14, height: 180 }) as DOMRect;
    const calculator = dom.window.document.querySelector('.bpb-sun-calculator');
    // Fixed sizes, as for the rectangles: nothing overflows until a case says so.
    const size = (element: Element, scrollWidth = 100) => Object.defineProperties(element, {
        scrollWidth: { value: scrollWidth, configurable: true }, clientWidth: { value: 100, configurable: true },
        scrollHeight: { value: 20, configurable: true }, clientHeight: { value: 20, configurable: true },
    });
    for (const element of calculator.querySelectorAll('*')) {
        element.getBoundingClientRect = () => ({ height: 42 }) as DOMRect;
        size(element);
    }
    calculator.getBoundingClientRect = () => ({ height: 420 }) as DOMRect;

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
        Chart: { getChart: (candidate: unknown) => candidate === canvas ? chart : null },
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
    size(calculator.querySelector('.bpb-sun-calculator__summary'), 102);
    size(calculator.querySelector('.bpb-sun-calculator__panel'), 102);
    const overflowing = plain(executePageFunction(readSunCalculatorGeometry, context));
    assert.deepEqual(overflowing.overflowingText, ['.bpb-sun-calculator__summary']);
    assert.deepEqual(overflowing.overflowingContainers, ['.bpb-sun-calculator__panel']);
});
