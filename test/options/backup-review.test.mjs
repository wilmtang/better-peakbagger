// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBackupReview } from '../../options/backup-review.js';

test('backup replacement focuses its Cancel action and Escape restores the trigger', () => {
    const dom = new JSDOM('<div class="card"><button>Back up</button></div>');
    const document = dom.window.document, previous = globalThis.document; globalThis.document = document;
    try {
        const anchor = document.querySelector('button'); anchor.focus();
        const review = createBackupReview({ anchor, submit: async () => {} });
        review.show({ id: 'review' });
        assert.equal(document.activeElement.textContent, 'Cancel');
        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(document.querySelector('.backup-replacement').hidden, true);
        assert.equal(document.activeElement, anchor);
    } finally { globalThis.document = previous; dom.window.close(); }
});
