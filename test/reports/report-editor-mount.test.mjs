// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../helpers/load-page.mjs';
import { loadEditor, editorReady, editors, typeRich, modeButton, DRAFT_KEY } from '../helpers/report-editor-helpers.mjs';

test('the editor mounts on the ascent form and hides the native textarea', async () => {
    const dom = await loadEditor();
    const ui = await editorReady(dom);
    const doc = dom.window.document;

    assert.equal(ui.dataset.mode, 'rich');
    const textarea = doc.getElementById('JournalText');
    assert.ok(textarea.classList.contains('bpb-re-hidden'), 'native textarea should be hidden');
    assert.ok(textarea.form, 'textarea must stay inside the form it submits with');

    // The site's bracket-syntax hint is superseded while the editor is active.
    const hints = [...doc.querySelectorAll('span')].find(s => /Hints:/.test(s.textContent));
    assert.ok(hints.classList.contains('bpb-re-hidden'), 'native hints should be hidden');

    const blockStyle = ui.querySelector('.bpb-re-format');
    assert.deepEqual([...blockStyle.options].map(option => option.textContent), [
        'Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4',
        'Heading 5', 'Heading 6', 'Quote', 'Preformatted'
    ]);
    for (const label of ['Strikethrough', 'Horizontal rule', 'Insert table', 'Insert image', 'Insert video',
        'More formats', 'Undo (Ctrl/Cmd+Z)', 'Redo (Ctrl/Cmd+Shift+Z)']) {
        assert.ok(ui.querySelector(`[aria-label="${label}"]`), `missing toolbar control: ${label}`);
    }
    for (const label of [
        'Bold (Ctrl/Cmd+B)', 'Italic (Ctrl/Cmd+I)', 'Underline (Ctrl/Cmd+U)',
        'Link (Ctrl/Cmd+K)', 'Undo (Ctrl/Cmd+Z)', 'Redo (Ctrl/Cmd+Shift+Z)',
        'Inline code (Ctrl/Cmd+E)', 'Highlight (Ctrl/Cmd+Shift+H)'
    ]) {
        assert.equal(ui.querySelector(`[aria-label="${label}"]`)?.title, label,
            `${label} should be both the accessible name and tooltip`);
    }
    assert.equal(ui.querySelector('.bpb-re-contextual')?.parentElement,
        ui.querySelector('.bpb-re-toolbar'),
        'contextual controls must stay in the toolbar layer, not in the writing surface flow');
    assert.equal(ui.querySelector('.bpb-re-draft')?.parentElement,
        ui.querySelector('.bpb-re-toolbar'),
        'the overlay boundary must include the draft-recovery bar');
    assert.ok(ui.querySelector('.bpb-re-surface'), 'the rich surface should be mounted');
    assert.equal(editors(dom).rich.getHTML(), '<p></p>',
        'an empty report must not become a hard break');
    const emptyParagraph = ui.querySelector('.bpb-re-surface p.is-editor-empty');
    assert.equal(emptyParagraph?.dataset.placeholder, 'Write your trip report…',
        'TipTap should recognize the empty document and expose its placeholder');
    assert.equal(ui.querySelector('[aria-label="Undo (Ctrl/Cmd+Z)"]').disabled, true,
        'undo starts disabled with an empty history');
});

test('the editor always offers the device-wide report drafts manager', async () => {
    const messages = [];
    let release;
    const dom = await loadEditor({
        prepare: d => {
            d.chrome.runtime.sendMessage = message => {
                messages.push(message);
                return new Promise(resolve => { release = resolve; });
            };
        }
    });
    const ui = await editorReady(dom);
    const manage = ui.querySelector('.bpb-re-manage');

    assert.equal(manage?.textContent, 'Manage TR drafts');
    assert.equal(manage?.type, 'button');
    assert.equal(manage?.getAttribute('aria-label'), 'Manage TR drafts');
    manage.click();
    await waitFor(dom, () => manage.disabled && manage.getAttribute('aria-busy') === 'true');
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'OPEN_DRAFTS_MANAGER' }]);
    assert.equal(ui.querySelector('.bpb-re-surface').getAttribute('contenteditable'), 'true',
        'opening the manager must not disable report editing');
    release({ ok: true, tabId: 100 });
    await waitFor(dom, () => !manage.disabled && !manage.hasAttribute('aria-busy'));
    assert.equal(ui.querySelector('.bpb-re-status').textContent, '');
});

