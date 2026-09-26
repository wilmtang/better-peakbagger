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

const loadSurface = async ({
    permissions = {},
    results = {},
    gpx = GPX,
} = {}) => {
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
                if (message.type.endsWith('_PERMISSION_REQUEST')) {
                    return permissions[message.type] || { ok: true };
                }
                if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'activation' };
                if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'grant' };
                if (message.type === 'TRUSTED_ACTION_END') return { ok: true };
                if (message.type.endsWith('_IMPORT_PREPARE')) {
                    const name = message.type.startsWith('CALTOPO_') ? 'CalTopo' : message.type.startsWith('ALLTRAILS_')
                        ? 'AllTrails'
                        : message.type.startsWith('ONX_') ? 'onX' : 'Gaia';
                    return results[message.type] || {
                        ok: true,
                        supplied: true,
                        code: 'prepared',
                        targetTabId: name === 'onX' ? 10 : 9,
                        message: `Ready in ${name}. Review and confirm.`,
                    };
                }
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

const control = dom => dom.window.document.querySelector('.bpb-map-handoff-control');
const button = (dom, provider) => control(dom).querySelector(`[data-provider="${provider}"]`);

test('Gaia, onX, AllTrails, and CalTopo controls mount together directly after the saved GPX download', async () => {
    const h = await loadSurface();
    const download = h.dom.window.document.querySelector('#gpxlinks a');
    assert.equal(control(h.dom).previousElementSibling, download);
    assert.deepEqual([...control(h.dom).querySelectorAll('button')].map(item => item.textContent.trim()), [
        'Send to Gaia',
        'Send to onX',
        'Send to AllTrails',
        'Send to CalTopo',
    ]);
    assert.equal(button(h.dom, 'gaia').getAttribute('aria-label'), 'Send saved GPX to Gaia GPS');
    assert.equal(button(h.dom, 'onx').getAttribute('aria-label'), 'Send saved GPX to onX Backcountry');
    assert.equal(button(h.dom, 'alltrails').getAttribute('aria-label'), 'Send saved GPX to AllTrails');
    assert.equal(control(h.dom).getAttribute('aria-label'), 'Send saved GPX to a map');
    assert.equal(h.fetches, 0);
});

test('later GPX Analyzer insertion cannot separate the controls from the download', async () => {
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
    download.after(analyzer);
    assert.equal(download.nextElementSibling, analyzer);
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(h.dom, () => download.nextElementSibling === control(h.dom));
});

