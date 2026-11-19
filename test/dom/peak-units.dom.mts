// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite, type DomContext } from '../../scripts/dom-tier.mts';
import type { UnitSystem } from '../../src/ui/units.ts';
import { peakUnitHeadings } from '../helpers/peak-unit-fixture.mts';
import { openSourceModule } from './source-module.mts';

const valid: readonly (readonly [string, UnitSystem])[] = [
    ...peakUnitHeadings,
    ['−100.5 metres, −329.7 feet', 'metric'],
    ['-300 foot, -91.4 meters', 'imperial'],
];
const inconclusive = [
    '<p>Elevation: 300 meters</p>',
    '<h2>Elevation: unknown</h2>',
    '<h2>Elevation: 300 miles</h2>',
    '<h2>Elevation: 1,,200 m</h2>',
    '<h2>Elevation: 300 m</h2><h2>Elevation: 984 ft</h2>',
    '<h2>Report</h2><p>I climbed 300 meters</p>',
];

async function checkHeadings(context: DomContext, cases: readonly { html: string; expected: UnitSystem | null }[]) {
    const modulePath = await openSourceModule(context, {
        source: new URL('../../src/peakbagger/peak-units.ts', import.meta.url),
        pagePath: '/fixture/peak-units.html',
        html: '<!doctype html><title>Peak elevation units</title>',
    });
    const results = await context.page.evaluate(async ({ url, snippets }) => {
        const { readPeakUnitSystem } = await import(url) as typeof import('../../src/peakbagger/peak-units.ts');
        const parser = new DOMParser();
        return snippets.map(html => readPeakUnitSystem(parser.parseFromString(html, 'text/html')));
    }, { url: modulePath, snippets: cases.map(({ html }) => html) });
    for (const [index, { html, expected }] of cases.entries()) {
        assert.equal(results[index], expected, html);
    }
}

export default defineDomSuite({
    name: 'peak elevation units',
    cases: [{
        name: 'recognizes native full and abbreviated first-unit spellings',
        run: context => checkHeadings(context, valid.map(([heading, expected]) => ({
            html: `<h2>Elevation: ${heading}</h2>`, expected,
        }))),
    }, {
        name: 'rejects missing, ambiguous and unrelated elevation mentions',
        run: context => checkHeadings(context, inconclusive.map(html => ({ html, expected: null }))),
    }],
});
