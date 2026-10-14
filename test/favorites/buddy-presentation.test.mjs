// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { reserveBuddyPresentation } from '../../src/favorites/buddy-presentation.js';
import { applyBuddyProfileState, readBuddyProfile } from '../../src/favorites/buddy-client.js';

test('Buddy sizing preserves the exact native control, form contract and accessible value', async t => {
    const url = 'https://www.peakbagger.com/climber/climber.aspx?cid=900002';
    const dom = new JSDOM(await readFile(new URL('../fixtures/pages/climber-buddy-form.html', import.meta.url), 'utf8'), { url });
    t.after(() => dom.window.close());
    const doc = dom.window.document, input = doc.getElementById('AddBuddy'), form = input.form;
    input.classList.add('bpb-native-buddy-action');
    reserveBuddyPresentation(input); reserveBuddyPresentation(input);
    assert.equal(input.form, form);
    assert.equal(input.name, 'AddBuddy');
    assert.equal(input.value, 'Add to your Buddy List');
    assert.equal(input.closest('[aria-hidden]'), null);
    assert.equal(doc.querySelectorAll('.bpb-buddy-shell').length, 1);
    assert.equal(input.parentElement.style.display, 'inline-grid', 'no stable-but-stretched control');
    const identity = { ownerCid: 900001, cid: 900002, origin: 'https://www.peakbagger.com' };
    assert.equal(readBuddyProfile({ kind: 'ok', url, document: doc }, identity).body.get('AddBuddy'), input.value);
    applyBuddyProfileState(doc, true); reserveBuddyPresentation(input);
    assert.equal(doc.getElementById('RemoveBuddy'), input);
    assert.equal(input.form, form);
    assert.equal(input.value, 'Remove from your Buddy List');
    assert.equal(input.parentElement.firstElementChild.textContent, input.value);
    assert.equal(doc.querySelectorAll('.bpb-buddy-relationship').length, 1);
    assert.equal(doc.getElementById('BuddyLabel').textContent, 'This Climber is one of your buddies.');
    assert.equal(readBuddyProfile({ kind: 'ok', url, document: doc }, identity).buddy, true);
});
