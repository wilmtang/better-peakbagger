// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../helpers/load-page.mjs';
import { loadEditor, editorReady, editors, typeRich, typeMarkdown, modeButton, DRAFT_KEY } from '../helpers/report-editor-helpers.mjs';

test('edits autosave a local draft keyed to this climber and form', async () => {
    const dom = await loadEditor({
        accelerateAutosave: true,
        prepare: d => {
            const doc = d.window.document;
            const select = doc.getElementById('PeakListBox');
            const option = doc.createElement('option');
            option.value = '1234';
            option.textContent = 'Glacier Peak';
            select.append(option);
            select.value = '1234';
            doc.getElementById('DateText').value = '7/12/2026';
        }
    });
    await editorReady(dom);

    typeRich(dom, '<p>autosave me</p>');
    await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]);
    const draft = dom.chrome._localStore[DRAFT_KEY];
    assert.equal(draft.text, 'autosave me');
    assert.equal(draft.mode, 'rich');
    assert.equal(typeof draft.savedAt, 'number');
    assert.deepEqual([...new Set(dom.autosaveDelays)], [800]);
    assert.deepEqual(JSON.parse(JSON.stringify(draft.label)), { peak: 'Glacier Peak', date: '7/12/2026' });
    assert.match(dom.window.document.querySelector('.bpb-re-status').textContent,
        /Draft saved on this device · \d{1,2}:\d{2}:\d{2}(?:\s[AP]M)?$/);
});

test('autosave does not depend on the optional peak label control', async () => {
    const dom = await loadEditor({
        accelerateAutosave: true,
        prepare: d => d.window.document.getElementById('PeakListBox').remove()
    });
    await editorReady(dom);

    typeRich(dom, '<p>safe without a peak select</p>');
    await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]);
    const draft = dom.chrome._localStore[DRAFT_KEY];
    assert.equal(draft.text, 'safe without a peak select');
    assert.equal(draft.label?.peak, undefined);
});

test('page exit removes whitespace-only reports instead of retaining a draft', async () => {
    for (const reportEditorMode of ['rich', 'markdown']) {
        const dom = await loadEditor({
            settings: { reportEditorMode },
            report: ' \r\n\t \n',
            drafts: {
                [DRAFT_KEY]: { text: 'older recovery copy', mode: reportEditorMode, savedAt: Date.now() }
            }
        });
        await editorReady(dom);

        dom.window.dispatchEvent(new dom.window.Event('pagehide'));
        await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
        assert.equal(dom.window.document.querySelector('.bpb-re-status').textContent, '',
            `${reportEditorMode} should not report an empty draft as saved`);
    }
});

test('page exit removes an untouched generated-credit-only draft in Rich and Markdown modes', async () => {
    for (const reportEditorMode of ['rich', 'markdown']) {
        const dom = await loadEditor({
            settings: { addReportCredit: true, reportEditorMode },
            drafts: {
                [DRAFT_KEY]: { text: 'older recovery copy', mode: reportEditorMode, savedAt: Date.now() }
            }
        });
        await editorReady(dom);

        dom.window.dispatchEvent(new dom.window.Event('pagehide'));
        await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
        assert.equal(dom.window.document.querySelector('.bpb-re-status').textContent, '',
            `${reportEditorMode} should not report a credit scaffold as saved`);
    }
});

test('Rich autosave keeps content plus the generated credit, then removes the credit-only remainder', async () => {
    const dom = await loadEditor({ settings: { addReportCredit: true }, accelerateAutosave: true });
    await editorReady(dom);
    const creditOnlyHtml = editors(dom).rich.getHTML();

    typeRich(dom, `<p>Recover this report.</p>${creditOnlyHtml}`);
    await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]);
    assert.match(dom.chrome._localStore[DRAFT_KEY].text, /^Recover this report\./);

    typeRich(dom, creditOnlyHtml);
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(dom.window.document.querySelector('.bpb-re-status').textContent, '');
});

test('Markdown autosave keeps content plus the generated credit, then removes the credit-only remainder', async () => {
    const dom = await loadEditor({
        settings: { addReportCredit: true, reportEditorMode: 'markdown' },
        accelerateAutosave: true
    });
    await editorReady(dom);
    const creditOnlySource = editors(dom).markdown.getValue();

    typeMarkdown(dom, `Recover this report.\n\n${creditOnlySource}`);
    await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(dom.chrome._localStore[DRAFT_KEY].source, `Recover this report.\n\n${creditOnlySource}`);

    typeMarkdown(dom, ` \n\n${creditOnlySource}\n\t`);
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(dom.window.document.querySelector('.bpb-re-status').textContent, '');
});

