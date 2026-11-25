/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { builtBundle, fixtureDom } from '../helpers/fixture-dom.mts';

interface UiMessage { type: string; [key: string]: unknown }
type Callback = () => unknown;
type Reply = Record<string, unknown>;
const settingsSource = await builtBundle('options/garmin.js');
const inboxSource = await builtBundle('options/inbox.js');
const inboxHtml = await readFile(new URL('../../options/inbox.html', import.meta.url), 'utf8');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
test('Garmin disconnect is exposed with imports off and guards retry, focus and repeat activation', async () => {
    const dom = fixtureDom('<div data-garmin-settings hidden></div>', { url: 'https://www.peakbagger.com/options/options.html#capture-garmin', runScripts: 'outside-only' });
    let finish: (value: Reply) => void = () => {}, removals = 0;
    const calls: string[] = [];
    dom.window.chrome = { storage: { local: { get: async () => ({}) }, sync: { get: async () => ({ bpbSettings: { enableGarminInbox: false } }) }, onChanged: { addListener() {}, removeListener() {} } },
        runtime: { sendMessage: async (message: UiMessage) => {
            calls.push(message.type);
            if (message.type === 'GARMIN_DISCONNECT') { removals++; return new Promise(resolve => { finish = resolve; }); }
            return { ok: true, configured: true };
        } } };
    try {
        dom.window.eval(settingsSource); await tick();
        const d = dom.window.document, action = d.querySelector('#garmin-disconnect');
        assert.equal(d.querySelector('[data-garmin-settings]').hidden, false);
        assert.equal(action.hidden, false);
        assert.equal(action.closest('details'), null);
        assert.equal(d.querySelector('#garmin-key').disabled, true);
        assert.equal(dom.window.location.hash, '#capture-garmin');
        assert.equal(calls.includes('GARMIN_STATUS'), false);
        action.focus(); action.click(); action.click(); await tick();
        assert.equal(removals, 1);
        assert.equal(action.getAttribute('aria-busy'), 'true');
        finish({ ok: false, error: { message: 'Could not remove the key. Try again.' } }); await tick();
        assert.equal(d.activeElement, action);
        assert.equal(action.hidden, false);
        action.click(); await tick(); finish({ ok: true, configured: false }); await tick();
        assert.equal(removals, 2);
        assert.equal(action.hidden, true);
        assert.equal(d.activeElement, d.querySelector('h3'));
        assert.match(d.querySelector('#garmin-key-status').textContent, /Disconnected/);
    } finally { dom.window.close(); }
});
test('Garmin setup links directly to key creation and requests permission only on Connect', async () => {
    const dom = fixtureDom('<div data-garmin-settings></div>', { url: 'https://www.peakbagger.com/options/options.html', runScripts: 'outside-only' });
    const messages: UiMessage[] = []; let permissions = 0;
    const intervals: Callback[] = []; (dom.window as { setInterval: unknown }).setInterval = (callback: Callback) => { intervals.push(callback); return intervals.length; };
    dom.window.chrome = { permissions: { request: async () => { permissions++; return true; } },
        storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } },
        runtime: { sendMessage: async (message: UiMessage) => {
            messages.push(message);
            if (message.type === 'GARMIN_CONNECT') return { ok: false, error: { message: 'Garmin didn’t accept this key.' } };
            return { ok: true, configured: false, pending: 0, items: [] };
        } } };
    dom.window.eval(settingsSource); await tick();
    const document = dom.window.document;
    assert.equal(document.querySelector('.garmin-key-label a').href, 'https://connect.garmin.com/app/settings/personalApiToken');
    assert.equal(permissions, 0);
    document.querySelector('#garmin-key').value = 'fictional-personal-api-key';
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); assert.equal(permissions, 1); assert.equal(messages.filter((m: UiMessage) => m.type === 'GARMIN_CONNECT').length, 1);
    assert.match(document.querySelector('#garmin-key-status').textContent, /didn’t accept/);
    assert.equal(document.querySelector('#garmin-key').value, 'fictional-personal-api-key');
    Object.defineProperty(document, 'hidden', { value: false });
    intervals[0](); await tick();
    assert.match(document.querySelector('#garmin-key-status').textContent, /didn’t accept/, 'Background refresh preserves the rejected replacement message');
    dom.window.close();
});
test('Garmin setup finishes on Connect and only offers a second action for revoked access', async () => {
    const dom = fixtureDom('<div data-garmin-settings></div>', { url: 'https://www.peakbagger.com/options/options.html', runScripts: 'outside-only' });
    const messages: UiMessage[] = [], intervals: Callback[] = []; let permissions = 0;
    const state: Reply = { configured: false, enabled: false, pending: 0, cid: null, items: [] };
    (dom.window as { setInterval: unknown }).setInterval = (callback: Callback) => (intervals.push(callback), intervals.length);
    Object.defineProperty(dom.window.document, 'hidden', { value: false });
    dom.window.chrome = { permissions: { request: async () => { permissions++; return true; } },
        storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } },
        runtime: { sendMessage: async (message: UiMessage) => {
            messages.push(message);
            if (message.type === 'GARMIN_CONNECT') Object.assign(state, { configured: true, enabled: true });
            if (message.type === 'GARMIN_ACCESS') state.error = null;
            return { ok: true, ...structuredClone(state) };
        } } };
    try {
        dom.window.eval(settingsSource); await tick();
        const d = dom.window.document;
        assert.equal(d.querySelector('#garmin-enable'), null, 'Setup has no separate draft activation');
        assert.equal(d.querySelector('#garmin-access').hidden, true);
        d.querySelector('#garmin-key').value = 'fictional-personal-api-key';
        d.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        assert.equal(permissions, 1);
        assert.equal(d.querySelector('#garmin-key').value, '');
        assert.equal(d.querySelector('#garmin-preferences').hidden, false);
        assert.match(d.querySelector('#garmin-settings-status').textContent, /Open Peakbagger and sign in to prepare/);
        assert.equal(messages.some(message => message.type === 'GARMIN_ENABLE'), false);
        state.cid = '456'; intervals[0](); await tick();
        assert.match(d.querySelector('#garmin-settings-status').textContent, /Garmin drafts enabled/);
        state.error = { code: 'permission', message: 'Allow Garmin access to continue.' };
        intervals[0](); await tick();
        assert.equal(d.querySelector('#garmin-access').hidden, false);
        d.querySelector('#garmin-access').click(); await tick();
        assert.equal(permissions, 2);
        assert.equal(messages.filter(message => message.type === 'GARMIN_ACCESS').length, 1);
        assert.equal(d.querySelector('#garmin-access').hidden, true);
    } finally { dom.window.close(); }
});
test('inbox keeps drafts visible during a rejected-key state', async () => {
    const dom = fixtureDom(inboxHtml, { url: 'https://www.peakbagger.com/options/inbox.html', runScripts: 'outside-only' });
    dom.window.chrome = { runtime: { sendMessage: async () => ({ ok: true, configured: true, enabled: true, pending: 1,
        error: { code: 'key-rejected', message: 'Garmin needs a new API key. Imports paused; your drafts are safe.' },
        items: [{ id: '123', summary: { date: '2026-10-23', type: 'hiking' }, phase: 'ready', saved: [],
            analysis: { matches: [{ id: 1, name: 'Example Peak', classification: 'strong' }] } }] }) },
    storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
    dom.window.eval(inboxSource); await tick();
    assert.equal(dom.window.document.querySelectorAll('.garmin-activity').length, 1);
    assert.equal(dom.window.document.querySelector('#inbox-update-key').hidden, false);
    dom.window.document.querySelector('.garmin-activity button').click();
    assert.equal(dom.window.document.querySelector('#inbox-review').hidden, false);
    assert.match(dom.window.document.querySelector('#inbox-matches').textContent, /Example Peak/);
    dom.window.close();
});

test('review exposes refreshed results explicitly and updates handoff recovery without reopening', async () => {
    const dom = fixtureDom(inboxHtml, { url: 'https://www.peakbagger.com/options/inbox.html', runScripts: 'outside-only' });
    const intervals: Callback[] = []; (dom.window as { setInterval: unknown }).setInterval = (fn: Callback) => { intervals.push(fn); return intervals.length; };
    Object.defineProperty(dom.window.document, 'hidden', { value: false });
    const item: Reply = { id: '123', phase: 'waiting', saved: [], summary: { date: '2026-10-23', type: 'hiking' }, analysis: null };
    const state = { configured: true, enabled: true, cid: '456', items: [item] }; const calls: UiMessage[] = [];
    dom.window.chrome = { tabs: { getCurrent: async () => ({ id: 1 }) }, runtime: { sendMessage: async (message: UiMessage) => {
        calls.push(message);
        if (message.type === 'GARMIN_OPEN_DRAFTS') item.handoff = true;
        return { ok: true, ...structuredClone(state) };
    } }, storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
    dom.window.eval(inboxSource); await tick(); const d = dom.window.document;
    d.querySelector('.garmin-activity button').click();
    item.phase = 'ready'; item.analysis = { matches: [{ id: 1, name: 'Ready Peak', classification: 'strong' }] };
    intervals[0](); await tick();
    assert.match(d.querySelector('#inbox-refresh').textContent, /Review updated matches/);
    d.querySelector('#inbox-refresh').click(); await tick();
    assert.match(d.querySelector('#inbox-matches').textContent, /Ready Peak/);
    assert.equal(calls.filter(call => call.type === 'GARMIN_RETRY').length, 0);
    d.querySelector('#inbox-open').click(); await tick();
    assert.equal(d.querySelector('#inbox-saved').hidden, false);
    assert.equal(d.querySelector('#inbox-refresh').getAttribute('aria-disabled'), 'true');
    assert.equal(d.querySelector('#inbox-dismiss').getAttribute('aria-disabled'), 'true');
    dom.window.close();
});

test('inbox identifies queued activities and preserves them during a human check', async () => {
    const dom = fixtureDom(inboxHtml, { url: 'https://www.peakbagger.com/options/inbox.html', runScripts: 'outside-only' });
    dom.window.chrome = { runtime: { sendMessage: async () => ({ ok: true, configured: true, enabled: true,
        queued: 2, peakbaggerBlocked: { code: 'cloudflare' }, history: [], items: [1, 2].map(id => ({ id: String(id), phase: 'waiting', summary: { date: '2026-10-23', type: 'hiking' } })) }) },
    storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
    try {
        dom.window.eval(inboxSource); await tick();
        const d = dom.window.document;
        assert.match(d.querySelector('#inbox-queue').textContent, /2 activities waiting for peak checks/);
        assert.match(d.querySelector('#inbox-status').textContent, /human check/);
        assert.equal(d.querySelector('#inbox-resume-peaks').hidden, false);
        assert.equal(d.querySelectorAll('.garmin-activity').length, 2);
    } finally { dom.window.close(); }
});

test('a bookmarked inbox stays hidden while disabled and does not poll its data', async () => {
    const dom = fixtureDom(inboxHtml, { url: 'https://www.peakbagger.com/options/inbox.html', runScripts: 'outside-only' });
    let messages = 0;
    dom.window.chrome = { runtime: { sendMessage: async () => { messages++; return { ok: true, items: [] }; } },
        storage: { local: { get: async () => ({}) }, sync: { get: async () => ({ bpbSettings: { enableGarminInbox: false } }) }, onChanged: { addListener() {}, removeListener() {} } } };
    try {
        dom.window.eval(inboxSource); await tick();
        assert.equal(dom.window.document.querySelector('#inbox-content').hidden, true);
        assert.equal(dom.window.document.querySelector('#inbox-disabled').hidden, false);
        dom.window.document.querySelector('#inbox-check').click(); await tick();
        assert.equal(messages, 0);
    } finally { dom.window.close(); }
});

const auditInbox = async (overrides: Reply = {}) => {
    const dom = fixtureDom(inboxHtml, { url: 'https://www.peakbagger.com/options/inbox.html', runScripts: 'outside-only' });
    const intervals: Callback[] = [], calls: UiMessage[] = [];
    const item: Reply = { id: '123', phase: 'ready', saved: [], summary: { date: '2026-10-23', type: 'hiking' },
        analysis: { matches: [{ id: 1, name: 'Example Peak', classification: 'strong' }], hasTimestamps: true } };
    const state: { items: Reply[]; history: Reply[]; undoError?: string; [key: string]: unknown } = { configured: true, enabled: true, cid: '456', items: [item], history: [], ...overrides };
    (dom.window as { setInterval: unknown }).setInterval = (fn: Callback) => (intervals.push(fn), intervals.length);
    dom.window.confirm = () => false;
    Object.defineProperty(dom.window.document, 'hidden', { value: false });
    const get = async () => ({ bpbSettings: { removeGpxTimestamps: true },
        bpbDeviceSettings: { schemaVersion: 1, settings: { removeGpxTimestamps: true } } });
    dom.window.chrome = { runtime: { sendMessage: async (message: UiMessage) => {
        calls.push(message);
        if (message.type === 'GARMIN_DISMISS') { state.items = []; state.history = [{ id: '123', dismissed: true, undoAvailable: true, date: '2026-10-23' }]; }
        if (message.type === 'GARMIN_UNDO' && state.undoError) return { ok: false, error: { message: state.undoError } };
        if (message.type === 'GARMIN_UNDO') { state.history[0].undoAvailable = false; state.items = [item]; }
        return { ok: true, ...structuredClone(state) };
    } }, storage: { sync: { get }, local: { get }, onChanged: { addListener() {}, removeListener() {} } } };
    dom.window.eval(inboxSource); await tick();
    return { dom, d: dom.window.document, state, item, calls, refresh: async () => { intervals[0](); await tick(); } };
};
test('Inbox cancel preserves review status and dismissal focuses a surviving action', async () => {
    const h = await auditInbox();
    try {
        h.d.querySelector('#inbox-list button').click();
        const before = h.d.querySelector('#inbox-review-status').textContent;
        h.d.querySelector('#inbox-done').focus(); h.d.querySelector('#inbox-done').click(); await tick();
        assert.equal(h.d.querySelector('#inbox-done-confirmation').hidden, false, 'Done asks in the page');
        assert.equal(h.d.querySelector('#inbox-done').getAttribute('aria-expanded'), 'true');
        assert.equal(h.d.activeElement.id, 'inbox-done-confirm');
        h.d.querySelector('#inbox-done-cancel').click(); await tick();
        assert.equal(h.d.querySelector('#inbox-done-confirmation').hidden, true);
        assert.equal(h.d.activeElement.id, 'inbox-done', 'Cancel returns focus to Done');
        assert.equal(h.d.querySelector('#inbox-review-status').textContent, before);
        assert(!h.calls.some((call: UiMessage) => call.type === 'GARMIN_DONE'));
        h.d.querySelector('#inbox-done').click(); await tick();
        h.d.querySelector('#inbox-done-confirmation').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(h.d.querySelector('#inbox-done-confirmation').hidden, true, 'Escape closes the question');
        h.d.querySelector('#inbox-dismiss').focus(); h.d.querySelector('#inbox-dismiss').click(); await tick();
        assert.equal(h.d.activeElement.id, 'inbox-check');
    } finally { h.dom.window.close(); }
});
test('Inbox Done is sent only from its in-page confirmation', async () => {
    const h = await auditInbox();
    let native = 0; h.dom.window.confirm = () => { native++; return true; };
    try {
        h.d.querySelector('#inbox-list button').click();
        h.d.querySelector('#inbox-done').click(); await tick();
        assert(!h.calls.some((call: UiMessage) => call.type === 'GARMIN_DONE'));
        h.d.querySelector('#inbox-done-confirm').click(); await tick();
        assert.deepEqual(h.calls.filter((call: UiMessage) => call.type === 'GARMIN_DONE').map((call: UiMessage) => call.id), ['123']);
        assert.equal(native, 0, 'no native dialog is used');
        assert.equal(h.d.querySelector('#inbox-review').hidden, true);
        assert.equal(h.d.querySelector('#inbox-done-confirmation').hidden, true);
        assert.equal(h.d.activeElement.id, 'inbox-check');
    } finally { h.dom.window.close(); }
});
test('Inbox timestamp visibility is resolved before the review becomes visible', async () => {
    const h = await auditInbox();
    try {
        h.d.querySelector('#inbox-list button').click();
        assert.equal(h.d.querySelector('#inbox-review').hidden, false);
        assert.equal(h.d.querySelector('#inbox-timestamp-row').hidden, false);
    } finally { h.dom.window.close(); }
});
test('Inbox review follows phase errors even when both match snapshots are empty', async () => {
    const h = await auditInbox();
    try {
        h.item.phase = 'waiting'; h.item.analysis = null; await h.refresh();
        h.d.querySelector('#inbox-list button').click();
        h.item.phase = 'error'; h.item.error = 'Recording could not be downloaded.'; await h.refresh();
        assert.equal(h.d.querySelector('#inbox-review-status').textContent, h.item.error);
    } finally { h.dom.window.close(); }
});
test('Inbox history offers Undo only while the worker does, and never leaves a dead control', async () => {
    const h = await auditInbox({ history: [{ id: '123', complete: true }] });
    try {
        h.d.querySelector<HTMLDetailsElement>('#inbox-history').open = true;
        h.state.history[0] = { id: '123', dismissed: true, undoAvailable: true }; await h.refresh();
        const undo = h.d.querySelector('#history-123 button'); assert(undo);
        undo.focus(); undo.click(); await tick();
        assert.equal(h.d.querySelector('#history-123 button'), null, 'a used Undo is removed');
        assert.equal(h.d.activeElement.textContent, 'Review activity', 'focus moves to the restored activity');
        h.state.history[0] = { id: '123', dismissed: true, undoAvailable: true }; await h.refresh();
        h.d.querySelector('#history-123 button').focus();
        h.state.history[0].undoAvailable = false; await h.refresh();
        assert.equal(h.d.querySelector('#history-123 button'), null, 'an expired Undo is removed, not disabled');
        assert.equal(h.d.activeElement.id, 'inbox-check');
        h.state.history[0] = { id: '123', complete: true }; await h.refresh();
        assert.equal(h.d.querySelector('#history-123 button'), null);
    } finally { h.dom.window.close(); }
});

const dismissFromReview = async (h: Awaited<ReturnType<typeof auditInbox>>) => {
    h.d.querySelector('#inbox-list button').click();
    h.d.querySelector('#inbox-dismiss').focus(); h.d.querySelector('#inbox-dismiss').click(); await tick();
};
test('Dismiss is confirmed in the list status with an Undo that outlasts polling', async () => {
    const h = await auditInbox();
    try {
        await dismissFromReview(h);
        const status = h.d.querySelector('#inbox-status'), undo = h.d.querySelector('#inbox-undo');
        assert.equal(status.textContent, 'Hike · 2026-10-23 dismissed.');
        assert.equal(undo.hidden, false);
        assert.equal(h.d.activeElement.id, 'inbox-check', 'focus stays on a stable list action');
        await h.refresh(); await h.refresh();
        assert.equal(status.textContent, 'Hike · 2026-10-23 dismissed.', 'polling does not overwrite the confirmation');
        assert.equal(undo.hidden, false);
        undo.focus(); undo.click(); await tick();
        assert.deepEqual(h.calls.filter((call: UiMessage) => call.type === 'GARMIN_UNDO').map((call: UiMessage) => call.id), ['123']);
        assert.equal(undo.hidden, true);
        assert.doesNotMatch(status.textContent, /dismissed/);
        assert.equal(h.d.querySelectorAll('#inbox-list .garmin-activity').length, 1);
        assert.equal(h.d.activeElement.id, 'inbox-check', 'focus stays beside the status line');
    } finally { h.dom.window.close(); }
});
test('A Garmin error or Check now replaces the dismissal notice; history keeps the Undo', async () => {
    for (const trigger of ['error', 'check']) {
        const h = await auditInbox();
        try {
            await dismissFromReview(h);
            if (trigger === 'error') { h.state.error = { code: 'key-rejected', message: 'Garmin needs a new API key.' }; await h.refresh(); }
            else { h.d.querySelector('#inbox-check').click(); await tick(); }
            assert.doesNotMatch(h.d.querySelector('#inbox-status').textContent, /dismissed/, trigger);
            if (trigger === 'error') assert.equal(h.d.querySelector('#inbox-status').textContent, 'Garmin needs a new API key.');
            assert.equal(h.d.querySelector('#inbox-undo').hidden, true, trigger);
            assert(h.d.querySelector('#history-123 button'), `${trigger}: the dismissal stays undoable from history`);
        } finally { h.dom.window.close(); }
    }
});
test('Dismissing from a full inbox still confirms the dismissal with Undo', async () => {
    const full = { code: 'capacity', message: 'Your activity inbox is full. Review or remove activities to make room.' };
    const h = await auditInbox({ error: full });
    try {
        assert.equal(h.d.querySelector('#inbox-status').textContent, full.message);
        await dismissFromReview(h);
        assert.equal(h.d.querySelector('#inbox-status').textContent, 'Hike · 2026-10-23 dismissed.', 'an error already showing does not hide the confirmation');
        assert.equal(h.d.querySelector('#inbox-undo').hidden, false);
        await h.refresh();
        assert.equal(h.d.querySelector('#inbox-undo').hidden, false, 'polling with the same error keeps the notice');
        h.state.error = null; await h.refresh();
        assert.equal(h.d.querySelector('#inbox-undo').hidden, false, 'the earlier error clearing does not retire the notice');
        assert.equal(h.d.querySelector('#inbox-status').textContent, 'Hike · 2026-10-23 dismissed.');
    } finally { h.dom.window.close(); }
});
test('An expired dismissal Undo leaves the status row and returns focus to Check now', async () => {
    const h = await auditInbox();
    try {
        await dismissFromReview(h);
        const undo = h.d.querySelector('#inbox-undo'); undo.focus();
        h.state.history[0].undoAvailable = false; await h.refresh();
        assert.equal(undo.hidden, true);
        assert.doesNotMatch(h.d.querySelector('#inbox-status').textContent, /dismissed/);
        assert.equal(h.d.activeElement.id, 'inbox-check');
    } finally { h.dom.window.close(); }
});
test('A failed Undo is reported without losing the control', async () => {
    const h = await auditInbox();
    try {
        await dismissFromReview(h);
        h.state.undoError = 'The activity could not be restored. Try again.';
        const undo = h.d.querySelector('#inbox-undo'); undo.click(); await tick();
        assert.equal(h.d.querySelector('#inbox-status').textContent, 'The activity could not be restored. Try again.');
        assert.equal(undo.hidden, false);
        assert.notEqual(undo.getAttribute('aria-disabled'), 'true');
        await h.refresh();
        assert.equal(h.d.querySelector('#inbox-status').textContent, 'The activity could not be restored. Try again.');
        delete h.state.undoError; undo.click(); await tick();
        assert.equal(undo.hidden, true);
    } finally { h.dom.window.close(); }
});

test('Garmin Settings refreshes imported credentials and leaves cancelled deletion idle', async () => {
    const dom = fixtureDom('<div data-garmin-settings></div>', { url: 'https://www.peakbagger.com/options/options.html', runScripts: 'outside-only' });
    let configured = false, deletes = 0;
    dom.window.chrome = { storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } },
        runtime: { sendMessage: async (message: UiMessage) => {
            if (message.type === 'GARMIN_DISCONNECT') deletes++;
            return { ok: true, configured, enabled: false, pending: 0, connectedDate: '2026-10-23', items: [] };
        } } };
    dom.window.confirm = () => false;
    try {
        dom.window.eval(settingsSource); await tick();
        configured = true; dom.window.document.dispatchEvent(new dom.window.Event('bpb:credentials-imported')); await tick();
        assert.equal(dom.window.document.querySelector('#garmin-key-status').textContent, 'Connected on this device');
        const status = dom.window.document.querySelector('#garmin-settings-status'), before = status.textContent;
        dom.window.document.querySelector('#garmin-delete').click(); await tick();
        assert.equal(status.textContent, before); assert.equal(deletes, 0);
    } finally { dom.window.close(); }
});
