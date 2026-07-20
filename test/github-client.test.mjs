// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The GitHub client pushes one ascent as a single atomic Git Data commit. These
// tests drive it against a scripted fetch stub (no network) to pin the request
// sequence (resolve repo → read ref/commit/tree → blobs → tree → commit → ref),
// the rename-move and stale-file removal in one tree, the single
// non-fast-forward retry, and the typed error mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const browserDom = new JSDOM('');
globalThis.DOMParser = browserDom.window.DOMParser;
const markedContext = vm.createContext({});
vm.runInContext(await readFile(new URL('../node_modules/marked/lib/marked.umd.js', import.meta.url), 'utf8'), markedContext);
globalThis.marked = markedContext.marked;

const { githubClient: Client } = await import('../src/github-client.js');

const snapshot = (overrides = {}) => ({
    ascent: { id: 1234567, date: '2026-07-12', suffix: '', route: 'DC', gainFt: '9000', ...overrides.ascent },
    peak: { id: 2296, name: 'Mount Rainier', elevationFt: '14411', location: 'Washington, USA', ...overrides.peak },
    report: { markdown: '**nice**', ...overrides.report },
    backup: { extensionVersion: '2.2.0', syncedAt: '2026-07-12T21:04:05Z', ...overrides.backup },
});

// A Response-like object for the scripted fetch stub.
const respond = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
});

// Build a fetch stub from a route table keyed by "METHOD path-without-query".
// Handlers receive the parsed request and return respond(...). A thrown value
// is surfaced as a rejected fetch (simulating a network failure).
const makeFetch = routes => {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = url.replace('https://api.github.com', '').split('?')[0];
        const key = `${method} ${path}`;
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, key, body, url, headers: init.headers });
        const handler = routes[key];
        if (!handler) throw new Error(`unrouted request: ${key}`);
        const result = typeof handler === 'function'
            ? handler(calls.filter(c => c.key === key).length, body)
            : handler;
        if (result instanceof Error) throw result;
        return result;
    };
    return { fetch, calls };
};

const REPO_OK = () => respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
const REF = sha => () => respond(200, { object: { sha } });
const COMMIT = (sha, treeSha) => () => respond(200, { sha, tree: { sha: treeSha } });

test('an Add pushes blobs, one tree, one commit, and fast-forwards the ref', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        // Root tree has no ascents/ dir yet → first backup.
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [{ path: 'README.md', type: 'blob', sha: 'r' }] }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'https://github.com/me/backup/commit/C1' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    const result = await client.pushAscentBackup(snapshot(), { gpx: '<gpx/>' });

    assert.equal(result.isUpdate, false);
    assert.equal(result.commitUrl, 'https://github.com/me/backup/commit/C1');
    assert.equal(result.folder, 'ascents/2026-07-12-mount-rainier-a1234567');

    // Three blobs (report.md, ascent.json, track.gpx) as utf-8, then one tree.
    const blobCalls = calls.filter(c => c.key === 'POST /repos/me/backup/git/blobs');
    assert.equal(blobCalls.length, 3);
    assert.ok(blobCalls.every(c => c.body.encoding === 'utf-8'));

    const treeCall = calls.find(c => c.key === 'POST /repos/me/backup/git/trees');
    assert.equal(treeCall.body.base_tree, 'T0');
    assert.deepEqual(treeCall.body.tree.map(e => e.path).sort(), [
        'ascents/2026-07-12-mount-rainier-a1234567/ascent.json',
        'ascents/2026-07-12-mount-rainier-a1234567/report.md',
        'ascents/2026-07-12-mount-rainier-a1234567/track.gpx',
    ]);
    assert.ok(treeCall.body.tree.every(e => e.sha && e.sha.startsWith('blob')));

    const commitCall = calls.find(c => c.key === 'POST /repos/me/backup/git/commits');
    assert.equal(commitCall.body.message, 'Add ascent: Mount Rainier, 2026-07-12');
    assert.deepEqual(commitCall.body.parents, ['C0']);
    // Authorization is the injected token as a bearer.
    assert.equal(commitCall.headers.Authorization, 'Bearer t');
});

test('profile preflight reads ascent folder leaves without writing', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [{ path: 'ascents', type: 'tree', sha: 'TA' }] }),
        'GET /repos/me/backup/git/trees/TA': () => respond(200, {
            tree: [
                { path: '2026-01-01-one-a1', type: 'tree', sha: 'F1' },
                { path: 'README.md', type: 'blob', sha: 'B1' },
                { path: '2026-01-02-two-a2', type: 'tree', sha: 'F2' },
            ],
        }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    assert.deepEqual(await client.getAscentFolders(), ['2026-01-01-one-a1', '2026-01-02-two-a2']);
    assert.ok(calls.every(call => call.method === 'GET'));
});

