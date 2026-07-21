// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The GitHub client pushes one ascent as a single atomic Git Data commit. These
// tests drive it against a scripted fetch stub (no network) to pin the request
// sequence (resolve repo → read ref/commit/tree → tree → commit → ref), atomic
// multi-ascent batches, the rename-move and stale-file removal in one tree,
// bounded non-fast-forward retries, and the typed error mapping.

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
        calls.push({ method, path, key, body, url, headers: init.headers, cache: init.cache });
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

const REPO_OK = () => respond(200, { default_branch: 'main', archived: false, size: 1, permissions: { push: true } });
const REF = sha => () => respond(200, { object: { sha } });
const COMMIT = (sha, treeSha) => () => respond(200, { sha, tree: { sha: treeSha } });
const MARKER = { path: Client.REPOSITORY_MARKER_PATH, type: 'blob', sha: 'marker' };
const MARKER_BLOB = () => respond(200, {
    encoding: 'base64',
    content: 'ewogICJzY2hlbWFWZXJzaW9uIjogMSwKICAidHlwZSI6ICJiZXR0ZXItcGVha2JhZ2dlci1iYWNrdXAiLAogICJsYXlvdXQiOiAicmVwb3NpdG9yeS1yb290Igp9Cg==',
});

test('an Add inlines files into one tree, creates one commit, and fast-forwards the ref', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        // Existing project content is preserved while the backup adopts the
        // repository with its marker and a root-level mountain folder.
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
    assert.equal(result.folder, '2026-07-12-mount-rainier-a1234567');

    // Small files ride in the one tree mutation instead of spending one API
    // request per blob.
    const blobCalls = calls.filter(c => c.key === 'POST /repos/me/backup/git/blobs');
    assert.equal(blobCalls.length, 0);

    const treeCall = calls.find(c => c.key === 'POST /repos/me/backup/git/trees');
    assert.equal(treeCall.body.base_tree, 'T0');
    assert.deepEqual(treeCall.body.tree.map(e => e.path).sort(), [
        '.better-peakbagger.json',
        '2026-07-12-mount-rainier-a1234567/ascent.json',
        '2026-07-12-mount-rainier-a1234567/report.md',
        '2026-07-12-mount-rainier-a1234567/track.gpx',
    ]);
    assert.ok(treeCall.body.tree.every(e => typeof e.content === 'string'));

    const commitCall = calls.find(c => c.key === 'POST /repos/me/backup/git/commits');
    assert.equal(commitCall.body.message, 'Add ascent: Mount Rainier, 2026-07-12');
    assert.deepEqual(commitCall.body.parents, ['C0']);
    // Authorization is the injected token as a bearer.
    assert.equal(commitCall.headers.Authorization, 'Bearer t');
});

test('ten ascents share one atomic tree, commit, and branch update', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    const entries = Array.from({ length: 10 }, (_, index) => ({
        snapshot: snapshot({
            ascent: { id: 2000 + index, date: `2026-07-${String(index + 1).padStart(2, '0')}` },
            peak: { id: 3000 + index, name: `Peak ${index + 1}` },
        }),
    }));
    const result = await client.pushAscentBackups(entries);

    assert.equal(result.count, 10);
    assert.equal(result.items.length, 10);
    assert.equal(result.message, 'Back up 10 ascents');
    assert.equal(calls.filter(call => call.key === 'POST /repos/me/backup/git/trees').length, 1);
    assert.equal(calls.filter(call => call.key === 'POST /repos/me/backup/git/commits').length, 1);
    assert.equal(calls.filter(call => call.key === 'PATCH /repos/me/backup/git/refs/heads/main').length, 1);
    assert.equal(calls.filter(call => call.key === 'POST /repos/me/backup/git/blobs').length, 0);
    const tree = calls.find(call => call.key === 'POST /repos/me/backup/git/trees').body.tree;
    assert.equal(tree.length, 21, 'ten two-file ascents plus the ownership marker');
    assert.equal(new Set(tree.map(entry => entry.path)).size, tree.length);
});

test('every GitHub request bypasses the browser HTTP cache', async () => {
    // The default `cache: 'default'` honors GitHub's `max-age=60` on
    // authenticated ref GETs, and the singular-read/plural-write URL split
    // means our own ref PATCH never evicts that cached read. A stale cached head
    // makes a back-to-back batch commit on the wrong parent and the non-forced
    // ref update fails as a non-fast-forward conflict. Pin `no-store` on every
    // request so a future refactor cannot silently reintroduce that hazard.
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await client.pushAscentBackup(snapshot(), { gpx: '<gpx/>' });

    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => call.cache === 'no-store'),
        `every request must set cache: no-store; got ${
            [...new Set(calls.map(call => `${call.key} → ${call.cache}`))].join(', ')}`);
});

