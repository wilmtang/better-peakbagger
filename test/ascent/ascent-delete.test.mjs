// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES, waitFor } from '../helpers/load-page.mjs';

const URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=3273892&cid=900001';
const DRAFT_KEY = 'bpbReportDraft:900001:a3273892';

const loadDeleteForm = async ({
    buttonId = 'DeleteButton',
    settings = { enableGithubBackup: true, removeGithubBackupOnDelete: true },
    confirm = true,
    intentResponse = { ok: true },
    draft = null,
    settingsReadError = null,
} = {}) => {
    const messages = [];
    const alerts = [];
    const nativeSubmissions = [];
    const dom = await loadPage('climber-ascentedit.html', {
        fixtures: PAGE_FIXTURES,
        url: URL,
        settings,
        local: draft ? { [DRAFT_KEY]: draft } : {},
        bundles: ['vendor/marked.umd.js', 'content/ascent-editor.js'],
        prepare: current => {
            if (settingsReadError) {
                current.chrome.storage.sync.get = async () => { throw settingsReadError; };
            }
            const form = current.window.document.getElementById('Form1');
            for (const id of ['DeleteButton', 'DeleteButton2']) {
                const input = current.window.document.createElement('input');
                input.type = 'submit';
                input.id = id;
                input.name = id;
                input.value = 'Delete Ascent';
                form.append(input);
            }
            current.window.confirm = () => confirm;
            current.window.alert = message => alerts.push(message);
            current.chrome.runtime.sendMessage = async message => {
                messages.push(message);
                return message.type === 'GITHUB_ASCENT_DELETE_INTENT' ? intentResponse : null;
            };
            form.requestSubmit = submitter => {
                const event = new current.window.SubmitEvent('submit', {
                    bubbles: true,
                    cancelable: true,
                    submitter,
                });
                nativeSubmissions.push({
                    id: submitter.id,
                    allowed: form.dispatchEvent(event),
                });
            };
        },
    });
    return {
        dom,
        button: dom.window.document.getElementById(buttonId),
        messages,
        alerts,
        nativeSubmissions,
    };
};

const submit = (dom, button) => button.form.dispatchEvent(new dom.window.SubmitEvent('submit', {
    bubbles: true,
    cancelable: true,
    submitter: button,
}));

for (const buttonId of ['DeleteButton', 'DeleteButton2']) {
    test(`${buttonId} records one intent before allowing Peakbagger's native delete`, async () => {
        const { dom, button, messages, alerts, nativeSubmissions } = await loadDeleteForm({ buttonId });

        assert.equal(submit(dom, button), false, 'the first destructive submit is paused');
        await waitFor(dom, () => nativeSubmissions.length === 1);

        assert.deepEqual(JSON.parse(JSON.stringify(
            messages.filter(message => message.type === 'GITHUB_ASCENT_DELETE_INTENT')
        )), [{
            type: 'GITHUB_ASCENT_DELETE_INTENT',
            aid: 3273892,
        }]);
        assert.deepEqual(nativeSubmissions, [{ id: buttonId, allowed: true }]);
        assert.deepEqual(alerts, []);
        dom.window.close();
    });
}

test('cancelling the combined confirmation changes neither Peakbagger nor GitHub', async () => {
    const { dom, button, messages, nativeSubmissions } = await loadDeleteForm({ confirm: false });

    assert.equal(submit(dom, button), false);
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(messages.some(message => message.type === 'GITHUB_ASCENT_DELETE_INTENT'), false);
    assert.deepEqual(nativeSubmissions, []);
    assert.equal(dom.window.document.activeElement, button);
    dom.window.close();
});

test('an intent failure keeps Peakbagger unchanged and explains the recovery path', async () => {
    const { dom, button, alerts, nativeSubmissions } = await loadDeleteForm({
        intentResponse: { ok: false, error: { code: 'not-connected' } },
    });

    submit(dom, button);
    await waitFor(dom, () => alerts.length === 1);
    assert.deepEqual(nativeSubmissions, []);
    assert.match(alerts[0], /Peakbagger was not changed/);
    assert.equal(dom.window.document.activeElement, button);
    dom.window.close();
});

test('the native delete remains uninterrupted when deletion mirroring is off', async () => {
    const { dom, button, messages, nativeSubmissions } = await loadDeleteForm({
        settings: { enableGithubBackup: true, removeGithubBackupOnDelete: false },
    });

    assert.equal(submit(dom, button), false, 'the setting read is completed before resubmission');
    await waitFor(dom, () => nativeSubmissions.length === 1);
    assert.deepEqual(nativeSubmissions, [{ id: 'DeleteButton', allowed: true }]);
    assert.equal(messages.some(message => message.type === 'GITHUB_ASCENT_DELETE_INTENT'), false);
    dom.window.close();
});

test('an unreadable deletion setting keeps Peakbagger unchanged and explains recovery', async () => {
    const { dom, button, messages, alerts, nativeSubmissions } = await loadDeleteForm({
        settingsReadError: new Error('sync settings unavailable'),
    });

    assert.equal(submit(dom, button), false);
    await waitFor(dom, () => alerts.length === 1);
    assert.deepEqual(nativeSubmissions, []);
    assert.equal(messages.some(message => message.type === 'GITHUB_ASCENT_DELETE_INTENT'), false);
    assert.match(alerts[0], /Peakbagger was not changed/);
    assert.match(alerts[0], /Reload the page and try again/);
    assert.equal(dom.window.document.activeElement, button);
    dom.window.close();
});

test('non-delete submitters never create a deletion intent', async () => {
    const { dom, messages, nativeSubmissions } = await loadDeleteForm();
    const save = dom.window.document.getElementById('SaveButton');

    assert.equal(submit(dom, save), true);
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(messages.some(message => message.type === 'GITHUB_ASCENT_DELETE_INTENT'), false);
    assert.deepEqual(nativeSubmissions, []);
    dom.window.close();
});

test('a confirmed delete clears the local report draft and pagehide cannot recreate it', async () => {
    const { dom, button, nativeSubmissions } = await loadDeleteForm({
        draft: { text: 'Delete this report too', mode: 'rich', savedAt: Date.now() },
    });
    await waitFor(dom, () => dom.window.document.getElementById('bpb-report-editor'));

    submit(dom, button);
    await waitFor(dom, () => nativeSubmissions.length === 1);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await waitFor(dom, () => !dom.chrome._localStore[DRAFT_KEY]);
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));

    assert.equal(dom.chrome._localStore[DRAFT_KEY], undefined);
    dom.window.close();
});
