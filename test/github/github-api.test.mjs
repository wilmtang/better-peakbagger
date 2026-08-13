// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { githubApi as GithubApi } from '../../src/github/github-api.js';
import { githubErrors as GithubErrors } from '../../src/github/github-errors.js';

const { ERROR_CODES, GithubError } = GithubErrors;

const respond = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('the shared transport owns authenticated GitHub REST request construction', async () => {
    const calls = [];
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

    assert.equal(calls[0].url, 'https://api.github.com/repos/me/backup/git/blobs');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
    assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), { content: 'hello', encoding: 'utf-8' });
});

test('response metadata is available for safe pagination without another transport', async () => {
    const link = '<https://api.github.com/user/installations?page=2>; rel="next"';
    const api = GithubApi.createGithubApi({
        token: 't',
        fetch: async () => respond(200, { installations: [] }, { link }),
    });
    const page = await api.request('GET', '/user/installations', { withResponse: true });
    assert.deepEqual(page.data, { installations: [] });
    assert.equal(page.headers.get('link'), link);
    assert.equal(page.status, 200);
    assert.equal(page.url, 'https://api.github.com/user/installations');
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
    await assert.rejects(malformed.request('GET', '/user'), error => error.code === ERROR_CODES.UNKNOWN);

    const offline = GithubApi.createGithubApi({ token: 't', fetch: async () => { throw new TypeError('offline'); } });
    await assert.rejects(offline.request('GET', '/user'), error => error.code === ERROR_CODES.NETWORK);
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
            init.signal?.addEventListener('abort', () => aborts.push(true));
            return new Promise(() => {});
        },
    });

    await assert.rejects(
        api.request('POST', '/repos/me/backup/git/commits', { body: {} }),
        error => error instanceof GithubError && error.code === ERROR_CODES.TIMEOUT,
    );
    assert.equal(aborts.length, 1, 'the deadline must also release the socket, not just reject');
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
        error => error.code === ERROR_CODES.TIMEOUT,
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
            body: { cancel: async () => { cancelled = true; } },
            text: async () => { read = true; return '{}'; },
        }),
    });
    await assert.rejects(api.request('GET', '/user'),
        error => error.code === ERROR_CODES.INVALID && /more data/.test(error.message));
    assert.equal(read, false, 'a declared over-limit body is not retained or parsed');
    assert.equal(cancelled, true, 'the rejected response body is released');

    const content = 'a'.repeat(GithubApi.RESPONSE_LIMITS.default + 1);
    const largeContent = GithubApi.createGithubApi({
        token: 't',
        fetch: async () => respond(200, { encoding: 'base64', content }),
    });
    assert.equal((await largeContent.request('GET', '/repos/me/backup/contents/archive.json')).content.length,
        content.length, 'the contents endpoint keeps its separately reviewed larger ceiling');
});

test('valid-size GitHub JSON still has a bounded parsed structure', async () => {
    const nested = {};
    let cursor = nested;
    for (let depth = 0; depth <= GithubApi.STRUCTURE_LIMITS.default.maxDepth; depth += 1) {
        cursor.child = {};
        cursor = cursor.child;
    }
    const api = GithubApi.createGithubApi({ token: 't', fetch: async () => respond(200, nested) });
    await assert.rejects(api.request('GET', '/user'),
        error => error.code === ERROR_CODES.INVALID && /structure/.test(error.message));
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
        error => error.code === ERROR_CODES.SERVER,
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
    await assert.rejects(api.request('GET', '/user'), error => error.code === ERROR_CODES.SERVER);
    assert.equal(reads, 3, 'retries stay bounded');
});

test('GitHub’s own retry window rides along with a rate-limit failure', async () => {
    const secondary = GithubApi.createGithubApi({
        token: 't',
        sleep: async () => {},
        fetch: async () => respond(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '60' }),
    });
    await assert.rejects(secondary.request('GET', '/user'), error =>
        error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterSeconds === 60);

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
        error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterSeconds === 1800);

    // An elapsed or unparseable window leaves the wait unstated rather than
    // handing the UI a number it would present as a promise.
    const stale = GithubApi.createGithubApi({
        token: 't',
        now: () => 1_700_000_000_000,
        sleep: async () => {},
        fetch: async () => respond(429, { message: 'Too many requests' }, { 'x-ratelimit-reset': '1699999000' }),
    });
    await assert.rejects(stale.request('GET', '/user'), error =>
        error.code === ERROR_CODES.RATE_LIMIT && error.retryAfterSeconds === null);
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
        error => error.code === ERROR_CODES.INVALID,
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
    for (const file of ['../../src/github/github-auth.js', '../../src/github/github-client.js']) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /api\.github\.com/);
        assert.doesNotMatch(source, /X-GitHub-Api-Version/);
        assert.doesNotMatch(source, /x-ratelimit-remaining/);
        assert.doesNotMatch(source, /Authorization\s*:/);
    }
});