test('an unusually large file keeps the explicit blob upload path', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/blobs': () => respond(201, { sha: 'large-blob' }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({
        fetch, token: 't', owner: 'me', repo: 'backup', inlineFileLimitBytes: 1024,
    });
    await client.pushAscentBackup(snapshot(), { gpx: `<gpx>${'x'.repeat(2048)}</gpx>` });

    assert.equal(calls.filter(call => call.key === 'POST /repos/me/backup/git/blobs').length, 1);
    const track = calls.find(call => call.key === 'POST /repos/me/backup/git/trees')
        .body.tree.find(entry => entry.path.endsWith('/track.gpx'));
    assert.equal(track.sha, 'large-blob');
    assert.equal('content' in track, false);
});

test('profile preflight reads ascent folder leaves without writing', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [
            MARKER,
            { path: '2026-01-01-one-a1', type: 'tree', sha: 'F1' },
            { path: 'README.md', type: 'blob', sha: 'B1' },
            { path: '2026-01-02-two-a2', type: 'tree', sha: 'F2' },
        ] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    assert.deepEqual(await client.getAscentFolders(), ['2026-01-01-one-a1', '2026-01-02-two-a2']);
    assert.ok(calls.every(call => call.method === 'GET'));
});

test('repository inspection distinguishes empty, populated, and owned repositories', async () => {
    const populated = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [{ path: 'README.md', type: 'blob', sha: 'r' }] }),
    });
    const populatedClient = Client.createGithubClient({ fetch: populated.fetch, token: 't', owner: 'me', repo: 'backup' });
    assert.deepEqual(await populatedClient.inspectRepository(), {
        kind: 'existing', branch: 'main', hasBranch: true, folderCount: 0,
    });

    const owned = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [
            MARKER,
            { path: '2026-01-01-peak-a1', type: 'tree', sha: 'F1' },
        ] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
    });
    const ownedClient = Client.createGithubClient({ fetch: owned.fetch, token: 't', owner: 'me', repo: 'backup' });
    assert.deepEqual(await ownedClient.inspectRepository(), {
        kind: 'backup', branch: 'main', hasBranch: true, folderCount: 1,
    });

    const empty = makeFetch({
        'GET /repos/me/backup': () => respond(200, {
            default_branch: 'main', archived: false, size: 0, permissions: { push: true },
        }),
        'GET /repos/me/backup/git/ref/heads/main': () => respond(409, { message: 'Git Repository is empty.' }),
    });
    const emptyClient = Client.createGithubClient({ fetch: empty.fetch, token: 't', owner: 'me', repo: 'backup' });
    assert.deepEqual(await emptyClient.inspectRepository(), {
        kind: 'empty', branch: 'main', hasBranch: false, folderCount: 0,
    });
});

test('an empty repository is initialized with the first backup commit', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': () => respond(200, {
            default_branch: 'main', archived: false, size: 0, permissions: { push: true },
        }),
        'GET /repos/me/backup/git/ref/heads/main': () => respond(409, { message: 'Git Repository is empty.' }),
        'PUT /repos/me/backup/contents/.better-peakbagger.json': () => respond(201, {
            commit: { sha: 'C0', tree: { sha: 'T0' } },
        }),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [MARKER] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    const result = await client.pushAscentBackup(snapshot(), {});
    assert.equal(result.folder, '2026-07-12-mount-rainier-a1234567');
    const initializeCall = calls.find(call => call.key === 'PUT /repos/me/backup/contents/.better-peakbagger.json');
    assert.deepEqual(initializeCall.body, {
        message: 'Initialize Better Peakbagger backup',
        content: 'ewogICJzY2hlbWFWZXJzaW9uIjogMSwKICAidHlwZSI6ICJiZXR0ZXItcGVha2JhZ2dlci1iYWNrdXAiLAogICJsYXlvdXQiOiAicmVwb3NpdG9yeS1yb290Igp9Cg==',
        branch: 'main',
    });
    const treeCall = calls.find(call => call.key === 'POST /repos/me/backup/git/trees');
    assert.equal(treeCall.body.base_tree, 'T0');
    assert.ok(!treeCall.body.tree.some(entry => entry.path === Client.REPOSITORY_MARKER_PATH));
    const commitCall = calls.find(call => call.key === 'POST /repos/me/backup/git/commits');
    assert.deepEqual(commitCall.body.parents, ['C0']);
    assert.ok(!calls.some(call => call.key === 'POST /repos/me/backup/git/refs'));
});

test('an unmarked root backup collision is rejected before any write', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [
            { path: '2026-01-01-unrelated-a1', type: 'tree', sha: 'F1' },
        ] }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await assert.rejects(client.inspectRepository(), error => error.code === Client.ERROR_CODES.REPO_CONFLICT);
    assert.ok(calls.every(call => call.method === 'GET'));
});

