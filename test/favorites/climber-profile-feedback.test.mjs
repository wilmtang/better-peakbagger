// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { climberProfileFeedback } from '../../src/favorites/climber-profile-feedback.js';

test('profile feedback has one owner outside the heading and does not auto-expand errors', t => {
    const dom = new JSDOM('<span id="TitleLabel"><h1>Name</h1></span>');
    t.after(() => dom.window.close());
    const doc = dom.window.document, ui = climberProfileFeedback(doc);
    assert.equal(climberProfileFeedback(doc), ui);
    let attempts = 0;
    const retry = () => attempts++;
    ui.set('ignore', { text: "Couldn't save ignored climbers.", error: 'Full explanation '.repeat(30), retry, priority: 80 });
    const region = doc.getElementById('bpb-climber-profile-feedback');
    assert.equal(doc.getElementById('TitleLabel').contains(region), false);
    assert.equal(region.querySelector('details').open, false);
    assert.equal(region.querySelector('details p').textContent.length, 510);
    ui.set('favorite', { text: 'Saving favorites…', retry, busy: true, priority: 100 });
    const button = doc.getElementById('bpb-climber-profile-retry');
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, true);
    button.click(); assert.equal(attempts, 0);
    ui.set('favorite', null);
    button.click(); assert.equal(attempts, 1);
    ui.announce('Not saved.'); ui.announce('Not saved.');
    assert.equal(doc.getElementById('bpb-climber-profile-announcement').textContent, 'Not saved.');
    region.querySelector('details').open = true;
    ui.set('ignore', null);
    assert.equal(region.querySelector('details').hidden, false, 'do not collapse user-opened details asynchronously');
    assert.equal(doc.getElementById('bpb-climber-membership-note').hidden, true);
});
