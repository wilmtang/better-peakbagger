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

test('the shared builder can express the inline styles injected surfaces need', () => {
    // The injected surfaces hand-rolled createElement because they style inline
    // — they cannot assume a stylesheet reached the page — and the builder had
    // no way to say so. That was the only category it could not serve.
    const window = new JSDOM('<!doctype html>').window;
    const previousDocument = globalThis.document;
    globalThis.document = window.document;
    try {
        const node = Dom.element('div', {
            id: 'styled',
            style: { position: 'relative', boxSizing: 'border-box', opacity: '0.72' }
        });
        assert.equal(node.style.position, 'relative');
        assert.equal(node.style.boxSizing, 'border-box');
        assert.equal(node.style.opacity, '0.72');
        assert.equal(node.getAttribute('style') !== null, true);
        assert.equal(node.getAttribute('id'), 'styled');

        // A non-object style is ignored rather than stringified onto the node.
        const plain = Dom.element('div', { style: null });
        assert.equal(plain.getAttribute('style'), null);
    } finally {
        globalThis.document = previousDocument;
        window.close();
    }
});

test('the shared builder records its adoption policy rather than leaving it implicit', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/ui/dom.js', import.meta.url), 'utf8');
    assert.match(source, /not options-page-only/i,
        'the split must be documented, not left for a reader to infer per file');
    assert.match(source, /style inline/i, 'and it must say why the holdouts held out');
});