test('a rename re-sync removes owned old paths and preserves user files', async () => {
    const oldLeaf = '2026-06-01-mount-rainier-a1234567';
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [MARKER, { path: oldLeaf, type: 'tree', sha: 'TF' }] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
        'GET /repos/me/backup/git/trees/TF': () => respond(200, {
            tree: [
                { path: 'report.md', type: 'blob', sha: 'x' },
                { path: 'ascent.json', type: 'blob', sha: 'y' },
                { path: 'track.gpx', type: 'blob', sha: 'z' },
                { path: 'notes.md', type: 'blob', sha: 'user' },
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
    assert.equal(typeof byPath['2026-07-12-mount-rainier-a1234567/report.md'].content, 'string');
    assert.equal(typeof byPath['2026-07-12-mount-rainier-a1234567/ascent.json'].content, 'string');
    // Better Peakbagger's old paths are removed, but notes.md is not ours.
    for (const name of ['report.md', 'ascent.json', 'track.gpx']) {
        assert.equal(byPath[`${oldLeaf}/${name}`].sha, null);
    }
    assert.equal(byPath[`${oldLeaf}/notes.md`], undefined);
});

test('a same-slug re-sync prunes a now-absent GPX but keeps overwriting the rest', async () => {
    const leaf = '2026-07-12-mount-rainier-a1234567';
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [MARKER, { path: leaf, type: 'tree', sha: 'TF' }] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
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
    assert.equal(typeof byPath[`${leaf}/report.md`].content, 'string');
    // The stale track.gpx is the only removal.
    assert.equal(byPath[`${leaf}/track.gpx`].sha, null);
});

test('a transient ref conflict backs off before re-reading and rebuilding', async () => {
    let patchCount = 0;
    let refReads = 0;
    const delays = [];
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
    const client = Client.createGithubClient({
        fetch, token: 't', owner: 'me', repo: 'backup', sleep: async ms => delays.push(ms),
    });
    const result = await client.pushAscentBackup(snapshot(), {});
    assert.equal(result.sha, 'CN');
    assert.equal(patchCount, 2);
    assert.equal(refReads, 2);
    assert.deepEqual(delays, [500]);
});

test('a persistent ref conflict stops after the bounded retry schedule', async () => {
    let patchCount = 0;
    const delays = [];
    const { fetch } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [] }),
        'POST /repos/me/backup/git/blobs': n => respond(201, { sha: `blob${n}` }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'TX' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'CN', html_url: 'u' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => {
            patchCount += 1;
            return respond(422, { message: 'Update is not a fast forward' });
        },
    });
    const client = Client.createGithubClient({
        fetch, token: 't', owner: 'me', repo: 'backup', sleep: async ms => delays.push(ms),
    });
    await assert.rejects(
        client.pushAscentBackup(snapshot(), {}),
        err => err.code === Client.ERROR_CODES.CONFLICT,
    );
    assert.equal(patchCount, 4);
    assert.deepEqual(delays, [500, 2000, 5000]);
});

test('a root file is decoded from the selected branch and a missing file returns null', async () => {
    const encoded = Buffer.from('{"name":"Café"}\n', 'utf8').toString('base64');
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/contents/favorites.json': () => respond(200, {
            type: 'file', encoding: 'base64', content: encoded,
        }),
        'GET /repos/me/backup/contents/missing.json': () => respond(404, { message: 'Not Found' }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });

    assert.equal(await client.readRootFile('favorites.json'), '{"name":"Café"}\n');
    assert.equal(await client.readRootFile('missing.json'), null);
    const contentReads = calls.filter(call => call.path.includes('/contents/'));
    assert.ok(contentReads.every(call => new URL(call.url).searchParams.get('ref') === 'main'));
});

test('a root file commit preserves the base tree, adopts the repo, and fast-forwards without force', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [
            { path: 'README.md', type: 'blob', sha: 'readme' },
        ] }),
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, {
            sha: 'C1', html_url: 'https://github.com/me/backup/commit/C1',
        }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    const result = await client.putRootFile('favorites.json', '{"schemaVersion":1}\n', 'Back up favorite climbers');

    assert.equal(result.path, 'favorites.json');
    assert.equal(result.commitUrl, 'https://github.com/me/backup/commit/C1');
    const treeCall = calls.find(call => call.key === 'POST /repos/me/backup/git/trees');
    assert.equal(treeCall.body.base_tree, 'T0');
    assert.deepEqual(treeCall.body.tree.map(entry => entry.path).sort(), [
        '.better-peakbagger.json', 'favorites.json',
    ]);
    assert.equal(treeCall.body.tree.find(entry => entry.path === 'favorites.json').content,
        '{"schemaVersion":1}\n');
    const commitCall = calls.find(call => call.key === 'POST /repos/me/backup/git/commits');
    assert.deepEqual(commitCall.body.parents, ['C0']);
    assert.equal(commitCall.body.message, 'Back up favorite climbers');
    assert.deepEqual(calls.find(call => call.key === 'PATCH /repos/me/backup/git/refs/heads/main').body,
        { sha: 'C1', force: false });
});

