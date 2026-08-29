// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ascentTableSplit as Split } from '../../src/ascent/ascent-table-split.js';

const legacyHtml = ({ between = '' } = {}) => `<!doctype html><html><body><form>
  <table class="gray" id="report" width="49%" align="left">
    <tr><th>Ascent Trip Report</th></tr><tr><td>A long report.</td></tr>
  </table>
  ${between}
  <table class="gray" id="summary" width="50%" align="right">
    <tr><th>Summary Total Data</th></tr><tr><td>Distance</td></tr>
  </table>
</form></body></html>`;

const setup = ({ html = legacyHtml(), saved = null } = {}) => {
    const dom = new JSDOM(html, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        pretendToBeVisual: true,
    });
    if (saved !== null) dom.window.localStorage.setItem(Split.storageKey, saved);
    const previousDocument = globalThis.document;
    globalThis.document = dom.window.document;
    const split = Split.mount({
        doc: dom.window.document,
        storage: dom.window.localStorage,
    });
    const restore = () => {
        globalThis.document = previousDocument;
        dom.window.close();
    };
    return { dom, split, restore };
};

test('the exact legacy report / summary pair becomes one accessible split', () => {
    const { dom, split, restore } = setup();
    try {
        assert.ok(split);
        assert.deepEqual(Array.from(split.wrapper.children).map(element => element.id), [
            'report', 'bpb-ascent-table-resize-handle', 'summary',
        ]);
        assert.equal(split.handle.type, 'button', 'the handle cannot submit Peakbagger\'s page form');
        assert.equal(split.handle.getAttribute('role'), 'separator');
        assert.equal(split.handle.getAttribute('aria-orientation'), 'vertical');
        assert.equal(split.handle.getAttribute('aria-valuemin'), '25');
        assert.equal(split.handle.getAttribute('aria-valuemax'), '75');
        assert.match(split.handle.getAttribute('aria-valuetext'), /Trip report 49%; summary 51%/);
        assert.ok(split.left.classList.contains('bpb-ascent-table-split__report'));
        assert.ok(split.right.classList.contains('bpb-ascent-table-split__summary'));
        assert.equal(dom.window.document.querySelectorAll('#bpb-ascent-table-split').length, 1);
        assert.equal(Split.mount({
            doc: dom.window.document,
            storage: dom.window.localStorage,
        }), null, 'mounting is idempotent');
    } finally { restore(); }
});

test('unrelated or separated gray tables are left untouched', () => {
    const modern = setup({
        html: '<!doctype html><table class="gray"><tr><td>Trip Report</td></tr></table>',
    });
    try { assert.equal(modern.split, null); }
    finally { modern.restore(); }

    const separated = setup({ html: legacyHtml({ between: '<p>Native content</p>' }) });
    try {
        assert.equal(separated.split, null,
            'moving tables across native intervening content would change page meaning');
    } finally { separated.restore(); }
});

test('pointer dragging resizes both columns and persists once released', () => {
    const { dom, split, restore } = setup();
    try {
        split.wrapper.getBoundingClientRect = () => ({ width: 1013, left: 0, right: 1013 });
        split.handle.dispatchEvent(new dom.window.MouseEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, clientX: 500,
        }));
        split.handle.dispatchEvent(new dom.window.MouseEvent('pointermove', {
            bubbles: true, cancelable: true, clientX: 600,
        }));
        assert.ok(split.leftPercent > 59 && split.leftPercent < 60,
            '100 px of a 1000 px split adds ten percentage points');
        assert.equal(dom.window.localStorage.getItem(Split.storageKey), null,
            'an in-progress gesture is not persisted');
        split.handle.dispatchEvent(new dom.window.MouseEvent('pointerup', {
            bubbles: true, clientX: 600,
        }));
        const saved = JSON.parse(dom.window.localStorage.getItem(Split.storageKey));
        assert.equal(saved.leftPercent, split.leftPercent);
        assert.equal(dom.window.document.documentElement.classList
            .contains('bpb-ascent-table-split-resizing'), false);
    } finally { restore(); }
});

test('Escape cancels an active pointer resize without saving it', () => {
    const { dom, split, restore } = setup();
    try {
        const initial = split.leftPercent;
        split.wrapper.getBoundingClientRect = () => ({ width: 1013, left: 0, right: 1013 });
        split.handle.dispatchEvent(new dom.window.MouseEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, clientX: 500,
        }));
        split.handle.dispatchEvent(new dom.window.MouseEvent('pointermove', {
            bubbles: true, cancelable: true, clientX: 650,
        }));
        assert.notEqual(split.leftPercent, initial);
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        assert.equal(split.leftPercent, initial);
        assert.equal(dom.window.localStorage.getItem(Split.storageKey), null);
        assert.equal(dom.window.document.documentElement.classList
            .contains('bpb-ascent-table-split-resizing'), false);
    } finally { restore(); }
});

test('keyboard resizing is bounded, persisted, and resettable', () => {
    const { dom, split, restore } = setup();
    try {
        split.handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'End', bubbles: true, cancelable: true,
        }));
        assert.equal(split.leftPercent, 75);
        split.handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true,
        }));
        assert.equal(split.leftPercent, 75, 'the summary keeps its 25% minimum');
        split.handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true,
        }));
        assert.equal(split.leftPercent, 70);
        assert.equal(JSON.parse(dom.window.localStorage.getItem(Split.storageKey)).leftPercent, 70);

        split.handle.dispatchEvent(new dom.window.MouseEvent('dblclick', {
            bubbles: true, cancelable: true,
        }));
        assert.ok(split.leftPercent > 49 && split.leftPercent < 50,
            'double-click restores Peakbagger\'s original 49 / 50 ratio');
    } finally { restore(); }
});

test('a saved split is cleaned and restored on the next ascent page', () => {
    const restored = setup({ saved: JSON.stringify({ leftPercent: 68 }) });
    try {
        assert.equal(restored.split.leftPercent, 68);
        assert.equal(restored.split.wrapper.style.getPropertyValue('--bpb-ascent-report-share'), '68fr');
    } finally { restored.restore(); }

    const corrupt = setup({ saved: '{broken' });
    try {
        assert.ok(corrupt.split.leftPercent > 49 && corrupt.split.leftPercent < 50,
            'corrupt storage falls back to the native ratio');
    } finally { corrupt.restore(); }
});
