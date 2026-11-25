// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { githubApi as GithubApi, type GithubFetchResponse } from '../../src/github/github-api.ts';
import { githubErrors as GithubErrors } from '../../src/github/github-errors.ts';
import { required } from '../helpers/required.mts';

const { ERROR_CODES, GithubError } = GithubErrors;

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): GithubFetchResponse => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] || null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const streamResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] || null },
    body: new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    }),
    text: async () => new TextDecoder().decode(bytes),
});

test('invalid raw GitHub UTF-8 terminates an unfinished body before clearing its deadline', async () => {
    let cancelled = 0, requests = 0;
    const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([0xff])); },
        cancel() { cancelled++; },
    });
    const api = GithubApi.createGithubApi({ token: 't', fetch: async () => {
        requests++;
        return { ok: true, status: 200, headers: new Headers(), body, text: async () => assert.fail('stream bypass') };
    } });
    await assert.rejects(api.request('GET', '/repos/me/backup/git/blobs/abc', {
        responseType: 'text', maxBytes: 100,
    }), error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /UTF-8/.test(error.message));
    assert.equal(requests, 1, 'invalid backup data must not be retried');
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
});

test('the shared transport owns authenticated GitHub REST request construction', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = GithubApi.createGithubApi({
        token: 'secret',
        fetch: async (url, init) => {
            calls.push({ url, init });
            return respond(201, { sha: 'abc' });
        },
    });

    assert.deepEqual(await api.request('POST', '/repos/me/backup/git/blobs', {
        body: { content: 'hello', encoding: 'utf-8' },
    }), { sha: 'abc' });

    assert.equal(calls.length, 1);
    const { url, init } = required(calls[0]);
    const request = required(init);
    const headers = new Headers(request.headers);
    assert.equal(url, 'https://api.github.com/repos/me/backup/git/blobs');
    assert.equal(request.method, 'POST');
    assert.equal(request.cache, 'no-store');
    assert.equal(headers.get('Authorization'), 'Bearer secret');
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2022-11-28');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.ok(typeof request.body === 'string');
    assert.deepEqual(JSON.parse(request.body), { content: 'hello', encoding: 'utf-8' });
});

test('response metadata is available for safe pagination without another transport', async () => {
    const link = '<https://api.github.com/user/installations?page=2>; rel="next"';
    const api = GithubApi.createGithubApi({
        token: 't',
        fetch: async () => respond(200, { installations: [] }, { link }),
    });
    const page = await api.request('GET', '/user/installations', { withResponse: true });
    assert.deepEqual(page.data, { installations: [] });
    assert.equal(page.headers?.get?.('link'), link);
    assert.equal(page.status, 200);
    assert.equal(page.url, 'https://api.github.com/user/installations');
});

test('bounded raw Git blobs keep their media type, bytes, and strict UTF-8 contract', async () => {
    const calls: (RequestInit | undefined)[] = [];
    const valid = new TextEncoder().encode('{"name":"Café"}\n');
    const api = GithubApi.createGithubApi({
        token: 't',
        fetch: async (_url, init) => {
            calls.push(init);
            return streamResponse(valid, { 'content-length': String(valid.byteLength) });
        },
    });
    assert.equal(await api.request('GET', '/repos/me/backup/git/blobs/photo', {
        accept: 'application/vnd.github.raw+json',
        responseType: 'text',
        maxBytes: valid.byteLength,
    }), '{"name":"Café"}\n');
    assert.equal(calls.length, 1);
    assert.equal(new Headers(required(calls[0]).headers).get('Accept'), 'application/vnd.github.raw+json');

    const malformed = GithubApi.createGithubApi({
        token: 't',
        fetch: async () => streamResponse(Uint8Array.of(0xc3, 0x28)),
    });
    await assert.rejects(malformed.request('GET', '/repos/me/backup/git/blobs/photo', {
        accept: 'application/vnd.github.raw+json',
        responseType: 'text',
        maxBytes: 8,
    }), error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /UTF-8/.test(error.message));
});

