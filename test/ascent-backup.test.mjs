// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the built ascent.aspx backup surface (content/ascent-backup.js) in
// jsdom against the masked ascent fixture. Pins the fail-closed gates (owner +
// enabled + connected), the affordance, the GPX fetch in the page session, the
// GITHUB_BACKUP_ASCENT message shape, and the success/error render.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { evalBundle, waitFor } from './helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadSurface = async ({ status, onBackup, editOk = true, gpxOk = true, gpxResponse = null, url = 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321' } = {}) => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8');
    const rawEditHtml = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascentedit.html'), 'utf8');
    const editDom = new JSDOM(rawEditHtml);
    const editDoc = editDom.window.document;
    editDoc.getElementById('DateText').setAttribute('value', '2026-07-12');
    editDoc.getElementById('PointFt').setAttribute('value', '14411');
    editDoc.getElementById('PeakListBox').innerHTML = '<option value="2296" selected>Mount Rainier</option>';
    editDoc.getElementById('JournalText').textContent = '[b]Great climb[/b] under blue skies.';
    const editHtml = editDom.serialize();
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const sent = [];
    dom.window.chrome = {
        runtime: {
            id: 'test',
            lastError: null,
            getManifest: () => ({ version: '3.0.0' }),
            sendMessage: async message => {
                sent.push(message);
                let reply = null;
                if (message.type === 'GITHUB_BACKUP_STATUS') reply = status;
                else if (message.type === 'GITHUB_BACKUP_ASCENT') reply = onBackup ? onBackup(message) : { ok: true, result: {} };
                return reply;
            },
        },
    };
    dom.window.fetch = async target => {
        if (/ascentedit\.aspx/i.test(String(target))) {
            return editOk
                ? { ok: true, status: 200, url: String(target), redirected: false, headers: { get: () => 'text/html' }, text: async () => editHtml }
                : { ok: false, status: 500, url: String(target), redirected: false, headers: { get: () => 'text/html' }, text: async () => '' };
        }
        return gpxResponse || (gpxOk
            ? { ok: true, status: 200, headers: { get: () => 'text/gpx' }, text: async () => '<gpx><trk><trkseg></trkseg></trk></gpx>' }
            : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' });
    };
    await evalBundle(dom.window, 'content/ascent-backup.js');
    return { dom, sent };
};

const control = dom => dom.window.document.querySelector('.bpb-gh-control');

test('the affordance mounts as a compact control beside the native ascent actions', async () => {
    const { dom } = await loadSurface({ status: { enabled: true, connected: true } });
    await waitFor(dom, () => control(dom));
    const actions = dom.window.document.getElementById('owneractions');
    assert.equal(control(dom).parentElement, actions);
    assert.equal(control(dom).textContent.trim(), 'Back up to GitHub');
    assert.equal(dom.window.document.body.firstElementChild, dom.window.document.getElementById('page'));
});

test('no affordance when the feature is disabled or not connected', async () => {
    const off = await loadSurface({ status: { enabled: false, connected: false } });
    await new Promise(r => off.dom.window.setTimeout(r, 30));
    assert.equal(control(off.dom), null);

    const disconnected = await loadSurface({ status: { enabled: true, connected: false } });
    await new Promise(r => disconnected.dom.window.setTimeout(r, 30));
    assert.equal(control(disconnected.dom), null);
});

test('clicking Back up fetches the track and sends the page fields, then shows success', async () => {
    let received = null;
    const { dom, sent } = await loadSurface({
        status: { enabled: true, connected: true },
        onBackup: message => { received = message; return { ok: true, result: { commitUrl: 'https://github.com/me/backup/commit/abc', isUpdate: false } }; },
    });
    await waitFor(dom, () => control(dom));
    control(dom).querySelector('.bpb-gh-btn').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /Backed up/.test(control(dom).textContent));

    assert.ok(received, 'a GITHUB_BACKUP_ASCENT message was sent');
    assert.equal(received.pageComplete, true);
    assert.equal(received.page.ascent.id, 7654321);
    assert.equal(received.page.ascent.date, '2026-07-12');
    assert.equal(received.page.ascent.type, 'Successful Ascent (stood on the summit)');
    assert.equal(received.page.ascent.pointFt, '14411');
    assert.equal(received.page.peak.id, 2296);
    assert.equal(received.page.peak.name, 'Mount Rainier');
    assert.match(received.page.report.markdown, /\*\*Great climb\*\*/);
    assert.match(received.gpx, /<gpx>/);           // fetched in the page session
    // Success state links to the commit.
    const link = control(dom).querySelector('.bpb-gh-link');
    assert.equal(link.getAttribute('href'), 'https://github.com/me/backup/commit/abc');
    // Never touched a Peakbagger Save control (there are none on this page).
    assert.equal(sent.filter(m => m.type === 'GITHUB_BACKUP_ASCENT').length, 1);
});

