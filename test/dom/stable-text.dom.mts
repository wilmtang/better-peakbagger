/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { defineDomSuite } from '../../scripts/dom-tier.mts';

const SOURCE = new URL('../../src/ui/stable-text.ts', import.meta.url);
const MODULE = '/fixture/stable-text.js';
const PAGE = '/fixture/stable-text.html';

export default defineDomSuite({
    name: 'stable text',
    cases: [{
        name: 'reserved readings do not duplicate live-region text and updates retain the reading node',
        async run({ page, route, open }) {
            const { code } = await transform(await readFile(SOURCE, 'utf8'), {
                sourcefile: 'stable-text.ts', loader: 'ts', format: 'esm',
            });
            await route(MODULE, code, 'text/javascript');
            await route(PAGE, '<!doctype html><html><body><p role="status">Overview</p></body></html>');
            await open(PAGE);

            const reading = await page.evaluate(async modulePath => {
                const { createStableText } = await import(modulePath) as typeof import('../../src/ui/stable-text.ts');
                const target = document.querySelector('p')!;
                const text = createStableText(target);
                const label = target.firstElementChild;
                const alternatives = ['Short', 'A much longer interval reading', 'Short'];
                text.reserve(alternatives);
                const reservedText = target.textContent;
                const hiddenAlternatives = target.querySelectorAll('[aria-hidden="true"]').length;
                const sizing = target.lastElementChild;
                text.set('Selected hour');
                text.reserve(alternatives);
                const sameLabel = target.firstElementChild === label;
                const sameReservation = target.lastElementChild === sizing;
                const selectedText = target.textContent;

                const observer = new MutationObserver(() => {});
                observer.observe(target, { childList: true, subtree: true });
                for (let index = 0; index < 120; index++) text.set('Selected hour');
                const repeatedMutations = observer.takeRecords().length;
                text.set('Next hour');
                const changedMutations = observer.takeRecords().length;
                observer.disconnect();
                createStableText(document.createElement('div'));
                return {
                    reservedText, hiddenAlternatives, sameLabel, sameReservation, selectedText,
                    repeatedMutations, changedMutations,
                    styleCount: document.querySelectorAll('#bpb-sizing-text-style').length,
                };
            }, MODULE);

            assert.equal(reading.reservedText, 'Overview');
            assert.equal(reading.hiddenAlternatives, 2);
            assert.equal(reading.sameLabel, true);
            assert.equal(reading.sameReservation, true, 'identical reservations do not churn the DOM');
            assert.equal(reading.selectedText, 'Selected hour');
            assert.equal(reading.repeatedMutations, 0, 'identical readings do not churn live-region text nodes');
            assert.ok(reading.changedMutations > 0, 'changed readings remain visible');
            assert.equal(reading.styleCount, 1);
        },
    }],
});
