// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureDom, evalBundle, trustedInput } from '../helpers/fixture-dom.mts';
import { makeChromeStub, waitFor, type PageChrome } from '../helpers/fixture-page.mts';
import type { StubMessage } from '../helpers/page-types.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ascentHtml = await readFile(path.join(root, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';

interface LoadSurfaceOptions {
    settings?: Record<string, unknown>;
    permissions?: Record<string, unknown>;
    results?: Record<string, Record<string, unknown>>;
    gpx?: string;
}

const loadSurface = async ({
    settings = {},
    permissions = {},
    results = {},
    gpx = GPX,
}: LoadSurfaceOptions = {}) => {
    const dom = new FixtureDom(ascentHtml, {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321',
    });
    const sent: StubMessage[] = [];
    let fetches = 0;
    const chrome: PageChrome = makeChromeStub({ bpbSettings: settings });
    const defaultSendMessage = async (message: StubMessage) => {
        sent.push(structuredClone(message));
        const type = String(message.type ?? '');
        if (type === 'GITHUB_BACKUP_STATUS') return { enabled: false, connected: false };
        if (type.endsWith('_PERMISSION_REQUEST')) {
            return permissions[type] || { ok: true };
        }
        if (type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'activation' };
        if (type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'grant' };
        if (type === 'TRUSTED_ACTION_END') return { ok: true };
        if (type.endsWith('_IMPORT_PREPARE')) {
            const name = type.startsWith('CALTOPO_') ? 'CalTopo' : type.startsWith('ALLTRAILS_')
                ? 'AllTrails'
                : type.startsWith('ONX_') ? 'onX' : 'Gaia';
            return { attemptId: message.attemptId, ...await (results[type] || {
                ok: true,
                supplied: true,
                code: 'prepared',
                targetTabId: name === 'onX' ? 10 : 9,
                message: `Ready in ${name}. Review and confirm.`,
            }) };
        }
        return null;
    };
    chrome.runtime.sendMessage = defaultSendMessage;
    dom.window.chrome = chrome;
    dom.window.fetch = (async (url: RequestInfo | URL) => {
        fetches++;
        return {
            ok: true,
            status: 200,
            url: String(url),
            redirected: false,
            headers: { get: () => 'application/gpx+xml' },
            text: async () => gpx,
        };
    }) as unknown as typeof fetch;
    await evalBundle(dom.window, 'content/ascent-gaia.js');
    return { dom, chrome, defaultSendMessage, sent, get fetches() { return fetches; } };
};

const control = (dom: FixtureDom) => dom.window.document.querySelector('.bpb-map-handoff-control');
const button = (dom: FixtureDom, provider: string) => control(dom).querySelector(`[data-provider="${provider}"]`);

