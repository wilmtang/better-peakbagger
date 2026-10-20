// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readPeakUnitSystem } from '../../src/peakbagger/peak-units.js';
import { peakUnitHeadings } from '../helpers/peak-unit-fixture.mjs';

test('peak units recognize native full and abbreviated first-unit spellings', () => {
    for (const [heading, expected] of [...peakUnitHeadings, ['−100.5 metres, −329.7 feet', 'metric'], ['-300 foot, -91.4 meters', 'imperial']]) {
        const dom = new JSDOM(`<h2>Elevation: ${heading}</h2>`);
        try { assert.equal(readPeakUnitSystem(dom.window.document), expected, heading); }
        finally { dom.window.close(); }
    }
});

test('missing, ambiguous and unrelated elevation mentions cannot choose peak units', () => {
    for (const html of ['<p>Elevation: 300 meters</p>', '<h2>Elevation: unknown</h2>',
        '<h2>Elevation: 300 miles</h2>', '<h2>Elevation: 1,,200 m</h2>',
        '<h2>Elevation: 300 m</h2><h2>Elevation: 984 ft</h2>', '<h2>Report</h2><p>I climbed 300 meters</p>']) {
        const dom = new JSDOM(html);
        try { assert.equal(readPeakUnitSystem(dom.window.document), null, html); }
        finally { dom.window.close(); }
    }
});
