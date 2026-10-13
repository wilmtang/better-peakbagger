// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStableText } from '../../src/ui/stable-text.js';

test('reserved readings do not duplicate live-region text and updates retain the reading node', t => {
    const dom = new JSDOM('<p role="status">Overview</p>'); t.after(() => dom.window.close());
    const target = dom.window.document.querySelector('p'), text = createStableText(target);
    const label = target.firstElementChild;
    text.reserve(['Short', 'A much longer interval reading', 'Short']);
    assert.equal(target.textContent, 'Overview');
    assert.equal(target.querySelectorAll('[aria-hidden="true"]').length, 2);
    const sizing = target.lastElementChild;
    text.set('Selected hour');
    text.reserve(['Short', 'A much longer interval reading', 'Short']);
    assert.equal(target.firstElementChild, label);
    assert.equal(target.lastElementChild, sizing, 'identical reservations do not churn the DOM');
    assert.equal(target.textContent, 'Selected hour');
    createStableText(dom.window.document.createElement('div'));
    assert.equal(dom.window.document.querySelectorAll('#bpb-sizing-text-style').length, 1);
});