test('a 200 error page for a displayed track aborts without replacing the backup', async () => {
    let received = null;
    const { dom, sent } = await loadSurface({
        status: { enabled: true, connected: true },
        // A 200 whose body is an HTML error page, not a GPX document — what a
        // renamed/redirected endpoint would return.
        gpxResponse: {
            ok: true,
            status: 200,
            redirected: true,
            url: 'https://www.peakbagger.com/PBError.aspx',
            headers: { get: name => (/content-type/i.test(name) ? 'text/html; charset=utf-8' : null) },
            text: async () => '<html><head><title>Error - Peakbagger.com</title></head><body>Something went wrong.</body></html>',
        },
        onBackup: message => { received = message; return { ok: true, result: {} }; },
    });
    await waitFor(dom, () => control(dom));
    control(dom).querySelector('.bpb-gh-btn').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /could not read the stored GPS track/i.test(control(dom).textContent));

    assert.equal(received, null, 'an ambiguous track failure must not send a destructive replacement');
    assert.equal(sent.filter(m => m.type === 'GITHUB_BACKUP_ASCENT').length, 0);
});

test('an incomplete edit-form response aborts without sending a sparse backup', async () => {
    const { dom, sent } = await loadSurface({
        status: { enabled: true, connected: true },
        editOk: false,
    });
    await waitFor(dom, () => control(dom));
    control(dom).querySelector('.bpb-gh-btn').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /could not read the saved ascent form/i.test(control(dom).textContent));
    assert.equal(sent.filter(m => m.type === 'GITHUB_BACKUP_ASCENT').length, 0);
});

test('a typed backup error shows an actionable message with a retry', async () => {
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true },
        onBackup: () => ({ ok: false, error: { code: 'rate-limit' } }),
    });
    await waitFor(dom, () => control(dom));
    control(dom).querySelector('.bpb-gh-btn').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /rate-limiting/.test(control(dom).textContent));
    assert.ok(Array.from(control(dom).querySelectorAll('button'), b => b.textContent).includes('Try again'));
});

test('an unexpected backup error shows GitHub\'s bounded detail', async () => {
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true },
        onBackup: () => ({ ok: false, error: { code: 'unknown', message: 'Repository service is temporarily unavailable.' } }),
    });
    await waitFor(dom, () => control(dom));
    control(dom).querySelector('.bpb-gh-btn').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /Repository service is temporarily unavailable/.test(control(dom).textContent));
    assert.doesNotMatch(control(dom).textContent, /something went wrong/i);
});

test('automatic mode pushes on load without a click', async () => {
    let received = null;
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true, auto: true },
        onBackup: message => { received = message; return { ok: true, result: { commitUrl: 'https://github.com/me/backup/commit/z', isUpdate: false } }; },
    });
    await waitFor(dom, () => control(dom) && /Backed up/.test(control(dom).textContent));
    assert.ok(received && received.auto === true, 'the push was flagged automatic');
});

test('automatic mode on a revisit falls back to the manual button, not an error', async () => {
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true, auto: true },
        onBackup: () => ({ ok: false, error: { code: 'no-fresh-save' } }),
    });
    await waitFor(dom, () => control(dom) && /Back up to GitHub/.test(control(dom).textContent));
    assert.ok(control(dom).querySelector('.bpb-gh-btn'), 'the manual Back up button is offered');
});

test('a visitor viewing someone else’s ascent gets no affordance', async () => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8');
    // Strip the owner-only edit link before load.
    const stripped = html.replace(/<a href="\/climber\/ascentedit\.aspx\?aid=7654321">[^<]*<\/a>/, '');
    const dom = new JSDOM(stripped, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321', runScripts: 'outside-only' });
    let statusAsked = false;
    dom.window.chrome = { runtime: { id: 't', lastError: null, sendMessage: async m => { if (m.type === 'GITHUB_BACKUP_STATUS') statusAsked = true; return { enabled: true, connected: true }; } } };
    dom.window.fetch = async () => ({ ok: true, text: async () => '' });
    await evalBundle(dom.window, 'content/ascent-backup.js');
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(control(dom), null);
    // Fails closed before even asking the background about status.
    assert.equal(statusAsked, false);
});
