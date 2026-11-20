// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { peakbaggerError as PeakbaggerError } from '../../src/peakbagger/peakbagger-error.ts';
import {
    fetchPeakbaggerDocument,
    fetchPeakbaggerResource,
} from '../../src/peakbagger/peakbagger-request.ts';
import { MAX_PEAKBAGGER_PEAKS_BYTES } from '../../src/capture/capture-resource-limits.ts';

const URL = 'https://www.peakbagger.com/report/report.aspx?r=b';
const BUDDIES = `<!doctype html><html><body>
    <a href="/climber/ClimbListC.aspx?cid=77">My Ascents</a>
    <h1>Buddy List</h1><table id="RGridView"><tr><td>Buddy</td></tr></table>
</body></html>`;

interface StubResponseOptions {
    status?: number;
    body?: string;
    url?: string;
    redirected?: boolean;
    headers?: Headers;
    readError?: Error | null;
}

const response = ({
    status = 200,
    body = BUDDIES,
    url = URL,
    redirected = false,
    headers = new Headers(),
    readError = null,
}: StubResponseOptions = {}) => ({
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
    let request: { url: string; init: RequestInit } | undefined;
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async (url, init) => {
            request = { url: String(url), init: init ?? {} };
            return response() as unknown as Response;
        },
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.text, BUDDIES);
    assert.ok(request);
    assert.equal(request.url, URL);
    assert.equal(request.init.credentials, 'include');
    assert.equal(request.init.redirect, 'follow');
    assert.equal(request.init.cache, 'no-store');
    assert.ok(request.init.signal instanceof AbortSignal);
});

test('native postbacks can reject redirects while retaining authenticated no-cache and deadline policy', async () => {
    let request: RequestInit | undefined;
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'html',
        init: { method: 'POST', body: 'synthetic-form-state', redirect: 'error', credentials: 'omit', cache: 'force-cache' },
        fetchFn: async (_url, init) => { request = init; return response() as unknown as Response; },
    });
    assert.equal(result.kind, 'ok');
    assert.ok(request);
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'include');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.body, 'synthetic-form-state');
    assert.ok(request.signal instanceof AbortSignal);
});

test('a valid 200 Buddy report ignores Cloudflare metadata', async () => {
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({
            headers: new Headers({ 'cf-mitigated': 'challenge' }),
            body: `${BUDDIES}<script>window._cf_chl_opt={}</script>`,
        }) as unknown as Response,
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.status, 200);
    assert.match(result.text!, /id="RGridView"/);
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
            kind: 'buddies', fetchFn: async () => challenged as unknown as Response,
        });
        assert.equal(result.kind, 'challenged');
        assert.equal(result.error.code, 'cloudflare');
        assert.match(result.reason, /human check/i);
        assert.equal((result as { text?: string }).text, undefined, 'challenge HTML must not escape the request boundary');
    }
});

test('a bare HTTP 403 is not mislabeled as Cloudflare', async () => {
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 403, body: 'Forbidden' }) as unknown as Response,
    });
    assert.equal(result.kind, 'wrong-content');
    assert.equal(result.error.code, 'http');
    assert.doesNotMatch(result.reason, /human check/i);
});

test('rate limits and server failures remain transient but are not mislabeled as Cloudflare', async () => {
    const startedAt = Date.now();
    const rateLimit = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({
            status: 429,
            body: 'slow down',
            headers: new Headers({ 'retry-after': '60' }),
        }) as unknown as Response,
    });
    assert.equal(rateLimit.kind, 'transient');
    assert.equal(rateLimit.error.code, 'rate-limit');
    assert.ok(rateLimit.error.retryAt! >= startedAt + 60_000
        && rateLimit.error.retryAt! <= Date.now() + 60_000);

    const server = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 503, body: 'maintenance' }) as unknown as Response,
    });
    assert.equal(server.kind, 'transient');
    assert.equal(server.error.code, 'server');
});

test('Peakbagger retry hints are accepted only inside the bounded cooldown window', async () => {
    for (const retryAfter of ['-1', 'not-a-date', String(24 * 60 * 60 + 1)]) {
        const result = await fetchPeakbaggerResource(URL, {
            kind: 'buddies',
            fetchFn: async () => response({
                status: 429,
                body: 'slow down',
                headers: new Headers({ 'retry-after': retryAfter }),
            }) as unknown as Response,
        });
        assert.ok(result.kind !== 'ok');
        assert.equal(result.error.code, 'rate-limit');
        assert.equal('retryAt' in result.error, false, retryAfter);
    }
});

test('network rejection, timeout, and unreadable bodies have distinct errors', async () => {
    const network = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => { throw new Error('socket failed'); },
    });
    assert.ok(network.kind !== 'ok');
    assert.equal(network.error.code, 'network');
    assert.doesNotMatch(network.reason, /socket failed/, 'raw transport details must not leak into UI copy');

    const timeout = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', timeoutMs: 5, fetchFn: () => new Promise(() => {}),
    });
    assert.ok(timeout.kind !== 'ok');
    assert.equal(timeout.error.code, 'timeout');

    const unreadable = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ readError: new Error('stream reset') }) as unknown as Response,
    });
    assert.ok(unreadable.kind !== 'ok');
    assert.equal(unreadable.error.code, 'response-read');
});

