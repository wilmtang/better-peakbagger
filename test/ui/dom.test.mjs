// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { dom as Dom } from '../../src/ui/dom.js';

test('shared DOM builder applies properties, events, attributes, and children', () => {
    const window = new JSDOM('<!doctype html>').window;
    const previousDocument = globalThis.document;
    globalThis.document = window.document;
    try {
        let clicks = 0;
        const child = window.document.createElement('strong');
        child.textContent = 'child';
        const node = Dom.element('button', {
            class: 'action', text: 'Run', checked: true, type: 'button', onclick: () => { clicks++; }
        }, child);
        assert.equal(node.className, 'action');
        assert.equal(node.firstChild.nodeType, window.Node.TEXT_NODE);
        assert.equal(node.lastChild, child);
        assert.equal(node.checked, true);
        assert.equal(node.getAttribute('type'), 'button');
        node.click();
        assert.equal(clicks, 1);

        const empty = Dom.element('input', { class: null, text: undefined });
        assert.equal(empty.className, '');
        assert.equal(empty.textContent, '');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        window.close();
    }
});
