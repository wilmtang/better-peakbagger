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
        storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } },
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
    storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } } };
    dom.window.eval(inboxSource); await tick();
    assert.equal(dom.window.document.querySelectorAll('.garmin-activity').length, 1);
    assert.equal(dom.window.document.querySelector('#inbox-update-key').hidden, false);
    dom.window.document.querySelector('.garmin-activity button').click();
    assert.equal(dom.window.document.querySelector('#inbox-review').hidden, false);
    assert.match(dom.window.document.querySelector('#inbox-matches').textContent, /Example Peak/);
    dom.window.close();
});
