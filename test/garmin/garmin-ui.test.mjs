import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const settingsSource = await readFile(new URL('../../dist/options/garmin.js', import.meta.url), 'utf8');
const inboxSource = await readFile(new URL('../../dist/options/inbox.js', import.meta.url), 'utf8');
const inboxHtml = await readFile(new URL('../../options/inbox.html', import.meta.url), 'utf8');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
test('Garmin setup links directly to key creation and requests permission only on Connect', async () => {
    const dom = new JSDOM('<div data-garmin-settings></div>', { url: 'chrome-extension://test/options/options.html', runScripts: 'outside-only' });
    const messages = []; let permissions = 0;
    const intervals = []; dom.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
    dom.window.chrome = { permissions: { request: async () => { permissions++; return true; } },
        storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {} } },
        runtime: { sendMessage: async message => {
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
    await tick(); assert.equal(permissions, 1); assert.equal(messages.filter(m => m.type === 'GARMIN_CONNECT').length, 1);
    assert.match(document.querySelector('#garmin-key-status').textContent, /didn’t accept/);
    assert.equal(document.querySelector('#garmin-key').value, 'fictional-personal-api-key');
    Object.defineProperty(document, 'hidden', { value: false });
    intervals[0](); await tick();
    assert.match(document.querySelector('#garmin-key-status').textContent, /didn’t accept/, 'Background refresh preserves the rejected replacement message');
    dom.window.close();
});
test('inbox keeps drafts visible during a rejected-key state', async () => {
    const dom = new JSDOM(inboxHtml, { url: 'chrome-extension://test/options/inbox.html', runScripts: 'outside-only' });
    dom.window.chrome = { runtime: { sendMessage: async () => ({ ok: true, configured: true, enabled: true, pending: 1,
        error: { code: 'key-rejected', message: 'Garmin needs a new API key. Imports paused; your drafts are safe.' },
        items: [{ id: '123', summary: { date: '2026-10-23', type: 'hiking' }, phase: 'ready', saved: [],
            analysis: { matches: [{ id: 1, name: 'Example Peak', classification: 'strong' }] } }] }) },
    storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {} } } };
    dom.window.eval(inboxSource); await tick();
    assert.equal(dom.window.document.querySelectorAll('.garmin-activity').length, 1);
    assert.equal(dom.window.document.querySelector('#inbox-update-key').hidden, false);
    dom.window.document.querySelector('.garmin-activity button').click();
    assert.equal(dom.window.document.querySelector('#inbox-review').hidden, false);
    assert.match(dom.window.document.querySelector('#inbox-matches').textContent, /Example Peak/);
    dom.window.close();
});

test('review exposes refreshed results explicitly and updates handoff recovery without reopening', async () => {
    const dom = new JSDOM(inboxHtml, { url: 'chrome-extension://test/options/inbox.html', runScripts: 'outside-only' });
    const intervals = []; dom.window.setInterval = fn => { intervals.push(fn); return intervals.length; };
    Object.defineProperty(dom.window.document, 'hidden', { value: false });
    const item = { id: '123', phase: 'waiting', saved: [], summary: { date: '2026-10-23', type: 'hiking' }, analysis: null };
    const state = { configured: true, enabled: true, cid: '456', items: [item] }; const calls = [];
    dom.window.chrome = { tabs: { getCurrent: async () => ({ id: 1 }) }, runtime: { sendMessage: async message => {
        calls.push(message);
        if (message.type === 'GARMIN_OPEN_DRAFTS') item.handoff = true;
        return { ok: true, ...structuredClone(state) };
    } }, storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {} } } };
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
    const dom = new JSDOM(inboxHtml, { url: 'chrome-extension://test/options/inbox.html', runScripts: 'outside-only' });
    dom.window.chrome = { runtime: { sendMessage: async () => ({ ok: true, configured: true, enabled: true,
        queued: 2, peakbaggerBlocked: { code: 'cloudflare' }, history: [], items: [1, 2].map(id => ({ id: String(id), phase: 'waiting', summary: { date: '2026-10-23', type: 'hiking' } })) }) },
    storage: { local: { get: async () => ({}) }, sync: { get: async () => ({}) }, onChanged: { addListener() {} } } };
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
    const dom = new JSDOM(inboxHtml, { url: 'chrome-extension://test/options/inbox.html', runScripts: 'outside-only' });
    let messages = 0;
    dom.window.chrome = { runtime: { sendMessage: async () => { messages++; return { ok: true, items: [] }; } },
        storage: { local: { get: async () => ({}) }, sync: { get: async () => ({ bpbSettings: { enableGarminInbox: false } }) }, onChanged: { addListener() {} } } };
    try {
        dom.window.eval(inboxSource); await tick();
        assert.equal(dom.window.document.querySelector('#inbox-content').hidden, true);
        assert.equal(dom.window.document.querySelector('#inbox-disabled').hidden, false);
        dom.window.document.querySelector('#inbox-check').click(); await tick();
        assert.equal(messages, 0);
    } finally { dom.window.close(); }
});
