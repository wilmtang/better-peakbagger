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
    button.focus();
    ui.set('ignore', { text: 'Saving…', retry, busy: true, priority: 100 });
    assert.equal(doc.activeElement, button);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    button.click(); assert.equal(attempts, 1, 'focused busy recovery cannot activate again');
    ui.set('ignore', null);
    ui.announce('Not saved.'); ui.announce('Not saved.');
    assert.equal(doc.getElementById('bpb-climber-profile-announcement').textContent, 'Not saved.');
    region.querySelector('details').open = true;
    ui.set('ignore', null);
    assert.equal(region.querySelector('details').hidden, false, 'do not collapse user-opened details asynchronously');
    assert.equal(doc.getElementById('bpb-climber-membership-note').hidden, true);
});
test('new failures supersede old feedback and unavailable recovery never acts clickable', t => {
    const dom = new JSDOM('<span id="TitleLabel"><h1>Name</h1></span>'); t.after(() => dom.window.close());
    const doc = dom.window.document, ui = climberProfileFeedback(doc);
    const old = { text: 'Old failure', error: 'old', retry() {}, priority: 80 };
    ui.set('favorite', old); ui.set('ignore', { text: 'New failure', error: 'new', retry() {}, priority: 80 });
    ui.set('favorite', old);
    assert.equal(doc.getElementById('bpb-climber-membership-note').textContent, 'New failure');
    ui.set('ignore', { text: 'New failure', error: 'new', retry() {}, disabled: true, priority: 80 });
    assert.equal(doc.getElementById('bpb-climber-profile-retry').disabled, true);
});

test('idle feedback is hidden, dismissal persists through identical paints, and new states reappear', t => {
    const dom = new JSDOM('<span id="TitleLabel"><h1>Name</h1><button id="action">Ignore</button></span>');
    t.after(() => dom.window.close());
    const doc = dom.window.document, ui = climberProfileFeedback(doc);
    const region = doc.getElementById('bpb-climber-profile-feedback');
    const action = doc.getElementById('action');
    assert.equal(region.hidden, true);
    action.focus();
    const error = { text: 'Ignore not saved.', error: 'Full explanation', retry() {} };
    ui.set('ignore', error);
    assert.equal(region.hidden, false);
    region.querySelector('details').open = true;
    const dismiss = region.querySelector('[aria-label="Dismiss message"]');
    dismiss.focus(); dismiss.click();
    assert.equal(region.hidden, true);
    assert.equal(doc.activeElement, action, 'dismissal returns focus to the action that opened feedback');
    assert.equal(region.querySelector('details').open, false);
    ui.set('ignore', error);
    assert.equal(region.hidden, true, 'storage repaints must not reopen a dismissed message');
    ui.set('ignore', { text: 'Saving ignored climbers…', busy: true });
    assert.equal(region.hidden, false);
    ui.set('ignore', null);
    assert.equal(region.hidden, true);
    ui.announce('Saved.');
    assert.equal(region.contains(doc.getElementById('bpb-climber-profile-announcement')), false,
        'announcements remain available when visual feedback is dismissed');
});
