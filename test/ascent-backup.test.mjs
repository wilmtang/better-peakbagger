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

const loadSurface = async ({ status, onBackup, gpxOk = true, gpxResponse = null, url = 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321' } = {}) => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8');
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const sent = [];
    dom.window.chrome = {
        runtime: {
            id: 'test',
            lastError: null,
            sendMessage: (message, callback) => {
                sent.push(message);
                let reply = null;
                if (message.type === 'GITHUB_BACKUP_STATUS') reply = status;
                else if (message.type === 'GITHUB_BACKUP_ASCENT') reply = onBackup ? onBackup(message) : { ok: true, result: {} };
                if (typeof callback === 'function') Promise.resolve().then(() => callback(reply));
                return Promise.resolve(reply);
            },
        },
    };
    dom.window.fetch = async () => gpxResponse || (gpxOk
        ? { ok: true, status: 200, headers: { get: () => 'text/gpx' }, text: async () => '<gpx><trk><trkseg></trkseg></trk></gpx>' }
        : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' });
    await evalBundle(dom.window, 'content/ascent-backup.js');
    return { dom, sent };
};

const bar = dom => dom.window.document.querySelector('.bpb-gh-bar');

test('the affordance mounts for the owner when enabled and connected', async () => {
    const { dom } = await loadSurface({ status: { enabled: true, connected: true } });
    await waitFor(dom, () => bar(dom));
    assert.match(bar(dom).textContent, /Back up this ascent to GitHub/);
    assert.ok(bar(dom).querySelector('.bpb-gh-primary'));
});

test('no affordance when the feature is disabled or not connected', async () => {
    const off = await loadSurface({ status: { enabled: false, connected: false } });
    await new Promise(r => off.dom.window.setTimeout(r, 30));
    assert.equal(bar(off.dom), null);

    const disconnected = await loadSurface({ status: { enabled: true, connected: false } });
    await new Promise(r => disconnected.dom.window.setTimeout(r, 30));
    assert.equal(bar(disconnected.dom), null);
});

test('clicking Back up fetches the track and sends the page fields, then shows success', async () => {
    let received = null;
    const { dom, sent } = await loadSurface({
        status: { enabled: true, connected: true },
        onBackup: message => { received = message; return { ok: true, result: { commitUrl: 'https://github.com/me/backup/commit/abc', isUpdate: false } }; },
    });
    await waitFor(dom, () => bar(dom));
    bar(dom).querySelector('.bpb-gh-primary').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /Backed up/.test(bar(dom).textContent));

    assert.ok(received, 'a GITHUB_BACKUP_ASCENT message was sent');
    assert.equal(received.page.ascent.id, 7654321);
    assert.equal(received.page.peak.id, 2296);
    assert.equal(received.page.peak.name, 'Mount Rainier');
    assert.match(received.gpx, /<gpx>/);           // fetched in the page session
    // Success state links to the commit.
    const link = bar(dom).querySelector('.bpb-gh-link');
    assert.equal(link.getAttribute('href'), 'https://github.com/me/backup/commit/abc');
    // Never touched a Peakbagger Save control (there are none on this page).
    assert.equal(sent.filter(m => m.type === 'GITHUB_BACKUP_ASCENT').length, 1);
});

test('a 200 error page for the track is not committed as track.gpx', async () => {
    let received = null;
    const { dom } = await loadSurface({
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
    await waitFor(dom, () => bar(dom));
    bar(dom).querySelector('.bpb-gh-primary').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /Backed up/.test(bar(dom).textContent));

    assert.ok(received, 'a GITHUB_BACKUP_ASCENT message was sent');
    // The error page was rejected: the ascent is backed up without a track,
    // never with the HTML error page stored as the GPS track.
    assert.equal(received.gpx, null);
});

test('a typed backup error shows an actionable message with a retry', async () => {
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true },
        onBackup: () => ({ ok: false, error: { code: 'rate-limit' } }),
    });
    await waitFor(dom, () => bar(dom));
    bar(dom).querySelector('.bpb-gh-primary').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /rate-limiting/.test(bar(dom).textContent));
    assert.ok(Array.from(bar(dom).querySelectorAll('button'), b => b.textContent).includes('Try again'));
});

test('an unexpected backup error shows GitHub\'s bounded detail', async () => {
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true },
        onBackup: () => ({ ok: false, error: { code: 'unknown', message: 'Repository service is temporarily unavailable.' } }),
    });
    await waitFor(dom, () => bar(dom));
    bar(dom).querySelector('.bpb-gh-primary').dispatchEvent(new dom.window.Event('click'));
    await waitFor(dom, () => /Repository service is temporarily unavailable/.test(bar(dom).textContent));
    assert.doesNotMatch(bar(dom).textContent, /something went wrong/i);
});

test('automatic mode pushes on load without a click', async () => {
    let received = null;
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true, auto: true },
        onBackup: message => { received = message; return { ok: true, result: { commitUrl: 'https://github.com/me/backup/commit/z', isUpdate: false } }; },
    });
    await waitFor(dom, () => bar(dom) && /Backed up/.test(bar(dom).textContent));
    assert.ok(received && received.auto === true, 'the push was flagged automatic');
});

test('automatic mode on a revisit falls back to the manual button, not an error', async () => {
    const { dom } = await loadSurface({
        status: { enabled: true, connected: true, auto: true },
        onBackup: () => ({ ok: false, error: { code: 'no-fresh-save' } }),
    });
    await waitFor(dom, () => bar(dom) && /Back up this ascent/.test(bar(dom).textContent));
    assert.ok(bar(dom).querySelector('.bpb-gh-primary'), 'the manual Back up button is offered');
});

test('a visitor viewing someone else’s ascent gets no affordance', async () => {
    const html = await readFile(path.join(root, 'test', 'fixtures', 'pages', 'climber-ascent.html'), 'utf8');
    // Strip the owner-only edit link before load.
    const stripped = html.replace(/<a href="\/climber\/ascentedit\.aspx\?aid=7654321">[^<]*<\/a>/, '');
    const dom = new JSDOM(stripped, { url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321', runScripts: 'outside-only' });
    let statusAsked = false;
    dom.window.chrome = { runtime: { id: 't', lastError: null, sendMessage: (m, cb) => { if (m.type === 'GITHUB_BACKUP_STATUS') statusAsked = true; if (cb) cb({ enabled: true, connected: true }); return Promise.resolve({ enabled: true, connected: true }); } } };
    dom.window.fetch = async () => ({ ok: true, text: async () => '' });
    await evalBundle(dom.window, 'content/ascent-backup.js');
    await new Promise(r => dom.window.setTimeout(r, 30));
    assert.equal(bar(dom), null);
    // Fails closed before even asking the background about status.
    assert.equal(statusAsked, false);
});
