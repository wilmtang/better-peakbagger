// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await fs.readFile(new URL('../../dist/peakbagger-page.js', import.meta.url), 'utf8');
const ORIGIN = 'https://www.peakbagger.com';
const LOGIN_URL = `${ORIGIN}/Default.aspx`;
const PEAKS_URL = `${ORIGIN}/Async/pllbb2.aspx?miny=1&maxy=2&minx=3&maxx=4`;

const load = ({ url = LOGIN_URL, fetchFn = async () => ({
    ok: true,
    status: 200,
    url: LOGIN_URL,
    redirected: false,
    headers: new Headers(),
    text: async () => '<html><a href="/climber/climber.aspx?cid=77">My Home Page</a></html>',
}) } = {}) => {
    const dom = new JSDOM('<!doctype html><title>Peakbagger</title>', { url, runScripts: 'outside-only' });
    dom.window.fetch = fetchFn;
    dom.window.eval(source);
    return dom;
};

const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition not reached');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
};

test('the page transport uses the signed-in page fetch policy for its two capture resources', async () => {
    const calls = [];
    const dom = load({
        fetchFn: async (url, init) => {
            calls.push({ url, init });
            const peaks = String(url).includes('/Async/');
            return {
                ok: true,
                status: 200,
                url,
                redirected: false,
                headers: new Headers(),
                text: async () => peaks
                    ? '<p><t i="7" n="Test Peak" a="1" o="2" e="3" r="4" l="Range"/></p>'
                    : '<html><a href="/climber/climber.aspx?cid=77">My Home Page</a></html>',
            };
        },
    });
    const api = dom.window.BPBPeakbaggerPage;

    assert.equal(api.version, 1);
    assert.equal(Object.isFrozen(api), true);
    assert.equal((await api.request('login-1', LOGIN_URL, 'html')).kind, 'ok');
    assert.equal((await api.request('peaks-1', PEAKS_URL, 'peaks')).kind, 'ok');
    assert.deepEqual(calls.map(call => call.url), [LOGIN_URL, PEAKS_URL]);
    for (const { init } of calls) {
        assert.equal(init.credentials, 'include');
        assert.equal(init.redirect, 'follow');
        assert.equal(init.cache, 'no-store');
    }
});

test('the page transport refuses arbitrary same-origin and cross-origin requests before fetch', async () => {
    let fetches = 0;
    const dom = load({ fetchFn: async () => { fetches++; throw new Error('must not fetch'); } });
    const api = dom.window.BPBPeakbaggerPage;
    const invalid = [
        [LOGIN_URL, 'edit'],
        [`${ORIGIN}/climber/ClimberEdit.aspx?cid=77`, 'html'],
        ['https://example.com/Default.aspx', 'html'],
        [`${PEAKS_URL}&extra=1`, 'peaks'],
        [`${ORIGIN}/Async/pllbb2.aspx?miny=2&maxy=1&minx=3&maxx=4`, 'peaks'],
        [`${ORIGIN}/Async/pllbb2.aspx?miny=-91&maxy=1&minx=3&maxx=4`, 'peaks'],
    ];

    for (const [url, kind] of invalid) {
        const result = await api.request(`invalid-${fetches}-${kind}`, url, kind);
        assert.equal(result.error.code, 'invalid-request', `${kind}: ${url}`);
    }
    assert.equal(fetches, 0);
});

test('a non-canonical Peakbagger page cannot use the transport', async () => {
    let fetches = 0;
    const dom = load({
        url: 'https://peakbagger.com/Default.aspx',
        fetchFn: async () => { fetches++; throw new Error('must not fetch'); },
    });
    const result = await dom.window.BPBPeakbaggerPage.request('wrong-page', LOGIN_URL, 'html');
    assert.equal(result.error.code, 'invalid-request');
    assert.equal(fetches, 0);
});

test('cancelling one page request aborts only that request and clears its owner', async () => {
    let signal;
    const dom = load({
        fetchFn: async (_url, init) => {
            signal = init.signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        },
    });
    const api = dom.window.BPBPeakbaggerPage;
    const pending = api.request('cancel-me', LOGIN_URL, 'html');
    await until(() => !!signal);

    assert.equal(api.cancel('not-mine'), false);
    assert.equal(signal.aborted, false);
    assert.equal(api.cancel('cancel-me'), true);
    const result = await pending;
    assert.equal(result.error.code, 'cancelled');
    assert.equal(signal.aborted, true);
    assert.equal(api.cancel('cancel-me'), false);
});