test('all GitHub REST status classification comes from the shared taxonomy', async () => {
    const cases = [
        { status: 401, body: { message: 'Bad credentials' }, expected: ERROR_CODES.AUTH },
        { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' }, expected: ERROR_CODES.RATE_LIMIT },
        { status: 403, body: { message: 'Resource not accessible by integration' }, expected: ERROR_CODES.NO_ACCESS },
        { status: 403, body: { message: 'Repository is archived' }, expected: ERROR_CODES.ARCHIVED },
        { status: 404, body: { message: 'Not Found' }, expected: ERROR_CODES.NO_ACCESS },
        { status: 404, body: { message: 'Not Found' }, phase: 'ref', expected: ERROR_CODES.BRANCH_MISSING },
        { status: 409, body: { message: 'Conflict' }, expected: ERROR_CODES.CONFLICT },
        { status: 422, body: { message: 'Update is not a fast forward' }, phase: 'ref', expected: ERROR_CODES.CONFLICT },
        { status: 422, body: { message: 'Required status check blocked this protected branch' }, phase: 'ref', expected: ERROR_CODES.BRANCH_PROTECTED },
        { status: 422, body: { message: 'Validation Failed' }, expected: ERROR_CODES.INVALID },
        // A GitHub-side outage is its own remedy ("try again later"), and it
        // answers with an HTML page that carries no message to fall back on.
        { status: 500, body: { message: 'Server Error' }, expected: ERROR_CODES.SERVER },
        { status: 502, body: '<html>Bad gateway</html>', expected: ERROR_CODES.SERVER },
        { status: 503, body: '<html>unavailable</html>', expected: ERROR_CODES.SERVER },
    ];

    for (const item of cases) {
        const api = GithubApi.createGithubApi({
            token: 't',
            sleep: async () => {},
            fetch: async () => respond(item.status, item.body, item.headers),
        });
        await assert.rejects(
            api.request('GET', '/repos/me/backup', { phase: item.phase }),
            error => error instanceof GithubError
                && error.code === item.expected
                && error.status === item.status,
            `${item.status} should map to ${item.expected}`,
        );
    }
});

test('the shared transport handles expected absence, malformed responses, and network failures', async () => {
    const missing = GithubApi.createGithubApi({ token: 't', fetch: async () => respond(404, { message: 'Not Found' }) });
    assert.equal(await missing.request('GET', '/repos/me/backup/contents/favorite-climbers.json', { allowNotFound: true }), null);

    const malformed = GithubApi.createGithubApi({ token: 't', fetch: async () => respond(200, '<html>oops</html>') });
    await assert.rejects(malformed.request('GET', '/user'), error => error instanceof GithubError && error.code === ERROR_CODES.UNKNOWN);

    const offline = GithubApi.createGithubApi({ token: 't', fetch: async () => { throw new TypeError('offline'); } });
    await assert.rejects(offline.request('GET', '/user'), error => error instanceof GithubError && error.code === ERROR_CODES.NETWORK);
});

test('a stalled GitHub request fails on its deadline instead of hanging', async () => {
    const aborts = [];
    const api = GithubApi.createGithubApi({
        token: 't',
        timeoutMs: 10,
        sleep: async () => {},
        // A connection that accepts the request and never answers: no status
        // ever arrives, so only the deadline can end it.
        fetch: async (_url, init) => {
            required(init).signal?.addEventListener('abort', () => aborts.push(true));
            return new Promise(() => {});
        },
    });

    await assert.rejects(
        api.request('POST', '/repos/me/backup/git/commits', { body: {} }),
        error => error instanceof GithubError && error.code === ERROR_CODES.TIMEOUT,
    );
    assert.equal(aborts.length, 1, 'the deadline must also release the socket, not just reject');
});

test('a parent operation deadline aborts a stalled request without transport retries', async () => {
    const controller = new AbortController();
    let calls = 0;
    let aborted = false;
    const api = GithubApi.createGithubApi({
        token: 't',
        timeoutMs: 10_000,
        signal: controller.signal,
        sleep: async () => { throw new Error('an aborted operation must not retry'); },
        fetch: async (_url, init) => {
            calls += 1;
            required(init).signal?.addEventListener('abort', () => { aborted = true; });
            return new Promise(() => {});
        },
    });

    const request = api.request('GET', '/repos/me/backup');
    controller.abort();
    await assert.rejects(
        request,
        error => error instanceof GithubError && error.code === ERROR_CODES.TIMEOUT,
    );
    assert.equal(calls, 1);
    assert.equal(aborted, true, 'the parent deadline must release the active socket');
});

test('a response whose body stalls times out rather than outliving the deadline', async () => {
    const api = GithubApi.createGithubApi({
        token: 't',
        timeoutMs: 10,
        sleep: async () => {},
        fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: () => new Promise(() => {}) }),
    });
    await assert.rejects(
        api.request('POST', '/repos/me/backup/git/blobs', { body: {} }),
        error => error instanceof GithubError && error.code === ERROR_CODES.TIMEOUT,
    );
});