test('both report-drafts entry points recover visibly from every messaging failure', async t => {
    const entryPoints = [
        {
            name: 'footer',
            options: {},
            selector: '.bpb-re-manage',
        },
        {
            name: 'draft recovery',
            options: {
                report: 'server copy',
                drafts: {
                    [DRAFT_KEY]: {
                        text: 'different local draft',
                        mode: 'rich',
                        savedAt: Date.now() - 1000,
                    },
                },
            },
            selector: '.bpb-re-draft-manage',
        },
    ];
    for (const entryPoint of entryPoints) {
        await t.test(entryPoint.name, async () => {
            let behavior = () => Promise.resolve(null);
            let calls = 0;
            let feedbackExpiry = null;
            const dom = await loadEditor({
                ...entryPoint.options,
                prepare: d => {
                    const nativeSetTimeout = d.window.setTimeout.bind(d.window);
                    d.window.setTimeout = (callback, delay = 0, ...args) => {
                        if (delay === 6000) {
                            feedbackExpiry = callback;
                            return -6000;
                        }
                        return nativeSetTimeout(callback, delay, ...args);
                    };
                    d.chrome.runtime.sendMessage = message => {
                        calls++;
                        assert.deepEqual(JSON.parse(JSON.stringify(message)),
                            { type: 'OPEN_DRAFTS_MANAGER' });
                        return behavior();
                    };
                },
            });
            const ui = await editorReady(dom);
            if (entryPoint.name === 'draft recovery') {
                await waitFor(dom, () => !ui.querySelector('.bpb-re-draft').hidden);
            }
            const manage = ui.querySelector(entryPoint.selector);
            const failures = [
                () => Promise.resolve({
                    ok: false,
                    error: { code: 'forbidden', message: 'worker detail stays private here' },
                }),
                () => Promise.resolve(null),
                () => Promise.reject(new Error('runtime rejected')),
                () => { throw new Error('runtime threw'); },
            ];
            for (const failure of failures) {
                behavior = failure;
                const expectedCalls = calls + 1;
                manage.click();
                await waitFor(dom, () => calls === expectedCalls
                    && !manage.disabled
                    && /Couldn’t open report drafts/.test(ui.querySelector('.bpb-re-status').textContent));
                assert.equal(manage.hasAttribute('aria-busy'), false);
                assert.equal(ui.querySelector('.bpb-re-surface').getAttribute('contenteditable'), 'true');
                assert.doesNotMatch(ui.querySelector('.bpb-re-status').textContent,
                    /forbidden|worker detail|runtime/);
            }

            assert.equal(typeof feedbackExpiry, 'function');
            feedbackExpiry();
            assert.equal(ui.querySelector('.bpb-re-status').textContent, '',
                'manager failure feedback must expire instead of becoming permanent editor status');

            behavior = () => Promise.resolve({ ok: true, tabId: 100 });
            const expectedCalls = calls + 1;
            manage.click();
            await waitFor(dom, () => calls === expectedCalls && !manage.disabled);
            assert.equal(ui.querySelector('.bpb-re-status').textContent, '');
        });
    }
});

