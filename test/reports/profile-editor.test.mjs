// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';
import { editorReady, editors, typeRich, typeMarkdown, modeButton } from '../helpers/report-editor-helpers.mjs';

const loadProfile = async (t, { text = '', settings = {}, prepare, url } = {}) => {
    const dom = await loadPage('climber-climberedit.html', {
        url: url || 'https://www.peakbagger.com/climber/climberedit.aspx?cid=900001',
        fixtures: PAGE_FIXTURES,
        bundles: ['content/theme.js', 'vendor/marked.umd.js', 'content/profile-editor.js'],
        settings,
        prepare: d => {
            d.window.document.getElementById('ClimberText').defaultValue = text;
            d.window.document.getElementById('ClimberText').value = text;
            prepare?.(d);
        },
    });
    t.after(() => dom.window.close());
    return dom;
};

test('profile biography mounts the shared editor in its native form with profile names', async t => {
    const dom = await loadProfile(t);
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    const textarea = doc.getElementById('ClimberText');
    assert.equal(ui.dataset.mode, 'rich');
    assert.ok(ui.classList.contains('bpb-re-profile'));
    assert.equal(textarea.form.id, 'Form1');
    assert.equal(textarea.name, 'ClimberText');
    assert.ok(textarea.classList.contains('bpb-re-hidden'));
    assert.ok(doc.getElementById('native-hints').classList.contains('bpb-re-hidden'));
    assert.equal(ui.querySelector('[role="toolbar"]').getAttribute('aria-label'), 'Climber biography formatting');
    assert.equal(ui.querySelector('.bpb-re-surface').getAttribute('aria-label'), 'Climber biography');
    assert.equal(ui.querySelector('.bpb-re-surface p').dataset.placeholder, 'Write your biography…');
    assert.equal(ui.querySelector('.bpb-re-preview').getAttribute('aria-label'), 'Live preview of the saved climber biography');
    assert.equal(ui.querySelector('.bpb-re-manage'), null);
    assert.equal(ui.querySelector('.bpb-re-local-photo-status'), null);
    assert.equal(ui.querySelector('.bpb-re-photo-launch'), null);
});

test('profile rich edits flush before native Save and other account postbacks', async t => {
    const dom = await loadProfile(t, { text: 'Existing [b]biography[/b]' });
    await editorReady(dom);
    const doc = dom.window.document;
    const textarea = doc.getElementById('ClimberText');
    assert.match(editors(dom).rich.getHTML(), /<strong>biography<\/strong>/);
    let submitted;
    textarea.form.addEventListener('submit', event => {
        event.preventDefault();
        submitted = new dom.window.FormData(textarea.form);
    });
    typeRich(dom, '<p>I enjoy <strong>mountains</strong>.</p>');
    doc.getElementById('CreateUpdateAccount').click();
    assert.equal(submitted.get('ClimberText'), 'I enjoy [b]mountains[/b].');
    assert.equal(submitted.get('NewEmail'), 'fixture@example.invalid');
    assert.equal(submitted.get('NewPassword'), '');
    assert.equal(submitted.get('NewFirstName'), 'Fixture');
    assert.equal(submitted.get('RecentAscentCheckbox'), 'on');
    typeRich(dom, '<p>Before a country postback</p>');
    doc.getElementById('NationDD').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(textarea.value, 'Before a country postback');
    typeRich(dom, '<p>Implicit save</p>');
    textarea.form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
    assert.equal(submitted.get('ClimberText'), 'Implicit save');
});

test('biography text mentioning Hints never hides the editor host as a native hint', async t => {
    const dom = await loadProfile(t, { text: 'Hints: these are my favorite climbs.' });
    const ui = await editorReady(dom);
    assert.equal(ui.parentElement.classList.contains('bpb-re-hidden'), false);
    assert.ok(dom.window.document.getElementById('native-hints').classList.contains('bpb-re-hidden'));
});

test('profile Markdown and Plain modes share the original biography field', async t => {
    const dom = await loadProfile(t, { text: 'Existing [b]biography[/b]' });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    modeButton(doc, 'Markdown').click();
    assert.equal(editors(dom).markdown.getValue(), 'Existing **biography**');
    typeMarkdown(dom, 'I enjoy **ridges** and [trails](https://example.com/).');
    await waitFor(dom, () => ui.querySelector('.bpb-re-preview b')?.textContent === 'ridges');
    modeButton(doc, 'Plain').click();
    const textarea = doc.getElementById('ClimberText');
    assert.match(textarea.value, /\[b\]ridges\[\/b\]/);
    assert.equal(textarea.classList.contains('bpb-re-hidden'), false);
    assert.equal(doc.getElementById('native-hints').classList.contains('bpb-re-hidden'), false);
    textarea.value = 'My [i]biography[/i]';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    modeButton(doc, 'Rich text').click();
    assert.equal(editors(dom).rich.getHTML(), '<p>My <em>biography</em></p>');
    assert.equal(textarea.value, 'My [i]biography[/i]');
});