test('a root file conflict retries from the newly read head', async () => {
    let refReads = 0;
    let patches = 0;
    const delays = [];
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': () => {
            const sha = `C${refReads}`;
            refReads += 1;
            return respond(200, { object: { sha } });
        },
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/commits/C1': COMMIT('C1', 'T1'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [MARKER] }),
        'GET /repos/me/backup/git/trees/T1': () => respond(200, { tree: [MARKER] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
        'POST /repos/me/backup/git/trees': number => respond(201, { sha: `TNEW${number}` }),
        'POST /repos/me/backup/git/commits': number => respond(201, { sha: `CNEW${number}` }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => {
            patches += 1;
            return patches === 1
                ? respond(422, { message: 'Update is not a fast forward' })
                : respond(200, { object: { sha: 'CNEW2' } });
        },
    });
    const client = Client.createGithubClient({
        fetch, token: 't', owner: 'me', repo: 'backup', sleep: async delay => delays.push(delay),
    });
    await client.putRootFile('favorites.json', '{}\n', 'Back up favorite climbers');

    assert.equal(refReads, 2);
    assert.deepEqual(delays, [500]);
    assert.deepEqual(calls.filter(call => call.key === 'POST /repos/me/backup/git/trees')
        .map(call => call.body.base_tree), ['T0', 'T1']);
    assert.deepEqual(calls.filter(call => call.key === 'POST /repos/me/backup/git/commits')
        .map(call => call.body.parents), [['C0'], ['C1']]);
});

test('root file writes fail closed on a foreign marker or path collision', async () => {
    const foreign = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [MARKER] }),
        'GET /repos/me/backup/git/blobs/marker': () => respond(200, {
            encoding: 'base64', content: Buffer.from('foreign').toString('base64'),
        }),
    });
    await assert.rejects(
        Client.createGithubClient({ fetch: foreign.fetch, token: 't', owner: 'me', repo: 'backup' })
            .putRootFile('favorites.json', '{}', 'Back up favorite climbers'),
        error => error.code === Client.ERROR_CODES.REPO_CONFLICT,
    );
    assert.ok(foreign.calls.every(call => call.method === 'GET'));

    const collision = makeFetch({
        'GET /repos/me/backup': REPO_OK(),
        'GET /repos/me/backup/git/ref/heads/main': REF('C0'),
        'GET /repos/me/backup/git/commits/C0': COMMIT('C0', 'T0'),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [
            MARKER, { path: 'favorites.json', type: 'tree', sha: 'folder' },
        ] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
    });
    await assert.rejects(
        Client.createGithubClient({ fetch: collision.fetch, token: 't', owner: 'me', repo: 'backup' })
            .putRootFile('favorites.json', '{}', 'Back up favorite climbers'),
        error => error.code === Client.ERROR_CODES.REPO_CONFLICT,
    );
    assert.ok(collision.calls.every(call => call.method === 'GET'));
});

test('an empty repository is initialized before its first root file commit', async () => {
    const { fetch, calls } = makeFetch({
        'GET /repos/me/backup': () => respond(200, {
            default_branch: 'main', archived: false, size: 0, permissions: { push: true },
        }),
        'GET /repos/me/backup/git/ref/heads/main': () => respond(409, { message: 'Git Repository is empty.' }),
        'PUT /repos/me/backup/contents/.better-peakbagger.json': () => respond(201, {
            commit: { sha: 'C0', tree: { sha: 'T0' } },
        }),
        'GET /repos/me/backup/git/trees/T0': () => respond(200, { tree: [MARKER] }),
        'GET /repos/me/backup/git/blobs/marker': MARKER_BLOB,
        'POST /repos/me/backup/git/trees': () => respond(201, { sha: 'T1' }),
        'POST /repos/me/backup/git/commits': () => respond(201, { sha: 'C1' }),
        'PATCH /repos/me/backup/git/refs/heads/main': () => respond(200, { object: { sha: 'C1' } }),
    });
    const client = Client.createGithubClient({ fetch, token: 't', owner: 'me', repo: 'backup' });
    await client.putRootFile('favorites.json', '{}\n', 'Back up favorite climbers');

    assert.ok(calls.some(call => call.key === 'PUT /repos/me/backup/contents/.better-peakbagger.json'));
    const tree = calls.find(call => call.key === 'POST /repos/me/backup/git/trees').body;
    assert.equal(tree.base_tree, 'T0');
    assert.deepEqual(tree.tree.map(entry => entry.path), ['favorites.json']);
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