test('a differing stored draft offers management, and Restore applies it in its saved mode', async () => {
    const messages = [];
    const dom = await loadEditor({
        report: 'server copy',
        drafts: {
            [DRAFT_KEY]: {
                text: 'draft copy with **md**',
                source: 'draft copy with **md**',
                mode: 'markdown',
                savedAt: Date.now() - 60000
            }
        },
        prepare: d => { d.chrome.runtime.sendMessage = async message => { messages.push(message); }; }
    });
    await editorReady(dom);
    const doc = dom.window.document;

    const draftBar = doc.querySelector('.bpb-re-draft');
    assert.equal(draftBar.hidden, false, 'the draft offer should be visible');
    const actions = [...draftBar.querySelectorAll('button')];
    assert.deepEqual(actions.map(button => button.textContent), [
        'Restore draft', 'Delete draft', 'Manage drafts'
    ]);
    actions[2].click();
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'OPEN_DRAFTS_MANAGER' }]);

    actions[0].click();
    assert.equal(doc.getElementById('bpb-report-editor').dataset.mode, 'markdown');
    assert.equal(editors(dom).markdown.getValue(), 'draft copy with **md**');
    assert.equal(doc.getElementById('JournalText').value, 'draft copy with **md**');
});

test('Delete draft removes it without touching the form content', async () => {
    const dom = await loadEditor({
        report: 'server copy',
        drafts: { [DRAFT_KEY]: { text: 'stale draft', mode: 'rich', savedAt: Date.now() - 1000 } }
    });
    await editorReady(dom);
    const doc = dom.window.document;

    const draftBar = doc.querySelector('.bpb-re-draft');
    [...draftBar.querySelectorAll('button')].find(b => b.textContent === 'Delete draft').click();
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(draftBar.hidden, true);
    assert.equal(doc.getElementById('JournalText').value, 'server copy');
});

test('a draft equal to the server copy is not offered; its markdown source is adopted', async () => {
    const dom = await loadEditor({
        report: 'Same [b]content[/b].\r\n\r\n- item',   // server echo with CRLF
        drafts: {
            [DRAFT_KEY]: {
                text: 'Same [b]content[/b].\n\n- item',
                source: 'Same **content**.\n\n- item',
                mode: 'markdown',
                savedAt: Date.now() - 1000
            }
        }
    });
    await editorReady(dom);
    const doc = dom.window.document;
    assert.equal(doc.querySelector('.bpb-re-draft').hidden, true);

    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Same **content**.\n\n- item');
});

test('a whitespace-only stored draft is deleted instead of silently retained', async () => {
    const dom = await loadEditor({
        drafts: { [DRAFT_KEY]: { text: ' \r\n\t ', mode: 'rich', savedAt: Date.now() - 1000 } }
    });
    await editorReady(dom);

    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    assert.equal(dom.window.document.querySelector('.bpb-re-draft').hidden, true);
});

for (const saveId of ['SaveButton', 'SaveButton2']) {
    test(`${saveId} clears the draft and page exit cannot recreate it`, async () => {
        const report = 'about to be saved';
        const dom = await loadEditor({
            report,
            drafts: { [DRAFT_KEY]: { text: report, mode: 'rich', savedAt: Date.now() } }
        });
        await editorReady(dom);

        dom.window.document.getElementById(saveId).click();
        dom.window.dispatchEvent(new dom.window.Event('pagehide'));
        await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
        await new Promise(resolve => dom.window.setTimeout(resolve, 20));

        assert.equal(dom.chrome._localStore[DRAFT_KEY], undefined);
        dom.window.close();
    });
}

test('an implicit Save submission clears the draft and page exit cannot recreate it', async () => {
    const report = 'save by pressing Enter';
    const dom = await loadEditor({
        report,
        drafts: { [DRAFT_KEY]: { text: report, mode: 'rich', savedAt: Date.now() } }
    });
    await editorReady(dom);
    const form = dom.window.document.getElementById('JournalText').form;

    form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));

    assert.equal(dom.chrome._localStore[DRAFT_KEY], undefined);
    dom.window.close();
});

test('a Save cancels a pending autosave timer and rejects even a late callback', async () => {
    const AUTOSAVE_TIMER_ID = 8675309;
    let autosaveCallback;
    let autosaveCancelled = false;
    const dom = await loadEditor({
        prepare: d => {
            const originalSetTimeout = d.window.setTimeout.bind(d.window);
            const originalClearTimeout = d.window.clearTimeout.bind(d.window);
            d.window.setTimeout = (callback, delay = 0, ...args) => {
                if (delay === 800) {
                    autosaveCallback = () => callback(...args);
                    return AUTOSAVE_TIMER_ID;
                }
                return originalSetTimeout(callback, delay, ...args);
            };
            d.window.clearTimeout = timer => {
                if (timer === AUTOSAVE_TIMER_ID) {
                    autosaveCancelled = true;
                    return;
                }
                originalClearTimeout(timer);
            };
        }
    });
    await editorReady(dom);

    typeRich(dom, '<p>timer still pending</p>');
    await waitFor(dom, () => autosaveCallback);
    dom.window.document.getElementById('SaveButton').click();
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    autosaveCallback(); // Simulate a queued callback delivered despite cancellation.
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));

    assert.equal(autosaveCancelled, true);
    assert.equal(dom.chrome._localStore[DRAFT_KEY], undefined);
    dom.window.close();
});

