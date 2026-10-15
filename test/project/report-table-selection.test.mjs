// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { webdriverScript } from '../../scripts/browser-verification-fixtures.mjs';
import { readRichTableCellSelection, waitForRichTableCellSelection } from '../../scripts/report-table-selection.mjs';

test('table input waits for the editor selection, rather than only the native caret', async () => {
    const dom = new JSDOM('<div class="bpb-re-surface" tabindex="0"><table><tr><td><p></p></td><td><p></p></td></tr></table></div>');
    try {
        const document = dom.window.document, surface = document.querySelector('.bpb-re-surface');
        const cells = [...surface.querySelectorAll('td')];
        let modelCell = cells[1];
        surface.editor = { state: { selection: { empty: true, $from: {
            depth: 2, node: () => ({ type: { name: 'tableCell' } }), before: () => 1,
        } } }, view: { nodeDOM: () => modelCell } };
        surface.focus();
        const range = document.createRange(); range.setStart(cells[0].firstElementChild, 0); range.collapse(true);
        dom.window.getSelection().removeAllRanges();
        dom.window.getSelection().addRange(range);
        const evaluate = (fn, arg) => vm.runInNewContext(`(() => { ${webdriverScript(fn, arg)} })()`, {
            chrome: { scripting: { executeScript: async ({ target, world, func, args }) => {
                assert.equal(target.tabId, 77); assert.equal(world, 'ISOLATED');
                return [{ result: vm.runInNewContext(`(() => { ${webdriverScript(func, ...args)} })()`, {
                    document, window: dom.window,
                }) }];
            } } },
        });
        const read = () => evaluate(readRichTableCellSelection, { tabId: 77, cellIndex: 0 });
        const pending = await read();
        assert.equal(pending.nativeCell, 0);
        assert.equal(pending.editorCell, 1);
        assert.equal(pending.ready, false, 'a moved browser caret cannot prove the toolbar will use that cell');
        let reads = 0;
        const state = await waitForRichTableCellSelection({ evaluate: async (fn, arg) => {
            if (++reads === 3) modelCell = cells[0];
            return evaluate(fn, arg);
        } }, 77, 0, { intervalMs: 1 });
        assert.equal(state.ready, true);
        assert.equal(reads, 3);
        surface.blur();
        const blurred = await read();
        assert.equal(blurred.focused, false);
        assert.equal(blurred.ready, false, 'typing requires editor focus too');
        surface.focus(); dom.window.getSelection().removeAllRanges(); dom.window.getSelection().addRange(range);
        surface.editor.state.selection.empty = false;
        const selected = await read();
        assert.equal(selected.nativeCell, 0);
        assert.equal(selected.collapsed, false);
        assert.equal(selected.ready, false, 'a selected cell must not be treated as an insertion caret');
        delete surface.editor;
        assert.equal((await read()).ready, false, 'missing editor state never counts as readiness');
    } finally { dom.window.close(); }
});

test('table selection rejects invalid targets and reports live state when it never settles', async () => {
    for (const [tabId, cell] of [[null, 0], [77, -1], [77, 0.5]]) {
        assert.throws(() => waitForRichTableCellSelection(null, tabId, cell), /tab ID.*cell index/);
    }
    await assert.rejects(waitForRichTableCellSelection({ evaluate: async () => ({
        nativeCell: 0, editorCell: 1, focused: true, ready: false,
    }) }, 77, 0, { timeoutMs: 0, intervalMs: 1 }), /cell 1.*editorCell.*1/);
});
