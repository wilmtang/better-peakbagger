// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { evalBundle, fireTrustedEvent, waitFor } from '../helpers/load-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';

const loadSurface = async ({ permission = { ok: true }, result = null, gpx = GPX } = {}) => {
    const html = await readFile(path.join(root, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321',
        runScripts: 'outside-only',
    });
    const sent = [];
    let fetches = 0;
    dom.window.chrome = {
        runtime: {
            id: 'test',
            getManifest: () => ({ version: '3.7.2' }),
            sendMessage: async message => {
                sent.push(structuredClone(message));
                if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: false, connected: false };
                if (message.type === 'GAIA_PERMISSION_REQUEST') return permission;
                if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'activation' };
                if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'grant' };
                if (message.type === 'TRUSTED_ACTION_END') return { ok: true };
                if (message.type === 'GAIA_IMPORT_PREPARE') return result || {
                    ok: true,
                    supplied: true,
                    code: 'prepared',
                    targetTabId: 9,
                    message: 'Ready in Gaia. Review the items and click Save.',
                };
                return null;
            },
        },
    };
    dom.window.fetch = async url => {
        fetches++;
        return {
            ok: true,
            status: 200,
            url: String(url),
            redirected: false,
            headers: { get: () => 'application/gpx+xml' },
            text: async () => gpx,
        };
    };
    await evalBundle(dom.window, 'content/ascent-gaia.js');
    return { dom, sent, get fetches() { return fetches; } };
};

const control = dom => dom.window.document.querySelector('.bpb-gaia-control');

test('Send to Gaia mounts directly after the saved GPX download', async () => {
    const h = await loadSurface();
    const download = h.dom.window.document.querySelector('#gpxlinks a');
    assert.equal(control(h.dom).previousElementSibling, download);
    assert.equal(control(h.dom).querySelector('button').textContent.trim(), 'Send to Gaia');
    assert.equal(control(h.dom).getAttribute('aria-label'), 'Send saved GPX to Gaia GPS');
    assert.equal(h.fetches, 0);
});

test('later GPX Analyzer insertion cannot separate the button from the download', async () => {
    const h = await loadSurface();
    const download = h.dom.window.document.querySelector('#gpxlinks a');
    const analyzer = h.dom.window.document.createElement('div');
    analyzer.id = 'bpb-gpx-analysis';
    download.after(analyzer);
    await waitFor(h.dom, () => download.nextElementSibling === control(h.dom));
    assert.equal(control(h.dom).nextElementSibling, analyzer);
});

test('a persisted history restore re-establishes placement observation', async () => {
    const h = await loadSurface();
    const download = h.dom.window.document.querySelector('#gpxlinks a');
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    const analyzer = h.dom.window.document.createElement('div');
    analyzer.id = 'bpb-gpx-analysis';
    download.after(analyzer);
    assert.equal(download.nextElementSibling, analyzer);
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(h.dom, () => download.nextElementSibling === control(h.dom));
    assert.equal(control(h.dom).nextElementSibling, analyzer);
});

test('trusted click requests optional Gaia access, reads the exact GPX and renders success', async () => {
    const h = await loadSurface();
    fireTrustedEvent(control(h.dom).querySelector('button'), 'click');
    await waitFor(h.dom, () => /Ready in Gaia/.test(control(h.dom).textContent));
    assert.equal(h.sent.filter(message => message.type === 'GAIA_PERMISSION_REQUEST').length, 1);
    assert.equal(h.fetches, 1);
    const transfer = h.sent.find(message => message.type === 'GAIA_IMPORT_PREPARE');
    assert.equal(transfer.sourceUrl, 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321');
    assert.equal(transfer.filename, 'peakbagger-7654321.gpx');
    assert.equal(transfer.gpx, GPX);
    assert.equal(transfer.grantToken, 'grant');
    assert.equal(control(h.dom).querySelector('button').disabled, true);
});

test('permission denial sends no GPX and leaves a safe retry', async () => {
    const h = await loadSurface({ permission: {
        ok: false,
        code: 'permission-setup-opened',
        message: 'Allow Gaia access in the opened tab, then click Send to Gaia again.',
    } });
    fireTrustedEvent(control(h.dom).querySelector('button'), 'click');
    await waitFor(h.dom, () => /opened tab/.test(control(h.dom).textContent));
    assert.equal(h.fetches, 0);
    assert.equal(h.sent.some(message => message.type === 'GAIA_IMPORT_PREPARE'), false);
    assert.equal(control(h.dom).querySelector('button').disabled, false);
});

test('untrusted page events cannot request permission or read the GPX', async () => {
    const h = await loadSurface();
    control(h.dom).querySelector('button').dispatchEvent(new h.dom.window.Event('click'));
    await new Promise(resolve => h.dom.window.setTimeout(resolve, 20));
    assert.equal(h.sent.some(message => message.type === 'GAIA_PERMISSION_REQUEST'), false);
    assert.equal(h.fetches, 0);
});

test('signed-out Gaia allows retry while an uncertain handoff does not', async () => {
    const signedOut = await loadSurface({ result: {
        ok: false, supplied: false, code: 'sign-in-required', targetTabId: 10, message: 'Sign in to Gaia.',
    } });
    fireTrustedEvent(control(signedOut.dom).querySelector('button'), 'click');
    await waitFor(signedOut.dom, () => /Sign in to Gaia/.test(control(signedOut.dom).textContent));
    assert.equal(control(signedOut.dom).querySelector('button').disabled, false);
    assert.equal(control(signedOut.dom).querySelector('.bpb-gaia-label').textContent, 'Try again');

    const uncertain = await loadSurface({ result: {
        ok: false, supplied: true, code: 'handoff-unconfirmed', targetTabId: 11, message: 'Check this Gaia tab.',
    } });
    fireTrustedEvent(control(uncertain.dom).querySelector('button'), 'click');
    await waitFor(uncertain.dom, () => /Check this Gaia tab/.test(control(uncertain.dom).textContent));
    assert.equal(control(uncertain.dom).querySelector('button').disabled, true);
    assert.equal(control(uncertain.dom).querySelector('.bpb-gaia-label').textContent, 'Check Gaia');
});
