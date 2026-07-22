// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { githubApi as GithubApi } from '../src/github-api.js';
import { githubErrors as GithubErrors } from '../src/github-errors.js';

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
        { status: 500, body: { message: 'Server Error' }, expected: ERROR_CODES.UNKNOWN },
    ];

    for (const item of cases) {
        const api = GithubApi.createGithubApi({
            token: 't',
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
    assert.equal(await missing.request('GET', '/repos/me/backup/contents/favorites.json', { allowNotFound: true }), null);

    const malformed = GithubApi.createGithubApi({ token: 't', fetch: async () => respond(200, '<html>oops</html>') });
    await assert.rejects(malformed.request('GET', '/user'), error => error.code === ERROR_CODES.UNKNOWN);

    const offline = GithubApi.createGithubApi({ token: 't', fetch: async () => { throw new TypeError('offline'); } });
    await assert.rejects(offline.request('GET', '/user'), error => error.code === ERROR_CODES.NETWORK);
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
    assert.deepEqual(GithubErrors.publicError(new TypeError(), 'Fallback detail'), {
        code: ERROR_CODES.UNKNOWN,
        message: 'Fallback detail',
    });
});

test('auth discovery and repository clients contain no private GitHub REST transport', async () => {
    for (const file of ['../src/github-auth.js', '../src/github-client.js']) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /api\.github\.com/);
        assert.doesNotMatch(source, /X-GitHub-Api-Version/);
        assert.doesNotMatch(source, /x-ratelimit-remaining/);
        assert.doesNotMatch(source, /Authorization\s*:/);
    }
});