test('kind-specific response limits reject an oversized body before reading it', async () => {
    let read = false;
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'peaks',
        fetchFn: async () => ({
            ok: true,
            status: 200,
            url: URL,
            redirected: false,
            headers: new Headers({ 'content-length': String(MAX_PEAKBAGGER_PEAKS_BYTES + 1) }),
            text: async () => { read = true; return ''; },
        }) as unknown as Response,
    });
    assert.equal(result.kind, 'wrong-content');
    assert.equal(result.error!.code, 'response-too-large');
    assert.match(result.reason!, /more nearby summit data/i);
    assert.equal(read, false);
});

test('a caller can cancel during a body read even when the reader ignores the signal', async () => {
    const controller = new AbortController();
    const pending = fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        signal: controller.signal,
        timeoutMs: 50_000,
        fetchFn: async () => ({
            ok: true,
            status: 200,
            url: URL,
            redirected: false,
            headers: new Headers(),
            text: () => new Promise<string>(() => {}),
        }) as unknown as Response,
    });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    assert.equal(result.kind, 'transient');
    assert.equal(result.error!.code, 'cancelled');
});

test('signed-out, missing, redirected error, and page-drift responses remain distinguishable', async () => {
    const signedOut = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({
            body: '<html><a href="/Default.aspx">Log In</a><form id="LoginForm"><input id="PasswordText"></form></html>',
            url: 'https://www.peakbagger.com/Default.aspx',
            redirected: true,
        }) as unknown as Response,
    });
    assert.ok(signedOut.kind !== 'ok');
    assert.equal(signedOut.error.code, 'signed-out');

    const missing = await fetchPeakbaggerResource(URL, {
        kind: 'buddies', fetchFn: async () => response({ status: 404, body: 'missing' }) as unknown as Response,
    });
    assert.ok(missing.kind !== 'ok');
    assert.equal(missing.error.code, 'not-found');

    const redirected = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({
            body: '<html><h1>Peakbagger Error</h1></html>',
            url: 'https://www.peakbagger.com/PBError.aspx',
            redirected: true,
        }) as unknown as Response,
    });
    assert.ok(redirected.kind !== 'ok');
    assert.equal(redirected.error.code, 'unexpected-content');
    assert.match(redirected.reason, /redirected to PBError\.aspx/);

    const drift = await fetchPeakbaggerResource(URL, {
        kind: 'buddies',
        fetchFn: async () => response({ body: '<html><h1>Renamed Friends</h1></html>' }) as unknown as Response,
    });
    assert.ok(drift.kind !== 'ok');
    assert.equal(drift.error.code, 'unexpected-content');
});

test('a public climber page is valid even when its navigation includes Log In', async () => {
    const result = await fetchPeakbaggerResource('https://www.peakbagger.com/climber/climber.aspx?cid=88', {
        kind: 'climber',
        fetchFn: async () => response({
            url: 'https://www.peakbagger.com/climber/climber.aspx?cid=88',
            body: '<html><a href="/Default.aspx">Log In</a><h1>Public Climber</h1><a href="ClimbListC.aspx?cid=88">Ascent List</a></html>',
        }) as unknown as Response,
    });
    assert.equal(result.kind, 'ok');
});

test('invalid origins fail before fetch and parser failures become typed page errors', async () => {
    let called = false;
    const invalid = await fetchPeakbaggerResource('https://peakbagger.com.evil.example/Default.aspx', {
        kind: 'html', fetchFn: async () => { called = true; return response() as unknown as Response; },
    });
    assert.ok(invalid.kind !== 'ok');
    assert.equal(invalid.error.code, 'invalid-request');
    assert.equal(called, false);

    class BrokenParser {
        parseFromString(): Document { throw new Error('parser crashed'); }
    }
    const parsed = await fetchPeakbaggerDocument(URL, {
        kind: 'buddies', parser: BrokenParser, fetchFn: async () => response() as unknown as Response,
    });
    assert.equal(parsed.kind, 'wrong-content');
    assert.equal(parsed.error.code, 'parse');
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

test('Peakbagger 429 survives unreadable or stalled bodies and displays bounded retry advice', async () => {
    let calls = 0, cancelled = false;
    const result = await fetchPeakbaggerResource(URL, {
        kind: 'html',
        fetchFn: async () => {
            calls++;
            return {
                status: 429,
                headers: new Headers({ 'retry-after': '120', 'content-length': '999999999' }),
                body: { cancel() { cancelled = true; } },
                text() { throw new Error('must not read'); },
            } as unknown as Response;
        },
    });
    assert.ok(result.kind !== 'ok');
    assert.equal(result.error.code, 'rate-limit');
    assert.equal(result.status, 429);
    assert.match(result.reason, /Peakbagger request limit reached\. Try again after/);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(PeakbaggerError.message({ code: 'rate-limit', retryAt: Number.MAX_VALUE }),
        'Peakbagger request limit reached. Wait a few minutes, then try again.');
});
