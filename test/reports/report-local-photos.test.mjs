// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEditor, editorReady, editors, modeButton, DRAFT_KEY } from '../helpers/report-editor-helpers.mjs';
import { fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';
const localId = '00000000-0000-4000-8000-000000000001';
const src = `https://bpb-photo.invalid/${localId}`;
const hosted = 'https://i.ibb.co/fixture/photo.png';
const setup = async upload => {
    const messages = [];
    let submissions = 0;
    const dom = await loadEditor({ report: `[img src="${src}" alt="Mountain"]`, prepare: d => {
        d.chrome.runtime.sendMessage = async message => {
            messages.push(message);
            if (message.type === 'PHOTO_REPORT_READ') return { ok: true, dataUrl: 'data:image/png;base64,eA==' };
            if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'activation' };
            if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'grant' };
            if (message.type === 'TRUSTED_ACTION_END') return { ok: true };
            if (message.type === 'PHOTO_REPORT_UPLOAD') return upload(message);
            return undefined; // The shared fixture owns fallback worker routes.
        };
        d.window.document.getElementById('JournalText').form.requestSubmit = () => { submissions++; };
    } });
    const ui = await editorReady(dom);
    await waitFor(dom, () => editors(dom).rich);
    return { dom, ui, messages, submissions: () => submissions };
};

test('local-photo fixtures delegate unhandled worker routes without recursive dispatch', async () => {
    const h = await setup(async () => { throw new Error('must not upload'); });
    const message = { type: 'GPX_PROCESS_INVALIDATE', pageSessionId: 'local-photo-page', selectionGeneration: 2 };
    const response = await h.dom.chrome.runtime.sendMessage(message);
    assert.equal(response.ok, true);
    assert.equal(response.pageSessionId, message.pageSessionId);
    assert.equal(response.selectionGeneration, message.selectionGeneration);
    assert.equal(h.messages.filter(item => item.type === message.type).length, 1);
    h.dom.window.close();
});

test('pending images show local state; synthetic Save cannot upload or submit', async () => {
    const h = await setup(async () => { throw new Error('must not upload'); });
    assert.equal(h.ui.querySelector('.bpb-re-local-photo-actions span').textContent, 'Not uploaded');
    h.dom.window.document.getElementById('SaveButton').click();
    assert.equal(h.submissions(), 0);
    assert.equal(h.messages.filter(m => m.type === 'PHOTO_REPORT_UPLOAD').length, 0);
    assert.match(h.ui.querySelector('.bpb-re-local-photo-status').textContent, /Use Save Ascent/);
    h.dom.window.close();
});

test('Save waits for hosted URLs, blocks double submission, and retains dimensions', async () => {
    let finish;
    const h = await setup(() => new Promise(resolve => { finish = resolve; }));
    const form = h.dom.window.document.getElementById('JournalText').form;
    const status = h.ui.querySelector('.bpb-re-local-photo-status');
    const button = h.dom.window.document.getElementById('SaveButton');
    fireTrustedEvent(button, 'click', { bubbles: true, cancelable: true });
    assert.equal(status.textContent, 'Preparing photos for upload… Keep this page open.');
    assert.equal(status.dataset.state, 'busy');
    assert.equal(button.value, 'Preparing photos…');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(form.getAttribute('aria-busy'), 'true');
    await waitFor(h.dom, () => finish);
    assert.equal(status.textContent, 'Uploading photo 1 of 1 to ImgBB… Keep this page open.');
    assert.equal(button.value, 'Uploading 1/1…');
    fireTrustedEvent(button, 'click', { bubbles: true, cancelable: true });
    assert.equal(h.submissions(), 0);
    assert.equal(h.messages.filter(m => m.type === 'PHOTO_REPORT_UPLOAD').length, 1);
    finish({ ok: true, url: hosted });
    await waitFor(h.dom, () => h.submissions() === 1);
    assert.match(h.dom.window.document.getElementById('JournalText').value, /https:\/\/i\.ibb\.co/);
    assert.doesNotMatch(h.dom.window.document.getElementById('JournalText').value, /bpb-photo\.invalid/);
    assert.equal(button.value, 'Save Ascent');
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.equal(form.hasAttribute('aria-busy'), false);
    h.dom.window.close();
});

test('failed uploads preserve pending images and keep the native form open', async () => {
    const h = await setup(async () => ({ ok: false, error: { message: 'Check ImgBB before retrying.' } }));
    fireTrustedEvent(h.dom.window.document.getElementById('SaveButton2'), 'click', { bubbles: true, cancelable: true });
    await waitFor(h.dom, () => /not been submitted/.test(h.ui.querySelector('.bpb-re-local-photo-status').textContent));
    assert.equal(h.submissions(), 0);
    assert.ok(h.dom.window.document.getElementById('JournalText').value.includes(src));
    assert.equal(h.dom.window.document.getElementById('JournalText').form.inert, undefined);
    assert.equal(h.ui.querySelector('.bpb-re-local-photo-status').dataset.state, 'error');
    assert.equal(h.dom.window.document.getElementById('SaveButton2').value, 'Save Ascent');
    assert.equal(h.dom.window.document.getElementById('SaveButton2').hasAttribute('aria-busy'), false);
    h.dom.window.close();
});

