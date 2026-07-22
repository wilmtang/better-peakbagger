// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { peakbaggerError as PeakbaggerError } from '../src/peakbagger-error.js';
import {
    fetchPeakbaggerDocument,
    fetchPeakbaggerResource,
} from '../src/peakbagger-request.js';

const URL = 'https://www.peakbagger.com/report/report.aspx?r=b';
const BUDDIES = `<!doctype html><html><body>
    <a href="/climber/ClimbListC.aspx?cid=77">My Ascents</a>
    <h1>Buddy List</h1><table id="RGridView"><tr><td>Buddy</td></tr></table>
</body></html>`;

const response = ({
    status = 200,
    body = BUDDIES,
    url = URL,
    redirected = false,
    headers = new Headers(),
    readError = null,
} = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers,
    text: async () => {
        if (readError) throw readError;
        return body;
    },
});

test('the shared request sends the authenticated no-cache policy and returns only classified data', async () => {
    let request;
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async (url, init) => {
            request = { url, init };
            return response();
        },
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.text, BUDDIES);
    assert.equal(request.url, URL);
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.redirect, 'follow');
    assert.equal(request.init.cache, 'no-store');
    assert.ok(request.init.signal instanceof AbortSignal);
});

test('a valid 200 Buddy report ignores Cloudflare metadata', async () => {
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({
            headers: new Headers({ 'cf-mitigated': 'challenge' }),
            body: `${BUDDIES}<script>window._cf_chl_opt={}</script>`,
        }),
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.status, 200);
    assert.match(result.text, /id="RGridView"/);
});

test('Cloudflare is detected only from a 403 managed-challenge response', async () => {
    for (const challenged of [
        response({ status: 403, body: '<html><title>Just a moment...</title></html>' }),
        response({
            status: 403,
            body: '<html><title>Attention required</title></html>',
            headers: new Headers({ 'cf-mitigated': 'challenge' }),
        }),
    ]) {
        const result = await fetchPeakbaggerResource(URL, {
            kind: 'buddies', fetchFn: async () => challenged,
        });
        assert.equal(result.kind, 'challenged');
        assert.equal(result.error.code, 'cloudflare');
        assert.match(result.reason, /human check/i);
        assert.equal(result.text, undefined, 'challenge HTML must not escape the request boundary');
    }
});

test('a bare HTTP 403 is not mislabeled as Cloudflare', async () => {
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 403, body: 'Forbidden' }),
    });
    assert.equal(result.kind, 'wrong-content');
    assert.equal(result.error.code, 'http');
    assert.doesNotMatch(result.reason, /human check/i);
});

test('rate limits and server failures remain transient but are not mislabeled as Cloudflare', async () => {
    const rateLimit = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 429, body: 'slow down' }),
    });
    assert.equal(rateLimit.kind, 'transient');
    assert.equal(rateLimit.error.code, 'rate-limit');

    const server = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 503, body: 'maintenance' }),
    });
    assert.equal(server.kind, 'transient');
    assert.equal(server.error.code, 'server');
});

test('network rejection, timeout, and unreadable bodies have distinct errors', async () => {
    const network = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => { throw new Error('socket failed'); },
    });
    assert.equal(network.error.code, 'network');
    assert.doesNotMatch(network.reason, /socket failed/, 'raw transport details must not leak into UI copy');

    const timeout = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', timeoutMs: 5, fetchFn: () => new Promise(() => {}),
    });
    assert.equal(timeout.error.code, 'timeout');

    const unreadable = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ readError: new Error('stream reset') }),
    });
    assert.equal(unreadable.error.code, 'response-read');
});

test('signed-out, missing, redirected error, and page-drift responses remain distinguishable', async () => {
    const signedOut = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({
            body: '<html><a href="/Default.aspx">Log In</a><form id="LoginForm"><input id="PasswordText"></form></html>',
            url: 'https://www.peakbagger.com/Default.aspx',
            redirected: true,
        }),
    });
    assert.equal(signedOut.error.code, 'signed-out');

    const missing = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 404, body: 'missing' }),
    });
    assert.equal(missing.error.code, 'not-found');

    const redirected = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({
            body: '<html><h1>Peakbagger Error</h1></html>',
            url: 'https://www.peakbagger.com/PBError.aspx',
            redirected: true,
        }),
    });
    assert.equal(redirected.error.code, 'unexpected-content');
    assert.match(redirected.reason, /redirected to PBError\.aspx/);

    const drift = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ body: '<html><h1>Renamed Friends</h1></html>' }),
    });
    assert.equal(drift.error.code, 'unexpected-content');
});

test('a public climber page is valid even when its navigation includes Log In', async () => {
    const result = await fetchPeakbaggerResource('https://www.peakbagger.com/climber/climber.aspx?cid=88', {
        kind: 'climber',
        fetchFn: async () => response({
            url: 'https://www.peakbagger.com/climber/climber.aspx?cid=88',
            body: '<html><a href="/Default.aspx">Log In</a><h1>Public Climber</h1><a href="ClimbListC.aspx?cid=88">Ascent List</a></html>',
        }),
    });
    assert.equal(result.kind, 'ok');
});

test('invalid origins fail before fetch and parser failures become typed page errors', async () => {
    let called = false;
    const invalid = await fetchPeakbaggerResource('https://peakbagger.com.evil.example/Default.aspx', {
        kind: 'html', fetchFn: async () => { called = true; },
    });
    assert.equal(invalid.error.code, 'invalid-request');
    assert.equal(called, false);

    class BrokenParser {
        parseFromString() { throw new Error('parser crashed'); }
    }
    const parsed = await fetchPeakbaggerDocument(URL, {
        kind: 'buddies', parser: BrokenParser, fetchFn: async () => response(),
    });
    assert.equal(parsed.kind, 'wrong-content');
    assert.equal(parsed.error.code, 'parse');

    const domParser = new JSDOM('').window.DOMParser;
    const success = await fetchPeakbaggerDocument(URL, {
        kind: 'buddies', parser: domParser, fetchFn: async () => response(),
    });
    assert.equal(success.kind, 'ok');
    assert.ok(success.document.querySelector('#RGridView'));
});

test('recovery actions point at sign-in, the challenged resource, or nowhere for local storage', () => {
    assert.deepEqual(PeakbaggerError.recovery({ code: 'signed-out' }), {
        label: 'Sign in to Peakbagger', href: 'https://www.peakbagger.com/Default.aspx',
    });
    assert.deepEqual(PeakbaggerError.recovery({ code: 'cloudflare' }, { url: URL }), {
        label: 'Complete check on Peakbagger', href: URL,
    });
    assert.equal(PeakbaggerError.recovery({ code: 'storage' }), null);
});
