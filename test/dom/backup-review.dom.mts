/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { defineDomSuite } from '../../scripts/dom-tier.mts';
import { openSourceModule } from './source-module.mts';

export default defineDomSuite({
    name: 'backup replacement review',
    cases: [{
        name: 'focuses its Cancel action and Escape restores the trigger',
        async run(context) {
            const modulePath = await openSourceModule(context, {
                source: new URL('../../options/backup-review.ts', import.meta.url),
                pagePath: '/fixture/backup-review.html',
                html: '<!doctype html><div class="card"><button>Back up</button></div>',
            });
            const { page } = context;
            const trigger = page.getByRole('button', { name: 'Back up' });
            await trigger.focus();
            await page.evaluate(async url => {
                const { createBackupReview } = await import(url) as typeof import('../../options/backup-review.ts');
                const anchor = document.querySelector('button')!;
                createBackupReview({ anchor, submit: async () => {} }).show({ id: 'review' });
            }, modulePath);

            assert.equal(await page.locator(':focus').textContent(), 'Cancel', 'opening the review must focus Cancel');
            await page.keyboard.press('Escape');
            const panel = page.locator('.backup-replacement');
            assert.equal(await panel.evaluate(element => (element as HTMLElement).hidden), true);
            assert.equal(await panel.isHidden(), true);
            assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
        },
    }],
});
