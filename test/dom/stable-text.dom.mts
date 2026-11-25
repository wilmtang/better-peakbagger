/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite } from '../../scripts/dom-tier.mts';
import { openSourceModule } from './source-module.mts';

export default defineDomSuite({
    name: 'stable text',
    cases: [{
        name: 'reserved readings do not duplicate live-region text and updates retain the reading node',
        async run(context) {
            const modulePath = await openSourceModule(context, {
                source: new URL('../../src/ui/stable-text.ts', import.meta.url),
                pagePath: '/fixture/stable-text.html',
                html: '<!doctype html><html><body><p role="status">Overview</p></body></html>',
            });

            const reading = await context.page.evaluate(async url => {
                const { createStableText } = await import(url) as typeof import('../../src/ui/stable-text.ts');
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
            }, modulePath);

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