test('endpoint-specific GitHub response budgets reject before parsing', async () => {
    let read = false;
    let cancelled = false;
    const api = GithubApi.createGithubApi({
        token: 't',
        sleep: async () => {},
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: name => name === 'content-length' ? String(GithubApi.RESPONSE_LIMITS.default + 1) : null },
            body: {
                getReader() { read = true; throw new Error('must not open oversized stream'); },
                cancel: async () => { cancelled = true; },
            },
            text: async () => { read = true; return '{}'; },
        }),
    });
    await assert.rejects(api.request('GET', '/user'),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /more data/.test(error.message));
    assert.equal(read, false, 'a declared over-limit body is not retained or parsed');
    assert.equal(cancelled, true, 'the rejected response body is released');

    const content = 'a'.repeat(GithubApi.RESPONSE_LIMITS.default + 1);
    const largeContent = GithubApi.createGithubApi({
        token: 't',
        fetch: async () => respond(200, { encoding: 'base64', content }),
    });
    const archive = await largeContent.request('GET', '/repos/me/backup/contents/archive.json');
    assert.ok(archive && typeof archive === 'object' && 'content' in archive && typeof archive.content === 'string');
    assert.equal(archive.content.length,
        content.length, 'the contents endpoint keeps its separately reviewed larger ceiling');
});

test('valid-size GitHub JSON still has a bounded parsed structure', async () => {
    let nested: { child?: object } = {};
    for (let depth = 0; depth <= GithubApi.STRUCTURE_LIMITS.default.maxDepth; depth += 1) {
        nested = { child: nested };
    }
    const api = GithubApi.createGithubApi({ token: 't', fetch: async () => respond(200, nested) });
    await assert.rejects(api.request('GET', '/user'),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /structure/.test(error.message));
});

test('idempotent reads ride out a transient GitHub failure; writes are never replayed', async () => {
    let reads = 0;
    const flaky = GithubApi.createGithubApi({
        token: 't',
        sleep: async () => {},
        fetch: async () => (++reads < 3 ? respond(503, '<html>unavailable</html>') : respond(200, { sha: 'abc' })),
    });
    assert.deepEqual(await flaky.request('GET', '/repos/me/backup'), { sha: 'abc' });
    assert.equal(reads, 3);

    // A 502 after a commit POST may have applied it. Replaying is the caller's
    // compare-and-swap decision to make, never the transport's.
    let writes = 0;
    const writing = GithubApi.createGithubApi({
        token: 't',
        sleep: async () => {},
        fetch: async () => { writes += 1; return respond(502, '<html>Bad gateway</html>'); },
    });
    await assert.rejects(
        writing.request('POST', '/repos/me/backup/git/commits', { body: {} }),
        error => error instanceof GithubError && error.code === ERROR_CODES.SERVER,
    );
    assert.equal(writes, 1);
});

test('a read that never recovers still fails with the transient code, not a catch-all', async () => {
    let reads = 0;
    const api = GithubApi.createGithubApi({
        token: 't',
        sleep: async () => {},
        fetch: async () => { reads += 1; return respond(500, '<html>oops</html>'); },
    });
    await assert.rejects(api.request('GET', '/user'), error => error instanceof GithubError && error.code === ERROR_CODES.SERVER);
    assert.equal(reads, 3, 'retries stay bounded');
});