for (const provider of [
    { id: 'gaia', permission: 'GAIA_PERMISSION_REQUEST', prepare: 'GAIA_IMPORT_PREPARE', action: 'gaia-import' },
    { id: 'onx', permission: 'ONX_PERMISSION_REQUEST', prepare: 'ONX_IMPORT_PREPARE', action: 'onx-import' },
    { id: 'caltopo', permission: 'CALTOPO_PERMISSION_REQUEST', prepare: 'CALTOPO_IMPORT_PREPARE', action: 'caltopo-import' },
    { id: 'alltrails', permission: 'ALLTRAILS_PERMISSION_REQUEST', prepare: 'ALLTRAILS_IMPORT_PREPARE', action: 'alltrails-import' },
]) {
    test(`trusted ${provider.id} click reads and transfers the exact saved GPX`, async () => {
        const h = await loadSurface();
        fireTrustedEvent(button(h.dom, provider.id), 'click');
        await waitFor(h.dom, () => /Ready in/.test(control(h.dom).textContent));
        assert.equal(h.sent.filter(message => message.type === provider.permission).length, 1);
        assert.equal(h.fetches, 1);
        const transfer = h.sent.find(message => message.type === provider.prepare);
        assert.equal(transfer.sourceUrl, 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321');
        assert.equal(transfer.filename, 'peakbagger-7654321.gpx');
        assert.equal(transfer.gpx, GPX);
        assert.equal(transfer.grantToken, 'grant');
        assert.equal(h.sent.find(message => message.type === 'TRUSTED_ACTION_ISSUE').action, provider.action);
        assert.equal(button(h.dom, provider.id).disabled, false);
        const name = { gaia: 'Gaia', onx: 'onX', alltrails: 'AllTrails', caltopo: 'CalTopo' }[provider.id];
        assert.equal(button(h.dom, provider.id).textContent.trim(), `Send to ${name} again`);
        for (const other of ['gaia', 'onx', 'alltrails', 'caltopo'].filter(id => id !== provider.id)) {
            assert.equal(button(h.dom, other).disabled, false);
        }
    });
}

test('permission denial sends no GPX and leaves every destination retryable', async () => {
    const h = await loadSurface({ permissions: {
        ONX_PERMISSION_REQUEST: {
            ok: false,
            code: 'permission-setup-opened',
            message: 'Allow onX access in the opened tab, then click Send to onX again.',
        },
    } });
    fireTrustedEvent(button(h.dom, 'onx'), 'click');
    await waitFor(h.dom, () => /opened tab/.test(control(h.dom).textContent));
    assert.equal(h.fetches, 0);
    assert.equal(h.sent.some(message => message.type === 'ONX_IMPORT_PREPARE'), false);
    assert.equal(button(h.dom, 'gaia').disabled, false);
    assert.equal(button(h.dom, 'onx').disabled, false);
    assert.equal(button(h.dom, 'alltrails').disabled, false);
});

test('untrusted page events cannot request permission or read the GPX', async () => {
    const h = await loadSurface();
    button(h.dom, 'onx').dispatchEvent(new h.dom.window.Event('click'));
    await new Promise(resolve => h.dom.window.setTimeout(resolve, 20));
    assert.equal(h.sent.some(message => message.type === 'ONX_PERMISSION_REQUEST'), false);
    assert.equal(h.fetches, 0);
});

test('sign-in and uncertain handoffs both leave an explicit user-controlled retry', async () => {
    const signedOut = await loadSurface({ results: {
        ONX_IMPORT_PREPARE: {
            ok: false, supplied: false, code: 'sign-in-required', targetTabId: 10, message: 'Sign in to onX.',
        },
    } });
    fireTrustedEvent(button(signedOut.dom, 'onx'), 'click');
    await waitFor(signedOut.dom, () => /Sign in to onX/.test(control(signedOut.dom).textContent));
    assert.equal(button(signedOut.dom, 'onx').disabled, false);

    const uncertain = await loadSurface({ results: {
        ONX_IMPORT_PREPARE: {
            ok: false, supplied: true, code: 'handoff-unconfirmed', targetTabId: 11, message: 'Check this onX tab.',
        },
    } });
    fireTrustedEvent(button(uncertain.dom, 'onx'), 'click');
    await waitFor(uncertain.dom, () => /Check this onX tab/.test(control(uncertain.dom).textContent));
    assert.equal(button(uncertain.dom, 'onx').disabled, false);
    assert.equal(button(uncertain.dom, 'onx').textContent.trim(), 'Send to onX again');
    assert.equal(button(uncertain.dom, 'onx').getAttribute('aria-label'), 'Send saved GPX to onX Backcountry again');
    assert.equal(button(uncertain.dom, 'gaia').disabled, false);
});

test('explicit onX repeat fetches again and never reuses the possibly failed importer tab', async () => {
    const h = await loadSurface();
    fireTrustedEvent(button(h.dom, 'onx'), 'click');
    await waitFor(h.dom, () => button(h.dom, 'onx').textContent.includes('again'));
    fireTrustedEvent(button(h.dom, 'onx'), 'click');
    await waitFor(h.dom, () => h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE').length === 2);
    const transfers = h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE');
    assert.equal(h.fetches, 2);
    assert.equal(transfers[0].targetTabId, undefined);
    assert.equal(transfers[1].targetTabId, undefined);
    assert.equal(transfers[1].gpx, GPX);
});