test('Gaia, onX, AllTrails, and CalTopo controls mount together directly after the saved GPX download', async () => {
    const h = await loadSurface();
    const download = h.dom.window.document.querySelector('#gpxlinks a');
    assert.equal(control(h.dom).previousElementSibling, download);
    assert.deepEqual([...control(h.dom).querySelectorAll('button[data-provider]')].map(item => item.textContent!.trim()), [
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
] as const) {
    test(`trusted ${provider.id} click reads and transfers the exact saved GPX`, async () => {
        const h = await loadSurface();
        await trustedInput(button(h.dom, provider.id), { type: 'click' });
        await waitFor(h.dom, () => /Ready in/.test(control(h.dom).textContent ?? ''));
        assert.equal(h.sent.filter(message => message.type === provider.permission).length, 1);
        assert.equal(h.fetches, 1);
        const transfer = h.sent.find(message => message.type === provider.prepare)!;
        assert.equal(transfer.sourceUrl, 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321');
        assert.equal(transfer.filename, 'peakbagger-7654321.gpx');
        assert.equal(transfer.gpx, GPX);
        assert.equal(transfer.grantToken, 'grant');
        assert.equal(h.sent.find(message => message.type === 'TRUSTED_ACTION_ISSUE')!.action, provider.action);
        assert.equal(button(h.dom, provider.id).disabled, false);
        const name = { gaia: 'Gaia', onx: 'onX', alltrails: 'AllTrails', caltopo: 'CalTopo' }[provider.id];
        assert.equal(button(h.dom, provider.id).textContent!.trim(), `Send to ${name} again`);
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
    await trustedInput(button(h.dom, 'onx'), { type: 'click' });
    await waitFor(h.dom, () => /opened tab/.test(control(h.dom).textContent ?? ''));
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
    await trustedInput(button(signedOut.dom, 'onx'), { type: 'click' });
    await waitFor(signedOut.dom, () => /Sign in to onX/.test(control(signedOut.dom).textContent ?? ''));
    assert.equal(button(signedOut.dom, 'onx').disabled, false);

    const uncertain = await loadSurface({ results: {
        ONX_IMPORT_PREPARE: {
            ok: false, supplied: true, code: 'handoff-unconfirmed', targetTabId: 11, message: 'Check this onX tab.',
        },
    } });
    await trustedInput(button(uncertain.dom, 'onx'), { type: 'click' });
    await waitFor(uncertain.dom, () => /Check this onX tab/.test(control(uncertain.dom).textContent ?? ''));
    assert.equal(button(uncertain.dom, 'onx').disabled, false);
    assert.equal(button(uncertain.dom, 'onx').textContent!.trim(), 'Send to onX again');
    assert.equal(button(uncertain.dom, 'onx').getAttribute('aria-label'), 'Send saved GPX to onX Backcountry again');
    assert.equal(button(uncertain.dom, 'gaia').disabled, false);
});

test('explicit onX repeat fetches again and never reuses the possibly failed importer tab', async () => {
    const h = await loadSurface();
    await trustedInput(button(h.dom, 'onx'), { type: 'click' });
    await waitFor(h.dom, () => button(h.dom, 'onx').textContent!.includes('again'));
    await trustedInput(button(h.dom, 'onx'), { type: 'click' });
    await waitFor(h.dom, () => h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE').length === 2);
    const transfers = h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE');
    assert.equal(h.fetches, 2);
    assert.equal(transfers[0]!.targetTabId, undefined);
    assert.equal(transfers[1]!.targetTabId, undefined);
    assert.equal(transfers[1]!.gpx, GPX);
});

test('provider preferences reorder and hide buttons live, including all off', async () => {
    const h = await loadSurface({ settings: { mapProviderOrder: ['caltopo', 'gaia', 'onx', 'alltrails'], mapProvidersEnabled: ['gaia', 'caltopo'] } });
    const visible = () => [...control(h.dom).querySelectorAll('button[data-provider]')].filter(b => !b.hidden).map(b => b.dataset.provider);
    await waitFor(h.dom, () => visible()[0] === 'caltopo');
    assert.deepEqual(visible(), ['caltopo', 'gaia']);
    const disabledOnx = button(h.dom, 'onx');
    assert.equal(disabledOnx.hidden, true);
    // Even if host CSS overrides `hidden`, a real click on a disabled provider is ignored.
    disabledOnx.style.display = 'inline-block';
    await trustedInput(disabledOnx, { type: 'click' });
    disabledOnx.style.display = '';
    assert.equal(h.sent.length, 0);
    await h.chrome.storage.sync.set({ bpbSettings: { mapProvidersEnabled: [] } });
    await waitFor(h.dom, () => control(h.dom).hidden);
    assert.equal(control(h.dom).hidden, true);
    await h.chrome.storage.sync.set({ bpbSettings: { mapProvidersEnabled: ['onx'] } });
    await waitFor(h.dom, () => !control(h.dom).hidden && visible()[0] === 'onx');
    assert.equal(control(h.dom).hidden, false);
    assert.deepEqual(visible(), ['onx']);
    h.dom.window.close();
});

test('disabling providers during a handoff preserves its busy indicator and result', async () => {
    let finishPermission!: (value: unknown) => void;
    const permission = new Promise(resolve => { finishPermission = resolve; });
    const h = await loadSurface({ permissions: { GAIA_PERMISSION_REQUEST: permission } });
    await trustedInput(button(h.dom, 'gaia'), { type: 'click' });
    await h.chrome.storage.sync.set({ bpbSettings: { mapProvidersEnabled: [] } });
    assert.equal(button(h.dom, 'gaia').hidden, false);
    assert.equal(button(h.dom, 'gaia').getAttribute('aria-disabled'), 'true');
    assert.equal(control(h.dom).hidden, false);
    finishPermission({ ok: false, message: 'Access canceled.' });
    await waitFor(h.dom, () => control(h.dom).textContent!.includes('Access canceled.'));
    assert.equal(button(h.dom, 'gaia').hidden, true);
    assert.equal(control(h.dom).hidden, false, 'the completed result remains readable');
    h.dom.window.close();
});

test('onX watchdog releases every provider when the worker never replies and ignores late success', async () => {
    const h = await loadSurface();
    try {
        const nativeTimeout = h.dom.window.setTimeout.bind(h.dom.window);
        const nativeClearTimeout = h.dom.window.clearTimeout.bind(h.dom.window);
        let expireWatchdog: (() => void) | undefined;
        h.dom.window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
            if (delay === 10_000 && !expireWatchdog && typeof fn === 'function') {
                expireWatchdog = () => fn(...args);
                return 10_000;
            }
            return nativeTimeout(fn, delay, ...args);
        }) as typeof setTimeout;
        h.dom.window.clearTimeout = ((id?: number) => {
            if (id !== 10_000) nativeClearTimeout(id);
        }) as typeof clearTimeout;
        let finish: (() => void) | undefined;
        h.chrome.runtime.sendMessage = (message: StubMessage) => message.type === 'ONX_IMPORT_PREPARE'
            ? new Promise(resolve => { finish = () => resolve({ ok: true, supplied: true, attemptId: message.attemptId, message: 'Late ready.' }); })
            : message.type === 'ONX_IMPORT_STATUS' ? Promise.resolve({ code: 'pending', attemptId: message.attemptId, targetTabId: 11 }) : h.defaultSendMessage(message);
        await trustedInput(button(h.dom, 'onx'), { type: 'click' });
        await waitFor(h.dom, () => finish && expireWatchdog);
        expireWatchdog!();
        await waitFor(h.dom, () => button(h.dom, 'onx').getAttribute('aria-busy') === 'false');
        assert.match(control(h.dom).textContent ?? '', /Check onX before sending again/);
        assert.equal(button(h.dom, 'gaia').getAttribute('aria-disabled'), 'false');
        finish!();
        await new Promise(resolve => nativeTimeout(resolve, 20));
        assert.doesNotMatch(control(h.dom).textContent ?? '', /Late ready/);
    } finally { h.dom.window.close(); }
});

test('Continue export rereads GPX and binds recovery to the previous attempt', async () => {
    const h = await loadSurface({ results: { ONX_IMPORT_PREPARE: {
        ok: false, supplied: false, canContinue: true, targetTabId: 11, message: 'Open onX and sign in if prompted.',
    } } });
    try {
        await trustedInput(button(h.dom, 'onx'), { type: 'click' });
        await waitFor(h.dom, () => button(h.dom, 'onx').textContent!.includes('Continue export'));
        const first = h.sent.find(message => message.type === 'ONX_IMPORT_PREPARE')!;
        await trustedInput(button(h.dom, 'onx'), { type: 'click' });
        await waitFor(h.dom, () => h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE').length === 2);
        const second = h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE')[1]!;
        assert.equal(second.resumeAttemptId, first.attemptId);
        assert.notEqual(second.attemptId, first.attemptId);
        assert.equal(h.fetches, 2);
    } finally { h.dom.window.close(); }
});

test('Open onX only focuses the target and pagehide prevents queued UI resurrection', async () => {
    const h = await loadSurface();
    try {
        await trustedInput(button(h.dom, 'onx'), { type: 'click' });
        await waitFor(h.dom, () => button(h.dom, 'onx').textContent!.includes('again'));
        const count = h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE').length;
        await trustedInput(h.dom.window.document.querySelector('.bpb-onx-open'), { type: 'click' });
        await waitFor(h.dom, () => h.sent.some(message => message.type === 'ONX_IMPORT_OPEN'));
        assert.equal(h.sent.filter(message => message.type === 'ONX_IMPORT_PREPARE').length, count);
        h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
        h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
        assert.equal(button(h.dom, 'onx').getAttribute('aria-busy'), 'false');
    } finally { h.dom.window.close(); }
});

test('page suspension during onX permission approval cannot start an export later', async () => {
    let release!: (value: unknown) => void;
    const h = await loadSurface({ permissions: { ONX_PERMISSION_REQUEST: new Promise(resolve => { release = resolve; }) } });
    try {
        await trustedInput(button(h.dom, 'onx'), { type: 'click' });
        h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
        release({ ok: true });
        h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
        await waitFor(h.dom, () => button(h.dom, 'onx').getAttribute('aria-busy') === 'false');
        assert.equal(h.fetches, 0);
        assert.equal(h.sent.some(message => message.type === 'ONX_IMPORT_PREPARE'), false);
    } finally { h.dom.window.close(); }
});
