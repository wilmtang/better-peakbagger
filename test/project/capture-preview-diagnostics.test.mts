/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from '../helpers/test-dom.mts';
import { captureProfileCount, installPreviewProbe, sanitizePreviewEvent } from '../../scripts/capture-preview-diagnostics.mts';

test('capture fresh profiles reject unknown, duplicate, zero and fractional selections', () => {
    assert.equal(captureProfileCount([]), 1);
    assert.equal(captureProfileCount(['--fresh-profiles', '3']), 3);
    for (const args of [['--fresh-profiles', '0'], ['--fresh-profiles', '6'], ['--fresh-profiles', '1.5'], ['--other', '3'], ['--fresh-profiles'], ['--fresh-profiles', '3', '--fresh-profiles', '3']]) assert.throws(() => captureProfileCount(args), /Usage/);
});

test('native probe records prevented Preview and invalid controls without private values', async () => {
    const dom = new JSDOM('<form><input id="private" value="PRIVATE_SENTINEL" required><input id="GPXUpload" type="file"><button id="GPXPreview" type="button">Preview</button></form>',
        { url: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=PRIVATE_QUERY', runScripts: 'outside-only' });
    try {
        const events: unknown[] = [];
        dom.window.__bpbRecordPreview = (value: unknown) => { events.push(value); return Promise.resolve(); };
        dom.window.eval(`(${installPreviewProbe.toString()})()`);
        const preview = dom.window.document.getElementById('GPXPreview')!;
        preview.addEventListener('click', event => event.preventDefault());
        preview.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
        dom.window.document.getElementById('private')!.dispatchEvent(new dom.window.Event('invalid'));
        await new Promise<void>(resolve => queueMicrotask(resolve));
        assert.deepEqual(JSON.parse(JSON.stringify(events)), [
            { kind: 'click', prevented: true, connected: true, disabled: false, files: 0 },
            { kind: 'invalid', prevented: false, connected: true, disabled: false, files: 0 },
        ]);
        for (let i = 0; i < 100; i++) preview.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await new Promise<void>(resolve => queueMicrotask(resolve));
        assert.equal(events.length, 64);
        assert.doesNotMatch(JSON.stringify(events), /PRIVATE|private|cid|filename|value/);
    } finally { dom.window.close(); }
});


test('binding sanitizer rejects unknown kinds and retains no extra private fields', () => {
    const known = { kind: 'submit', prevented: false, connected: true, disabled: false, files: 1 };
    assert.deepEqual(sanitizePreviewEvent({ ...known, url: 'PRIVATE', value: 'PRIVATE', filename: 'PRIVATE' }), known);
    for (const input of [null, 'PRIVATE', { ...known, kind: 'PRIVATE' }, { ...known, kind: ['click'] }, { ...known, files: Infinity },
        { ...known, files: 11 }, { ...known, connected: 'PRIVATE' }, { ...known, files: -1 }]) assert.equal(sanitizePreviewEvent(input), null);
});
