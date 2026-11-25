// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { webdriverScript } from '../../scripts/page-probes.mts';
import {
    readRichTableCellSelection, readRichTableInput, waitForRichTableCellSelection, waitForRichTableInput,
} from '../../scripts/report-table-selection.mts';

type PageFunction = (...args: never[]) => unknown;
// The slice of the TipTap editor the selection probe reads from the surface.
interface EditorStub {
    state: { selection: { empty: boolean; $from: { depth: number; node: () => { type: { name: string } }; before: () => number } } };
    view: { nodeDOM: () => Element };
}

// Runs a WebDriver-style script body in a fresh realm whose free names are
// the given page objects, as executeScript does in the verifier's browser.
const realms: FixtureDom[] = [];
test.afterEach(() => { for (const realm of realms.splice(0)) realm.window.close(); });
const runScript = (body: string, names: Record<string, unknown>) => {
    const realm = new FixtureDom('', { takeFocus: false });
    realms.push(realm);
    return realm.window.Function(...Object.keys(names), body)(...Object.values(names));
};

test('table input waits for the editor selection, rather than only the native caret', async () => {
    const dom = new FixtureDom('<div class="bpb-re-surface" tabindex="0"><table><tr><td><p></p></td><td><p></p></td></tr></table></div>');
    try {
        const document = dom.window.document;
        const surface = document.querySelector('.bpb-re-surface') as unknown as HTMLElement & { editor?: EditorStub };
        const cells = [...surface.querySelectorAll('td')];
        let modelCell: Element = cells[1]!;
        surface.editor = { state: { selection: { empty: true, $from: {
            depth: 2, node: () => ({ type: { name: 'tableCell' } }), before: () => 1,
        } } }, view: { nodeDOM: () => modelCell } };
        surface.focus();
        const range = document.createRange(); range.setStart(cells[0]!.firstElementChild!, 0); range.collapse(true);
        dom.window.getSelection()!.removeAllRanges();
        dom.window.getSelection()!.addRange(range);
        const evaluate = (fn: PageFunction, arg?: unknown) => runScript(webdriverScript(fn, arg), {
            chrome: { scripting: { executeScript: async ({ target, world, func, args }:
                { target: { tabId: number }; world: string; func: PageFunction; args: unknown[] }) => {
                assert.equal(target.tabId, 77); assert.equal(world, 'ISOLATED');
                return [{ result: runScript(webdriverScript(func, ...args), { document, window: dom.window }) }];
            } } },
        });
        const read = () => evaluate(readRichTableCellSelection, { tabId: 77, cellIndex: 0 });
        const pending = await read();
        assert.equal(pending.nativeCell, 0);
        assert.equal(pending.editorCell, 1);
        assert.equal(pending.ready, false, 'a moved browser caret cannot prove the toolbar will use that cell');
        let reads = 0;
        const state = await waitForRichTableCellSelection({ evaluate: async (fn, arg) => {
            if (++reads === 3) modelCell = cells[0]!;
            return evaluate(fn, arg);
        } }, 77, 0, { intervalMs: 1 });
        assert.equal(state.ready, true);
        assert.equal(reads, 3);
        surface.blur();
        const blurred = await read();
        assert.equal(blurred.focused, false);
        assert.equal(blurred.ready, false, 'typing requires editor focus too');
        surface.focus(); dom.window.getSelection()!.removeAllRanges(); dom.window.getSelection()!.addRange(range);
        surface.editor!.state.selection.empty = false;
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
        // Invalid targets on purpose.
        assert.throws(() => waitForRichTableCellSelection(null, tabId as number, cell as number), /tab ID.*cell index/);
    }
    await assert.rejects(waitForRichTableCellSelection({ evaluate: async () => ({
        nativeCell: 0, editorCell: 1, focused: true, ready: false,
    }) }, 77, 0, { timeoutMs: 0, intervalMs: 1 }), /cell 1.*editorCell.*1/);
});

test('table conversion waits for correctly typed cells and the submitted source, then stops on malformed input', async () => {
    const dom = new FixtureDom('<textarea id="JournalText"></textarea><div class="bpb-re-surface"><table><tr>'
        + '<td><ul><li>Standard TH</li><li>Outhouse TH</li></ul></td>'
        + '<td><ol><li>Park</li><li>Walk</li></ol></td></tr></table></div>');
    try {
        const document = dom.window.document;
        const evaluate = (fn: PageFunction) => runScript(webdriverScript(fn), { document });
        const cells = [{ bullets: ['Standard TH', 'Outhouse TH'], numbers: [] },
            { bullets: [], numbers: ['Park', 'Walk'] }];
        const expected = { saved: 'the exact saved table', cells };
        assert.deepEqual(JSON.parse(JSON.stringify(evaluate(readRichTableInput))), { saved: '', cells });
        let reads = 0;
        await waitForRichTableInput({ evaluate: fn => {
            if (++reads === 3) document.getElementById('JournalText').value = expected.saved;
            return evaluate(fn);
        } }, expected, { intervalMs: 1 });
        assert.equal(reads, 3, 'painted lists alone cannot prove the submission value is ready');
        document.querySelectorAll('td')[0].innerHTML = '';
        document.querySelectorAll('td')[1].innerHTML = '<ol><li>Standard TH</li><li>OuthPark</li><li>Walkouse TH</li></ol>';
        let conversionAttempted = false;
        await assert.rejects((async () => {
            await waitForRichTableInput({ evaluate }, expected, { timeoutMs: 100, intervalMs: 1 });
            conversionAttempted = true;
        })(), /typed Rich table fixture before switching editor modes.*OuthPark/s);
        assert.equal(conversionAttempted, false, 'the reproduced wrong-cell input cannot poison subsequent conversion checks');
    } finally { dom.window.close(); }
});