test('a Save removes multiple in-flight autosaves even when they finish out of order', async () => {
    const releases = [];
    const completions = [];
    let cleanupCount = 0;
    const dom = await loadEditor({
        accelerateAutosave: true,
        prepare: d => {
            const originalSet = d.chrome.storage.local.set;
            const originalRemove = d.chrome.storage.local.remove;
            d.chrome.storage.local.set = async patch => {
                const index = releases.length;
                await new Promise(resolve => { releases[index] = resolve; });
                await originalSet(patch);
                completions.push(index);
            };
            d.chrome.storage.local.remove = async key => {
                await originalRemove(key);
                if (completions.length) cleanupCount++;
            };
        }
    });
    await editorReady(dom);

    typeRich(dom, '<p>first in-flight write</p>');
    await waitFor(dom, () => releases.length === 1);
    typeRich(dom, '<p>second in-flight write</p>');
    await waitFor(dom, () => releases.length === 2);
    dom.window.document.getElementById('SaveButton').click();
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));

    releases[1]();
    await waitFor(dom, () => cleanupCount === 1);
    releases[0]();
    await waitFor(dom, () => cleanupCount === 2);
    assert.deepEqual(completions, [1, 0]);
    assert.equal(dom.chrome._localStore[DRAFT_KEY], undefined);
    dom.window.close();
});

test('a named non-Save submission keeps page-exit draft recovery active', async () => {
    const dom = await loadEditor({ report: 'keep this after cancelling' });
    await editorReady(dom);
    const doc = dom.window.document;
    const form = doc.getElementById('JournalText').form;

    form.dispatchEvent(new dom.window.SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: doc.getElementById('CancelButton')
    }));
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await waitFor(dom, () => dom.chrome._localStore[DRAFT_KEY]);

    assert.equal(dom.chrome._localStore[DRAFT_KEY].text, 'keep this after cancelling');
    dom.window.close();
});

test('expired and excess drafts are pruned, current key kept', async () => {
    const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const dom = await loadEditor({
        drafts: {
            'bpbReportDraft:900001:a1': { text: 'ancient', mode: 'rich', savedAt: old },
            'bpbReportDraft:900001:a2': { text: 'recent other', mode: 'rich', savedAt: Date.now() - 5000 }
        }
    });
    await editorReady(dom);
    await waitFor(dom, () => !dom.chrome._localStore['bpbReportDraft:900001:a1']);
    assert.ok(dom.chrome._localStore['bpbReportDraft:900001:a2'], 'fresh drafts must survive pruning');
});

test('the editor stays out of the way when disabled in settings', async () => {
    const dom = await loadEditor({ settings: { enableReportEditor: false } });
    await new Promise(resolve => setTimeout(resolve, 120));
    const doc = dom.window.document;
    assert.equal(doc.getElementById('bpb-report-editor'), null);
    assert.equal(doc.getElementById('JournalText').classList.contains('bpb-re-hidden'), false);
});

test('page exit cannot write a mode-less draft while the editor is disabled', async () => {
    const dom = await loadEditor({
        settings: { enableReportEditor: false },
        report: 'Peakbagger owns this native report.'
    });
    await new Promise(resolve => setTimeout(resolve, 120));

    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.chrome._localStore[DRAFT_KEY], undefined);
});

test('disabling the setting live hands the form back to the native textarea', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    const current = dom.chrome._store.bpbSettings || {};
    await dom.chrome.storage.sync.set({ bpbSettings: { ...current, enableReportEditor: false } });
    await waitFor(dom, () => !doc.getElementById('bpb-report-editor'));
    assert.equal(doc.getElementById('JournalText').classList.contains('bpb-re-hidden'), false);
});

test('draft keys distinguish editing an ascent from adding one', async () => {
    const dom = await loadEditor({
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=123456&cid=900001',
        accelerateAutosave: true
    });
    await editorReady(dom);
    typeRich(dom, '<p>edit of an existing ascent</p>');
    await waitFor(dom, () => dom.chrome._localStore['bpbReportDraft:900001:a123456']);
});
