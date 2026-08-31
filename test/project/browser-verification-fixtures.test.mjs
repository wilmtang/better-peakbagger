// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
    installAnalyzerBfcacheProbe,
    readAnalyzerBfcacheState,
    readAnalyzerChartState,
    readScaleChartState,
    readSunCalculatorGeometry,
    webdriverScript,
} from '../../scripts/browser-verification-fixtures.mjs';

const executePageFunction = (pageFunction, context, ...args) => vm.runInNewContext(
    `(() => { ${webdriverScript(pageFunction, ...args)} })()`,
    context,
);
const plain = value => JSON.parse(JSON.stringify(value));

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