test('opt-in credit leaves blank writing space and links Chrome reports to the Chrome store', async () => {
    const dom = await loadEditor({
        settings: { addReportCredit: true },
        browserAlias: true
    });
    const ui = await editorReady(dom);
    const textarea = dom.window.document.getElementById('JournalText');
    const paragraphs = ui.querySelectorAll('.bpb-re-surface p');
    const credit = paragraphs[1];
    const link = credit.querySelector('a');

    assert.equal(paragraphs[0].textContent, '', 'the report should start with editable writing space');
    assert.equal(editors(dom).rich.state.selection.from, 1, 'the caret should begin before the credit');
    assert.ok(credit.querySelector('small'), 'the credit should read as a quiet footnote');
    assert.ok(credit.querySelector('em'), 'the credit should stay visually secondary');
    assert.equal(link.textContent, 'Better Peakbagger');
    assert.equal(link.href,
        'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn');
    assert.equal(textarea.value,
        '[small][i]Created with [a href="https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn" target="_blank"]Better Peakbagger[/a].[/i][/small]');

    editors(dom).rich.commands.insertContent('Summit day.');
    await waitFor(dom, () => textarea.value.startsWith('Summit day.'));
    assert.match(textarea.value, /^Summit day\.\n\n.*Created with /s,
        'typing at the initial caret should keep the credit as a separate footnote');
    assert.match(textarea.value, /\[small\].*Better Peakbagger.*\[\/small\]/s);
});

test('opt-in credit links Firefox reports to Firefox Add-ons', async () => {
    const dom = await loadEditor({ settings: { addReportCredit: true }, firefox: true });
    const ui = await editorReady(dom);
    const link = ui.querySelector('.bpb-re-surface a');

    assert.equal(link.href, 'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/');
});

test('opt-in credit starts after the caret in Markdown and Plain modes', async () => {
    const markdownDom = await loadEditor({
        settings: { addReportCredit: true, reportEditorMode: 'markdown' }
    });
    await editorReady(markdownDom);
    assert.ok(editors(markdownDom).markdown.getValue().startsWith('\n\n'));
    assert.match(editors(markdownDom).markdown.getValue(),
        /<small>\*Created with <a href="[^"]+" target="_blank">Better Peakbagger<\/a>\.\*<\/small>$/,
        'Markdown mode should expose portable HTML instead of Peakbagger bracket tags');
    assert.doesNotMatch(editors(markdownDom).markdown.getValue(), /\[(?:small|a)\b/i);
    assert.equal(editors(markdownDom).markdown.view.state.selection.main.head, 0);

    const plainDom = await loadEditor({
        settings: { addReportCredit: true, reportEditorMode: 'plain' }
    });
    await editorReady(plainDom);
    const textarea = plainDom.window.document.getElementById('JournalText');
    assert.ok(textarea.value.startsWith('\n\n'));
    assert.equal(textarea.selectionStart, 0);
});

test('credit writing space does not grow across Rich and Markdown mode switches', async () => {
    const dom = await loadEditor({ settings: { addReportCredit: true } });
    await editorReady(dom);
    const doc = dom.window.document;

    modeButton(doc, 'Markdown').click();
    const initialSource = editors(dom).markdown.getValue();
    assert.match(initialSource, /^\n\n<small>/);

    for (let switchIndex = 0; switchIndex < 3; switchIndex++) {
        modeButton(doc, 'Rich text').click();
        modeButton(doc, 'Markdown').click();
        assert.equal(editors(dom).markdown.getValue(), initialSource,
            'a mode round trip must not insert another leading blank line');
    }
});

test('opt-in credit never modifies a non-empty report', async () => {
    const dom = await loadEditor({
        settings: { addReportCredit: true },
        report: 'Existing trip report.'
    });
    await editorReady(dom);

    assert.equal(dom.window.document.getElementById('JournalText').value, 'Existing trip report.');
    assert.equal(editors(dom).rich.getHTML(), '<p>Existing trip report.</p>');
});

test('rich edits sync into the hidden textarea as bracket markup', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    typeRich(dom, '<p>Summit day was <b>windy</b> and <i>cold</i>.</p><ul><li>axe</li><li>rope</li></ul>');
    await waitFor(dom, () => doc.getElementById('JournalText').value.includes('[b]'));
    assert.equal(doc.getElementById('JournalText').value,
        'Summit day was [b]windy[/b] and [i]cold[/i].\n\n[ul][li]axe[/li][li]rope[/li][/ul]');
});

test('an existing bracket report renders into the rich editor', async () => {
    const dom = await loadEditor({ report: 'Went [b]up high[/b].\r\n\r\n- snow to 6k' });
    await editorReady(dom);
    // TipTap canonical form: strong for bold, list items wrap a paragraph,
    // and the trailing-node extension keeps a final empty paragraph so there
    // is always somewhere to click below block content (the converter drops
    // it on serialization).
    assert.equal(editors(dom).rich.getHTML(),
        '<p>Went <strong>up high</strong>.</p><ul><li><p>snow to 6k</p></li></ul><p></p>');
});