test('unsupported profile markup including hidden blocks is preserved until explicit conversion', async t => {
    const text = 'Creator of [a href="https://example.com/"]a project[/a]\n\n'
        + '[div style="visibility:hidden"][b]Find me[/b][ul][li]A link[/li][/ul][/div]';
    const dom = await loadProfile(t, { text });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    assert.equal(ui.dataset.mode, 'plain');
    assert.equal(doc.getElementById('ClimberText').value, text);
    assert.match(ui.querySelector('.bpb-re-conversion-text').textContent, /^This biography uses markup/);
    modeButton(doc, 'Rich text').click();
    assert.equal(ui.dataset.mode, 'plain');
    assert.equal(doc.getElementById('ClimberText').value, text);
    modeButton(doc, 'Markdown').click();
    assert.equal(ui.dataset.mode, 'plain');
    assert.equal(doc.getElementById('ClimberText').value, text);
});

test('profile edits never read or overwrite ascent drafts, upload photos, or snapshot account fields', async t => {
    const messages = [];
    const key = 'bpbReportDraft:900001:new';
    const draft = { text: 'Unrelated ascent report', mode: 'rich', savedAt: Date.now() };
    let autosaveTimers = 0;
    let localReads = 0;
    const dom = await loadProfile(t, {
        settings: { addReportCredit: true, enableGithubBackup: true },
        prepare: d => {
            d.chrome._localStore[key] = draft;
            d.chrome.storage.local.get = async () => { localReads++; throw new Error('Profile must not read local report drafts'); };
            d.chrome.runtime.sendMessage = async message => { messages.push(message); return { ok: true }; };
            const nativeTimeout = d.window.setTimeout.bind(d.window);
            d.window.setTimeout = (callback, delay, ...args) => {
                if (delay === 800) autosaveTimers++;
                return nativeTimeout(callback, delay, ...args);
            };
        },
    });
    const ui = await editorReady(dom);
    const doc = dom.window.document;
    assert.equal(doc.getElementById('ClimberText').value, '', 'report credit must not seed biographies');
    assert.equal(ui.querySelector('.bpb-re-draft').hidden, true);
    typeRich(dom, '<p>New biography</p>');
    doc.getElementById('ClimberText').form.addEventListener('submit', event => event.preventDefault());
    doc.getElementById('CreateUpdateAccount').click();
    doc.getElementById('ClimberText').form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }));
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.deepEqual(messages, [], 'no draft, backup, or photo request should leave a profile editor');
    assert.equal(localReads, 0);
    assert.equal(autosaveTimers, 0);
    assert.equal(dom.chrome._localStore[key], draft);
    assert.equal(ui.querySelector('.bpb-re-status').textContent, '');
});

test('profile image insertion accepts a hosted URL without offering ascent-only upload', async t => {
    const dom = await loadProfile(t);
    const ui = await editorReady(dom);
    ui.querySelector('[aria-label="Insert image"]').click();
    const input = ui.querySelector('[aria-label="Image URL (HTTPS)"]');
    assert.equal(dom.window.document.activeElement, input);
    input.value = 'https://example.com/photo.jpg';
    ui.querySelector('.bpb-re-imagebox .bpb-re-linkapply').click();
    await waitFor(dom, () => dom.window.document.getElementById('ClimberText').value.includes('[img'));
    assert.match(dom.window.document.getElementById('ClimberText').value, /https:\/\/example.com\/photo.jpg/);
});

test('disabling the profile editor flushes edits and restores the native biography and hints', async t => {
    const dom = await loadProfile(t);
    await editorReady(dom);
    const doc = dom.window.document;
    typeRich(dom, '<p>Last <strong>edit</strong></p>');
    await dom.chrome.storage.sync.set({ bpbSettings: { enableReportEditor: false } });
    await waitFor(dom, () => !doc.getElementById('bpb-report-editor'));
    assert.equal(doc.getElementById('ClimberText').value, 'Last [b]edit[/b]');
    assert.equal(doc.getElementById('ClimberText').classList.contains('bpb-re-hidden'), false);
    assert.equal(doc.getElementById('native-hints').classList.contains('bpb-re-hidden'), false);
});

test('disabled profile editor leaves even an empty biography untouched when report credit is enabled', async t => {
    const dom = await loadProfile(t, { settings: { enableReportEditor: false, addReportCredit: true } });
    await dom.chrome.storage.sync.set({ bpbSettings: dom.chrome._store.bpbSettings });
    assert.equal(dom.window.document.getElementById('bpb-report-editor'), null);
    assert.equal(dom.window.document.getElementById('ClimberText').value, '');
});

test('profile editor handles the account-creation URL without a climber identity', async t => {
    const dom = await loadProfile(t, { url: 'https://peakbagger.com/climber/ClimberEdit.aspx' });
    assert.equal((await editorReady(dom)).dataset.mode, 'rich');
    assert.equal(dom.window.document.getElementById('ClimberText').value, '');
});
