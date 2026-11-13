// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fireTrustedEvent reaches into jsdom internals that have no published types
// and are pinned only to jsdom's major. A minor release could keep the names
// and change their meaning, so prove the behavior the tests rely on.

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { fireTrustedEvent } from '../helpers/load-page.mts';

test('fireTrustedEvent dispatches trusted events of the right interface with their attributes', () => {
    const dom = new JSDOM('<main><button>Pick</button></main>');
    try {
        const button = dom.window.document.querySelector('button')!;
        const seen: { type: string; trusted: boolean; kind: string; bubbles: boolean; key?: string; button?: number }[] = [];
        dom.window.document.querySelector('main')!.addEventListener('click', event => seen.push({
            type: event.type, trusted: event.isTrusted, kind: event.constructor.name, bubbles: event.bubbles, button: (event as MouseEvent).button }));
        dom.window.document.addEventListener('keydown', event => seen.push({
            type: event.type, trusted: event.isTrusted, kind: event.constructor.name, bubbles: event.bubbles, key: (event as KeyboardEvent).key }));
        button.addEventListener('change', event => seen.push({ type: event.type, trusted: event.isTrusted, kind: event.constructor.name, bubbles: event.bubbles }));
        button.click();
        fireTrustedEvent(button, 'click', { bubbles: true, button: 0 });
        fireTrustedEvent(button, 'keydown', { bubbles: true, key: 'Escape' });
        fireTrustedEvent(button, 'change', { bubbles: false });
        assert.deepEqual(seen, [
            { type: 'click', trusted: false, kind: 'PointerEvent', bubbles: true, button: 0 },
            { type: 'click', trusted: true, kind: 'MouseEvent', bubbles: true, button: 0 },
            { type: 'keydown', trusted: true, kind: 'KeyboardEvent', bubbles: true, key: 'Escape' },
            { type: 'change', trusted: true, kind: 'Event', bubbles: false },
        ]);
    } finally { dom.window.close(); }
});