test('a rename re-sync removes every old-folder blob and writes the new folder atomically', async () => {
    const oldLeaf = '2026-06-01-mount-rainier-a1234567';
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [{ path: 'ascents', type: 'tree', sha: 'TA' }] }),
        'GET /repos/me/backup/git/trees/TA': () => respond(200, { tree: [{ path: oldLeaf, type: 'tree', sha: 'TF' }] }),
        'GET /repos/me/backup/git/trees/TF': () => respond(200, {
            tree: [
                { path: 'report.md', type: 'blob', sha: 'x' },
                { path: 'ascent.json', type: 'blob', sha: 'y' },
                { path: 'track.gpx', type: 'blob', sha: 'z' },
            ],
        }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'https://github.com/me/backup/commit/C1' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    // The re-saved ascent moved to 2026-07-12 and no longer has a GPX track.
    const result = await client.pushAscentBackup(snapshot(), {});
    assert.equal(result.isUpdate, true);
    assert.equal(result.message, 'Update ascent: Mount Rainier, 2026-07-12');

    const treeCall = calls.find(c => c.key === 'POST /repos/me/backup/git/trees');
    const byPath = Object.fromEntries(treeCall.body.tree.map(e => [e.path, e]));
    // New folder written (report.md, ascent.json; no track.gpx this time).
    assert.ok(byPath['ascents/2026-07-12-mount-rainier-a1234567/report.md'].sha.startsWith('blob'));
    assert.ok(byPath['ascents/2026-07-12-mount-rainier-a1234567/ascent.json'].sha.startsWith('blob'));
    // Every old-folder blob deleted with a null sha.
    for (const name of ['report.md', 'ascent.json', 'track.gpx']) {
        assert.equal(byPath[`ascents/${oldLeaf}/${name}`].sha, null);
    }
});

test('a same-slug re-sync prunes a now-absent GPX but keeps overwriting the rest', async () => {
    const leaf = '2026-07-12-mount-rainier-a1234567';
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [{ path: 'ascents', type: 'tree', sha: 'TA' }] }),
        'GET /repos/me/backup/git/trees/TA': () => respond(200, { tree: [{ path: leaf, type: 'tree', sha: 'TF' }] }),
        'GET /repos/me/backup/git/trees/TF': () => respond(200, {
            tree: [
                { path: 'report.md', type: 'blob', sha: 'x' },
                { path: 'ascent.json', type: 'blob', sha: 'y' },
                { path: 'track.gpx', type: 'blob', sha: 'z' },
            ],
        }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await client.pushAscentBackup(snapshot(), {}); // no gpx now
    const treeCall = calls.find(c => c.key === 'POST /repos/me/backup/git/trees');
    const byPath = Object.fromEntries(treeCall.body.tree.map(e => [e.path, e]));
    // report.md / ascent.json overwritten (same path, real blob), not nulled.
    assert.ok(byPath[`ascents/${leaf}/report.md`].sha.startsWith('blob'));
    // The stale track.gpx is the only removal.
    assert.equal(byPath[`ascents/${leaf}/track.gpx`].sha, null);
});

test('a non-fast-forward ref update re-reads and retries exactly once, then succeeds', async () => {
    let patchCount = 0;
    let refReads = 0;
    const { fetch } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': () => { refReads += 1; return respond(200, { object: { sha: `C${refReads - 1}` } }); },
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/commits/C1': COMMIT('C1', 'T1'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'GET /repos/me/backup/git/trees/T1': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'TX' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'CN', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => {
            patchCount += 1;
            return patchCount === 1
                ? respond(422, { message: 'Update is not a fast forward' })
                : respond(200, { object: { sha: 'CN' } });
        },
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    const result = await client.pushAscentBackup(snapshot(), {});
    assert.equal(result.sha, 'CN');
    assert.equal(patchCount, 2);        // failed once, retried once
    assert.equal(refReads, 2);          // re-read the ref on the retry
});

test('a second non-fast-forward surfaces a conflict rather than looping', async () => {
    const { fetch } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'TX' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'CN', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(422, { message: 'Update is not a fast forward' }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(
        client.pushAscentBackup(snapshot(), {}),
        err => err.code === Client.ERROR_CODES.CONFLICT,
    );
});

// ---- error taxonomy -------------------------------------------------------

const failingRepoFetch = repoResponse => makeFetch({ 'GET /repos/me/backup': () => repoResponse }).fetch;

test('an invalid token maps to auth', async () => {
    const client = Client.createGithubClient({ fetch: failingRepoFetch(respond(401, { message: 'Bad credentials' })), token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.AUTH);
});

test('a withdrawn repository (404) maps to no-access', async () => {
    const client = Client.createGithubClient({ fetch: failingRepoFetch(respond(404, { message: 'Not Found' })), token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.NO_ACCESS);
});

test('an archived repository is caught pre-flight', async () => {
    const client = Client.createGithubClient({ fetch: failingRepoFetch(respond(200, { default_branch: 'main', archived: true, permissions: { push: true } })), token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.ARCHIVED);
});

test('a read-only permission is caught pre-flight as no-access', async () => {
    const client = Client.createGithubClient({ fetch: failingRepoFetch(respond(200, { default_branch: 'main', archived: false, permissions: { push: false } })), token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.NO_ACCESS);
});

test('a 403 with an exhausted rate limit maps to rate-limit, not no-access', async () => {
    const fetch = makeFetch({ 'GET /repos/me/backup': () => respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }) }).fetch;
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.RATE_LIMIT);
});

test('branch protection on the ref update maps to branch-protected', async () => {
    const fetch = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'TX' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'CN', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(422, { message: 'Required status check is expected. Protected branch update failed.' }),
    }).fetch;
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.BRANCH_PROTECTED);
});

test('a thrown fetch maps to network', async () => {
    const fetch = async () => { throw new TypeError('Failed to fetch'); };
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.pushAscentBackup(snapshot(), {}), err => err.code === Client.ERROR_CODES.NETWORK);
});

test('the factory validates its required config', () => {
    assert.throws(() => Client.createGithubClient({ token: 't', owner: 'me', repo: 'b' }), /injected fetch/);
    assert.throws(() => Client.createGithubClient({ fetch: () => {}, owner: 'me', repo: 'b' }), /token/);
    assert.throws(() => Client.createGithubClient({ fetch: () => {}, token: 't', repo: 'b' }), /owner and repo/);
});