test('a pending rich edit is flushed synchronously when any submit control is clicked', async () => {
    const dom = await loadEditor();
    await editorReady(dom);
    const doc = dom.window.document;

    // Edit and immediately click GPS Preview — inside the debounce window.
    typeRich(dom, '<p>typed right before preview</p>');
    doc.getElementById('GPXPreview').click();
    assert.equal(doc.getElementById('JournalText').value, 'typed right before preview');
});

test('backup snapshots are captured only for Save or implicit form submissions', async () => {
    const loadWithMessages = async () => {
        const messages = [];
        const dom = await loadEditor({
            settings: { enableGithubBackup: true },
            prepare: d => {
                d.chrome.runtime.getManifest = () => ({ version: '1.2.3' });
                d.chrome.runtime.sendMessage = async message => { messages.push(message); };
            }
        });
        await editorReady(dom);
        return { dom, messages };
    };

    const explicit = await loadWithMessages();
    explicit.dom.window.document.getElementById('GPXPreview').click();
    assert.equal(explicit.messages.filter(message => message.type === 'GITHUB_BACKUP_SNAPSHOT').length, 0,
        'GPS Preview must not snapshot a form state that was never saved');

    explicit.dom.window.document.getElementById('SaveButton').click();
    assert.equal(explicit.messages.filter(message => message.type === 'GITHUB_BACKUP_SNAPSHOT').length, 1,
        'clicking Save must capture a backup snapshot');
    explicit.dom.window.close();

    const implicit = await loadWithMessages();
    implicit.dom.window.document.getElementById('JournalText').form.dispatchEvent(
        new implicit.dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })
    );
    assert.equal(implicit.messages.filter(message => message.type === 'GITHUB_BACKUP_SNAPSHOT').length, 1,
        'an implicit submission must capture a backup snapshot');
    implicit.dom.window.close();
});

test('Add and Edit saves capture the identities used by the backup handoff even when the editor is disabled', async () => {
    const capture = async ({ url, saveId, peakId }) => {
        const messages = [];
        const dom = await loadEditor({
            url,
            settings: { enableReportEditor: false, enableGithubBackup: true },
            prepare: d => {
                const doc = d.window.document;
                doc.getElementById('DateText').value = '2026-07-12';
                doc.getElementById('JournalText').value = '[b]Saved report[/b]';
                if (peakId) {
                    const option = doc.createElement('option');
                    option.value = String(peakId);
                    option.textContent = 'Selected Peak';
                    doc.getElementById('PeakListBox').append(option);
                    doc.getElementById('PeakListBox').value = String(peakId);
                }
                d.chrome.runtime.sendMessage = async message => { messages.push(message); };
            },
        });
        await new Promise(resolve => dom.window.setTimeout(resolve, 10));
        assert.equal(dom.window.document.getElementById('bpb-report-editor'), null,
            'snapshot capture must not depend on the enhanced editor UI');
        dom.window.document.getElementById(saveId).click();
        await waitFor(dom, () => messages.some(message => message.type === 'GITHUB_BACKUP_SNAPSHOT'));
        const message = messages.find(candidate => candidate.type === 'GITHUB_BACKUP_SNAPSHOT');
        dom.window.close();
        return message;
    };

    const added = await capture({
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001&pid=2296',
        saveId: 'SaveButton',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(added.identity)), {
        climberId: 900001, ascentId: null, peakId: 2296, date: '2026-07-12',
    });
    assert.equal(added.snapshot.report.markdown, '**Saved report**');

    const edited = await capture({
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001&aid=7654321',
        saveId: 'SaveButton2',
        peakId: 875,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(edited.identity)), {
        climberId: 900001, ascentId: 7654321, peakId: 875, date: '2026-07-12',
    });
    assert.equal(edited.snapshot.ascent.id, 7654321);
    assert.equal(edited.snapshot.report.markdown, '**Saved report**');
});