test('GitHub’s own retry window rides along with a rate-limit failure', async () => {
    const secondary = GithubApi.createGithubApi({
        token: 't',
        sleep: async () => {},
        fetch: async () => respond(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '60' }),
    });
    await assert.rejects(secondary.request('GET', '/user'), error =>
        error instanceof GithubError && error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterSeconds === 60);

    // A primary limit states an absolute reset instant instead.
    const primary = GithubApi.createGithubApi({
        token: 't',
        now: () => 1_700_000_000_000,
        sleep: async () => {},
        fetch: async () => respond(403, { message: 'API rate limit exceeded' }, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(1_700_000_000 + 1800),
        }),
    });
    await assert.rejects(primary.request('GET', '/user'), error =>
        error instanceof GithubError && error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterSeconds === 1800);

    // An elapsed or unparseable window leaves the wait unstated rather than
    // handing the UI a number it would present as a promise.
    const stale = GithubApi.createGithubApi({
        token: 't',
        now: () => 1_700_000_000_000,
        sleep: async () => {},
        fetch: async () => respond(429, { message: 'Too many requests' }, { 'x-ratelimit-reset': '1699999000' }),
    });
    await assert.rejects(stale.request('GET', '/user'), error =>
        error instanceof GithubError && error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterSeconds === null);
});

test('the worker boundary carries status and retry window to the copy layer', () => {
    const limited = new GithubError(ERROR_CODES.RATE_LIMIT, 'API rate limit exceeded', {
        status: 403, retryAfterSeconds: 1800,
    });
    assert.deepEqual(GithubErrors.publicError(limited), {
        code: ERROR_CODES.RATE_LIMIT,
        message: 'API rate limit exceeded',
        status: 403,
        retryAfterSeconds: 1800,
    });
});

test('the shared transport rejects pagination links outside api.github.com', async () => {
    let called = false;
    const api = GithubApi.createGithubApi({
        token: 't',
        fetch: async () => { called = true; return respond(200, {}); },
    });
    await assert.rejects(
        api.request('GET', 'https://attacker.example/user/installations'),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID,
    );
    assert.equal(called, false);
});

test('the shared error boundary normalizes untyped failures before worker messages', () => {
    const typed = new GithubError('not-a-real-code', 'Unexpected failure');
    assert.equal(typed.code, ERROR_CODES.UNKNOWN);
    assert.deepEqual(GithubErrors.publicError(typed), {
        code: ERROR_CODES.UNKNOWN,
        message: 'Unexpected failure',
    });
    assert.deepEqual(GithubErrors.publicError(new TypeError('RAW_BROWSER_SENTINEL'), 'Fallback detail'), {
        code: ERROR_CODES.UNKNOWN,
        message: 'Fallback detail',
    });
});

test('auth discovery and repository clients contain no private GitHub REST transport', async () => {
    for (const file of ['../../src/github/github-auth.ts', '../../src/github/github-client.ts']) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /api\.github\.com/);
        assert.doesNotMatch(source, /X-GitHub-Api-Version/);
        assert.doesNotMatch(source, /x-ratelimit-remaining/);
        assert.doesNotMatch(source, /Authorization\s*:/);
    }
});

test('confirmed REST limits survive unreadable bodies without transient retries or treating ordinary 403 as a limit', async () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    for (const status of [429, 403]) {
        let calls = 0;
        let cancelled = false;
        let read = false;
        const api = GithubApi.createGithubApi({ token: 't', now: () => now, fetch: async () => {
            calls++;
            return {
                status,
                ok: false,
                headers: new Headers({ 'x-ratelimit-remaining': '0', 'retry-after': 'Sun, 11 Oct 2026 12:02:00 GMT' }),
                body: {
                    getReader() { read = true; throw new Error('must not open rate-limited stream'); },
                    cancel() { cancelled = true; },
                },
                text() { read = true; throw new Error('unreadable'); },
            };
        } });
        await assert.rejects(api.request('GET', '/user'), { code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 120 });
        assert.equal(calls, 1);
        assert.equal(cancelled, true);
        assert.equal(read, false);
    }
    const denied = GithubApi.createGithubApi({ token: 't', fetch: async () => respond(403, { message: 'Forbidden' }) });
    await assert.rejects(denied.request('GET', '/user'), { code: ERROR_CODES.NO_ACCESS });
    assert.equal(GithubApi.retryAfterSeconds(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 86401) }), () => now), null);
});