test('upload failure stays visible beside the native textarea after live disable', async () => {
    const h = await setup(async () => ({ ok: false, error: { message: 'Check ImgBB before retrying.' } }));
    const current = h.dom.chrome._store.bpbSettings || {};
    await h.dom.chrome.storage.sync.set({
        bpbSettings: { ...current, enableReportEditor: false },
    });
    await waitFor(h.dom, () => !h.dom.window.document.getElementById('bpb-report-editor'));

    const doc = h.dom.window.document;
    const textarea = doc.getElementById('JournalText');
    const status = doc.querySelector('.bpb-re-local-photo-status');
    assert.equal(textarea.classList.contains('bpb-re-hidden'), false);
    assert.equal(status.isConnected, true);
    assert.equal(status.nextElementSibling, textarea);

    fireTrustedEvent(doc.getElementById('SaveButton'), 'click', { bubbles: true, cancelable: true });
    await waitFor(h.dom, () => /not been submitted/.test(status.textContent));
    assert.equal(h.submissions(), 0);
    assert.ok(textarea.value.includes(src));
    h.dom.window.close();
});

test('pending references survive Markdown mode and are replaced before Save', async () => {
    const h = await setup(async () => ({ ok: true, url: hosted }));
    modeButton(h.dom.window.document, 'Markdown').click();
    fireTrustedEvent(h.dom.window.document.getElementById('SaveButton'), 'click', { bubbles: true, cancelable: true });
    await waitFor(h.dom, () => h.submissions() === 1);
    assert.ok(h.dom.window.document.getElementById('JournalText').value.includes(hosted));
    assert.ok(editors(h.dom).markdown.getValue().includes(hosted));
    h.dom.window.close();
});

test('a real image paste stays local and undo/redo keep its durable reference', async () => {
    const messages = [];
    let createdId;
    const dom = await loadEditor({ prepare: d => {
        const win = d.window;
        win.createImageBitmap = async () => ({ width: 800, height: 500, close() {} });
        win.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
        win.HTMLCanvasElement.prototype.toBlob = callback => callback(new win.Blob(['pixels'], { type: 'image/png' }));
        win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,dGh1bWI=';
        const file = new win.File(['pixels'], 'pasted.png', { type: 'image/png' });
        win.document.addEventListener('paste', event => Object.defineProperty(event, 'clipboardData', {
            value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
        }), true);
        d.chrome.runtime.sendMessage = async message => {
            messages.push(message);
            if (message.type === 'PHOTO_REPORT_STATUS') return { ok: true, configured: true, permissionGranted: true };
            if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'paste-activation' };
            if (message.type === 'PHOTO_REPORT_CREATE') {
                createdId = message.localPhotoId;
                return { ok: true, localPhotoId: createdId, url: `https://bpb-photo.invalid/${createdId}`, alt: '' };
            }
            return undefined;
        };
    } });
    const ui = await editorReady(dom);
    fireTrustedEvent(ui.querySelector('.bpb-re-surface'), 'paste', { bubbles: true, cancelable: true });
    await waitFor(dom, () => /until you save the TR/.test(ui.querySelector('.bpb-re-local-photo-status').textContent));
    const rich = editors(dom).rich;
    const durable = `https://bpb-photo.invalid/${createdId}`;
    assert.ok(rich.getHTML().includes(durable));
    // Attribute normalization may share the paste's undo group; exhaust it
    // and redo every step to catch a transient id returning from history.
    while (rich.can().undo()) rich.commands.undo();
    while (rich.can().redo()) rich.commands.redo();
    assert.ok(rich.getHTML().includes(durable));
    assert.equal(messages.filter(message => message.type === 'PHOTO_REPORT_CREATE').length, 1);
    assert.equal(messages.filter(message => message.type === 'PHOTO_REPORT_UPLOAD').length, 0);
    const draft = dom.chrome._localStore[DRAFT_KEY];
    assert.ok(draft.text.includes(durable));
    assert.doesNotMatch(draft.text, /data:image|blob:/);
    dom.window.close();
});

test('implicit submission uploads pending photos and resumes with a Save submitter', async () => {
    const h = await setup(async () => ({ ok: true, url: hosted }));
    const form = h.dom.window.document.getElementById('JournalText').form;
    let submitter = null;
    form.requestSubmit = control => { submitter = control; };
    fireTrustedEvent(form, 'submit', { bubbles: true, cancelable: true });
    await waitFor(h.dom, () => submitter);
    assert.equal(submitter.id, 'SaveButton');
    assert.equal(h.messages.filter(message => message.type === 'PHOTO_REPORT_UPLOAD').length, 1);
    h.dom.window.close();
});

test('leaving during upload never submits the old report on return', async () => {
    let finish;
    const h = await setup(() => new Promise(resolve => { finish = resolve; }));
    fireTrustedEvent(h.dom.window.document.getElementById('SaveButton'), 'click', { bubbles: true, cancelable: true });
    await waitFor(h.dom, () => finish);
    h.dom.window.dispatchEvent(new h.dom.window.Event('pagehide'));
    h.dom.window.dispatchEvent(new h.dom.window.Event('pageshow'));
    finish({ ok: true, url: hosted });
    await waitFor(h.dom, () => /left this report/.test(h.ui.querySelector('.bpb-re-local-photo-status').textContent));
    assert.equal(h.submissions(), 0);
    assert.ok(h.dom.window.document.getElementById('JournalText').value.includes(src));
    h.dom.window.close();
});
