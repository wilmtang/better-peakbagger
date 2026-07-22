// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end GitHub backup through the real built background worker: the
// save-time snapshot is stored, the saved ascent page asks for status, then
// GITHUB_BACKUP_ASCENT merges the snapshot with the page fields and pushes one
// commit through a scripted GitHub Git Data fetch (no network). Pins the merge
// (page wins on identity/peak, snapshot supplies the report), the commit
// payload, and that the snapshot is consumed and the token never leaves.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';
import { favoriteClimbers as Favorites } from '../../src/favorites/favorite-climbers.js';

const workerBundle = await fs.readFile(new URL('../../dist/background.js', import.meta.url), 'utf8');

const event = () => { const listeners = []; return { listeners, addListener: l => listeners.push(l) }; };
const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
});
const waitFor = async (predicate, ms = 1000) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > ms) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 0));
    }
};

const createWorker = ({ settings = { enableGithubBackup: true }, auth = null, github, session: sharedSession = null,
    local: sharedLocal = null, peakbaggerLoginHtml = '<a href="climber/climber.aspx?cid=900001">My Home Page</a>' } = {}) => {
    const session = sharedSession || {};
    const sync = { bpbSettings: structuredClone(settings) };
    const local = sharedLocal || (auth ? { bpbGithubAuth: structuredClone(auth) } : {});
    const area = values => ({
        get: async key => ({ [key]: structuredClone(values[key]) }),
        set: async patch => Object.assign(values, structuredClone(patch)),
        remove: async key => { delete values[key]; },
    });
    const runtimeMessage = event();
    const storageChanged = event();
    const alarms = {
        created: [],
        create(name, info) { this.created.push({ name, info: info || null }); },
        onAlarm: event(),
    };
    const browser = {
        storage: { session: area(session), sync: area(sync), local: area(local), onChanged: storageChanged },
        runtime: {
            id: 'test',
            onMessage: runtimeMessage,
            getManifest: () => ({ version: '2.2.0' }),
            getURL: p => `chrome-extension://test/${p || ''}`,
        },
        tabs: { onRemoved: event() },
        alarms,
    };
    const githubCalls = [];
    const fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
        if (String(url) === 'https://peakbagger.com/Default.aspx') {
            return respond(200, peakbaggerLoginHtml);
        }
        let body = init.body;
        if (body) {
            try { body = JSON.parse(body); } catch { /* OAuth device flow is form-encoded. */ }
        }
        githubCalls.push({ method, url: String(url), body });
        const reply = github(method, String(url).replace('https://api.github.com', '').split('?')[0], body);
        if (!reply) throw new Error(`unrouted ${method} ${url}`);
        return reply;
    };
    const context = vm.createContext({
        browser, fetch, URL, URLSearchParams, Math, Date, console, structuredClone, AbortController,
        TextEncoder, TextDecoder, atob, btoa,
    });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });
    const listener = runtimeMessage.listeners[0];
    const send = (message, sender = {}) => new Promise(resolve => { listener(message, sender, resolve); });
    return {
        send, session, local, sync, alarms,
        fireStorageChange: (changes, areaName) => storageChanged.listeners.forEach(l => l(changes, areaName)),
        fireAlarm: name => alarms.onAlarm.listeners.forEach(l => l({ name })),
    };
};

// A scripted GitHub Git Data backend that records the tree it is asked to write.
const gitDataBackend = () => {
    const state = { blobs: {}, contents: {}, tree: null, n: 0, commits: 0 };
    const handler = (method, path, body) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
        if (method === 'GET' && path === '/repos/me/backup/git/ref/heads/main') return respond(200, { object: { sha: 'C0' } });
        if (method === 'GET' && path === '/repos/me/backup/git/commits/C0') return respond(200, { sha: 'C0', tree: { sha: 'T0' } });
        if (method === 'GET' && path === '/repos/me/backup/git/trees/T0') return respond(200, { tree: [] });
        if (method === 'POST' && path === '/repos/me/backup/git/blobs') { const sha = `blob${++state.n}`; state.blobs[sha] = body.content; return respond(201, { sha }); }
        if (method === 'POST' && path === '/repos/me/backup/git/trees') {
            state.tree = body;
            for (const entry of body.tree) {
                if (typeof entry.content === 'string') state.contents[entry.path] = entry.content;
                else if (entry.sha && state.blobs[entry.sha]) state.contents[entry.path] = state.blobs[entry.sha];
            }
            return respond(201, { sha: 'T1' });
        }
        if (method === 'POST' && path === '/repos/me/backup/git/commits') {
            state.commits += 1;
            return respond(201, { sha: 'C1', html_url: 'https://github.com/me/backup/commit/C1' });
        }
        if (method === 'PATCH' && path === '/repos/me/backup/git/refs/heads/main') return respond(200, { object: { sha: 'C1' } });
        return null;
    };
    return { handler, state };
};

const AUTH = { token: 'gho_secret', repo: { owner: 'me', name: 'backup', branch: 'main', fullName: 'me/backup' }, account: { login: 'me' } };
const PEAK_SENDER = { tab: { id: 5 }, url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321' };
const EDIT_SENDER = { tab: { id: 4 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001&pid=2296' };
const LIST_SENDER = { tab: { id: 6 }, url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999' };
const EXTENSION_SENDER = { url: 'chrome-extension://test/options/options.html' };

const editSnapshot = () => ({
    key: '900001|2296|2026-07-12',
    identity: { climberId: 900001, ascentId: null, peakId: 2296, date: '2026-07-12' },
    snapshot: {
        ascent: { id: null, date: '2026-07-12', suffix: '', gainFt: '9000', route: 'Disappointment Cleaver', gear: ['Ice Axe'] },
        peak: { id: 2296, name: 'Mount Rainier' },
        report: { markdown: '**Great climb** under blue skies.' },
        backup: { extensionVersion: '2.2.0', syncedAt: null },
    },
});
const storedSnapshotKey = (snapshot = editSnapshot(), sender = EDIT_SENDER) => `${snapshot.key}|tab:${sender.tab.id}`;

test('a saved ascent is backed up: snapshot + page merge, one commit, snapshot consumed', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });

    // 1. The edit page stores the save-time snapshot.
    const stored = await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...editSnapshot() }, EDIT_SENDER);
    assert.equal(stored.ok, true);
    assert.ok(worker.session.bpbGithubSnapshots[storedSnapshotKey()]);

    // 2. The saved ascent page checks status.
    const status = await worker.send({ type: 'GITHUB_BACKUP_STATUS' }, PEAK_SENDER);
    assert.equal(status.enabled, true);
    assert.equal(status.connected, true);
    assert.equal(status.repo.fullName, 'me/backup');
    assert.equal('token' in status, false, 'status must never expose the token');

    // 3. The saved ascent page pushes the backup. The new aid (7654321) and the
    //    fuller peak metadata come from the page; the report from the snapshot.
    const result = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT',
        pageComplete: true,
        page: {
            ascent: {
                id: 7654321,
                date: '2026-07-12',
                suffix: '',
                type: 'Successful Ascent (stood on the summit)',
                gainFt: '9000',
                route: 'Disappointment Cleaver',
                gear: ['Ice Axe'],
            },
            peak: { id: 2296, name: 'Mount Rainier', elevationFt: 14411, location: 'Washington, USA' },
            report: { markdown: '' },
        },
        gpx: '<gpx><trk></trk></gpx>',
    }, PEAK_SENDER);

    assert.equal(result.ok, true);
    assert.equal(result.result.commitUrl, 'https://github.com/me/backup/commit/C1');
    assert.equal(result.result.isUpdate, false);
    assert.equal(result.result.folder, '2026-07-12-mount-rainier-a7654321');

    // The one tree carries the repository marker and all three ascent files.
    const paths = backend.state.tree.tree.map(e => e.path).sort();
    assert.deepEqual(paths, [
        '.better-peakbagger.json',
        '2026-07-12-mount-rainier-a7654321/ascent.json',
        '2026-07-12-mount-rainier-a7654321/report.md',
        '2026-07-12-mount-rainier-a7654321/track.gpx',
    ]);

    // ascent.json merges page peak metadata with the snapshot's entered fields.
    const jsonBlob = Object.entries(backend.state.contents)
        .find(([path]) => path.endsWith('/ascent.json'))[1];
    const json = JSON.parse(jsonBlob);
    assert.equal(json.ascent.id, 7654321);
    assert.equal(json.ascent.gainFt, 9000);
    assert.equal(json.peak.elevationFt, 14411);
    assert.equal(json.peak.location, 'Washington, USA');
    assert.equal(json.backup.extensionVersion, '2.2.0');
    assert.ok(json.backup.syncedAt, 'syncedAt is stamped at push time');

    // report.md carries the snapshot's resolved Markdown body.
    const mdBlob = Object.entries(backend.state.contents)
        .find(([path]) => path.endsWith('/report.md'))[1];
    assert.match(mdBlob, /\*\*Great climb\*\* under blue skies\./);

    // The snapshot has served its purpose and is dropped.
    assert.equal(worker.session.bpbGithubSnapshots[storedSnapshotKey()], undefined);
});

test('the worker compares a complete owner page with GitHub without writing', async () => {
    const backend = gitDataBackend();
    const writer = createWorker({ auth: AUTH, github: backend.handler });
    const page = {
        ascent: {
            id: 7654321,
            date: '2026-07-12',
            suffix: '',
            type: 'Successful Ascent (stood on the summit)',
            route: 'Disappointment Cleaver',
        },
        peak: { id: 2296, name: 'Mount Rainier', elevationFt: 14411, location: 'Washington, USA' },
        report: { markdown: '**Great climb** under blue skies.' },
    };
    const gpx = '<gpx><trk></trk></gpx>';
    const pushed = await writer.send({
        type: 'GITHUB_BACKUP_ASCENT', pageComplete: true, page, gpx,
    }, PEAK_SENDER);
    assert.equal(pushed.ok, true);

    const folder = pushed.result.folder;
    const owned = Object.entries(backend.state.contents)
        .filter(([filePath]) => filePath.startsWith(`${folder}/`));
    let writes = 0;
    const reader = createWorker({ auth: AUTH, github: (method, requestPath) => {
        if (method !== 'GET') writes += 1;
        if (method === 'GET' && requestPath === '/repos/me/backup') {
            return respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
        }
        if (method === 'GET' && requestPath === '/repos/me/backup/git/ref/heads/main') {
            return respond(200, { object: { sha: 'C1' } });
        }
        if (method === 'GET' && requestPath === '/repos/me/backup/git/commits/C1') {
            return respond(200, { sha: 'C1', tree: { sha: 'TROOT' } });
        }
        if (method === 'GET' && requestPath === '/repos/me/backup/git/trees/TROOT') {
            return respond(200, { tree: [
                { path: '.better-peakbagger.json', type: 'blob', sha: 'marker' },
                { path: folder, type: 'tree', sha: 'TFOLDER' },
            ] });
        }
        if (method === 'GET' && requestPath === '/repos/me/backup/git/blobs/marker') {
            return respond(200, {
                encoding: 'base64',
                content: Buffer.from(backend.state.contents['.better-peakbagger.json']).toString('base64'),
            });
        }
        if (method === 'GET' && requestPath === '/repos/me/backup/git/trees/TFOLDER') {
            return respond(200, { tree: owned.map(([filePath], index) => ({
                path: filePath.slice(folder.length + 1),
                type: 'blob',
                sha: `owned${index}`,
            })) });
        }
        const blobMatch = requestPath.match(/\/git\/blobs\/owned(\d+)$/);
        if (method === 'GET' && blobMatch) {
            return respond(200, {
                encoding: 'base64', content: Buffer.from(owned[Number(blobMatch[1])][1]).toString('base64'),
            });
        }
        return null;
    } });

    const current = await reader.send({
        type: 'GITHUB_CHECK_ASCENT_BACKUP', pageComplete: true, page, gpx,
    }, PEAK_SENDER);
    assert.deepEqual(structuredClone(current), { ok: true, current: true });

    const changedPage = structuredClone(page);
    changedPage.ascent.route = 'Emmons Glacier';
    const changed = await reader.send({
        type: 'GITHUB_CHECK_ASCENT_BACKUP', pageComplete: true, page: changedPage, gpx,
    }, PEAK_SENDER);
    assert.deepEqual(structuredClone(changed), { ok: true, current: false });
    assert.equal(writes, 0, 'passive comparison must issue no GitHub mutations');

    const forbidden = await reader.send({
        type: 'GITHUB_CHECK_ASCENT_BACKUP', pageComplete: true, page, gpx,
    }, { tab: { id: 1 }, url: 'https://evil.example/ascent.aspx' });
    assert.equal(forbidden.error.code, 'forbidden');
});

test('profile preflight lists repository folders without exposing the token', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const status = await worker.send({ type: 'GITHUB_BACKUP_PROFILE_STATUS' }, LIST_SENDER);
    assert.equal(status.ok, true);
    assert.deepEqual(Array.from(status.folders), []);
    assert.equal('token' in status, false);

});

test('options summary reports only the marker-validated ascent count', async () => {
    const marker = `${JSON.stringify({
        schemaVersion: 1,
        type: 'better-peakbagger-backup',
        layout: 'repository-root',
    }, null, 2)}\n`;
    const github = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') {
            return respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
        }
        if (method === 'GET' && path === '/repos/me/backup/git/ref/heads/main') {
            return respond(200, { object: { sha: 'C0' } });
        }
        if (method === 'GET' && path === '/repos/me/backup/git/commits/C0') {
            return respond(200, { tree: { sha: 'T0' } });
        }
        if (method === 'GET' && path === '/repos/me/backup/git/trees/T0') {
            return respond(200, { tree: [
                { path: '.better-peakbagger.json', type: 'blob', sha: 'marker' },
                { path: '2026-01-01-one-a1', type: 'tree', sha: 'F1' },
                { path: '2026-01-02-two-a2', type: 'tree', sha: 'F2' },
                { path: 'settings.json', type: 'blob', sha: 'settings' },
            ] });
        }
        if (method === 'GET' && path === '/repos/me/backup/git/blobs/marker') {
            return respond(200, { encoding: 'base64', content: Buffer.from(marker).toString('base64') });
        }
        return null;
    };
    const worker = createWorker({ auth: AUTH, github });

    const summary = structuredClone(await worker.send({ type: 'GITHUB_ASCENT_BACKUP_SUMMARY' }, EXTENSION_SENDER));
    assert.deepEqual(summary, { ok: true, count: 2 });
    assert.equal('folders' in summary, false);
    assert.equal('token' in summary, false);

    const forbidden = await worker.send({ type: 'GITHUB_ASCENT_BACKUP_SUMMARY' }, PEAK_SENDER);
    assert.equal(forbidden.error, 'forbidden');
});

test('profile backfill validates and commits multiple ascents as one batch', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const entries = [7654321, 7654322].map((aid, index) => ({
        aid,
        snapshot: {
            ascent: { id: aid, date: `2026-07-${12 + index}`, suffix: '' },
            peak: { id: 2296 + index, name: `Peak ${index + 1}` },
            report: { markdown: `Report ${index + 1}` },
            backup: { extensionVersion: '', syncedAt: null },
        },
        gpx: null,
    }));
    const result = await worker.send({ type: 'GITHUB_BACKUP_PROFILE_BATCH', entries }, LIST_SENDER);

    assert.equal(result.ok, true);
    assert.equal(result.result.count, 2);
    assert.equal(result.result.message, 'Back up 2 ascents');
    assert.equal(result.result.items.length, 2);
    assert.equal(backend.state.tree.tree.filter(entry => entry.path.endsWith('/ascent.json')).length, 2);
    assert.equal(backend.state.tree.tree.filter(entry => entry.path.endsWith('/report.md')).length, 2);
});

test('profile batches reject duplicate identities and more than ten entries before writing', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const entry = {
        aid: 7,
        snapshot: { ascent: { id: 7 }, peak: { id: 8, name: 'Peak' }, report: { markdown: '' } },
    };
    const duplicate = await worker.send({
        type: 'GITHUB_BACKUP_PROFILE_BATCH', entries: [structuredClone(entry), structuredClone(entry)],
    }, LIST_SENDER);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, 'no-data');

    const oversized = await worker.send({
        type: 'GITHUB_BACKUP_PROFILE_BATCH',
        entries: Array.from({ length: 11 }, (_, index) => ({
            aid: index + 1,
            snapshot: { ascent: { id: index + 1 }, peak: { id: index + 20, name: 'Peak' } },
        })),
    }, LIST_SENDER);
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, 'no-data');
    assert.equal(backend.state.tree, null);
});

test('the worker serializes competing profile batches before either reads the branch', async () => {
    let currentCommit = 'C0';
    let repoReads = 0;
    let treeNumber = 0;
    let commitNumber = 0;
    let releaseFirstTree;
    let markFirstTreeStarted;
    const firstTreeStarted = new Promise(resolve => { markFirstTreeStarted = resolve; });
    const firstTreeGate = new Promise(resolve => { releaseFirstTree = resolve; });
    const github = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') {
            repoReads += 1;
            return respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
        }
        if (method === 'GET' && path === '/repos/me/backup/git/ref/heads/main') {
            return respond(200, { object: { sha: currentCommit } });
        }
        if (method === 'GET' && path.startsWith('/repos/me/backup/git/commits/C')) {
            const sha = path.split('/').at(-1);
            return respond(200, { sha, tree: { sha: `T${sha.slice(1)}` } });
        }
        if (method === 'GET' && path.startsWith('/repos/me/backup/git/trees/T')) return respond(200, { tree: [] });
        if (method === 'POST' && path === '/repos/me/backup/git/trees') {
            treeNumber += 1;
            if (treeNumber === 1) {
                markFirstTreeStarted();
                return firstTreeGate.then(() => respond(201, { sha: 'T1' }));
            }
            return respond(201, { sha: `T${treeNumber}` });
        }
        if (method === 'POST' && path === '/repos/me/backup/git/commits') {
            commitNumber += 1;
            return respond(201, { sha: `C${commitNumber}`, html_url: `u${commitNumber}` });
        }
        if (method === 'PATCH' && path === '/repos/me/backup/git/refs/heads/main') {
            currentCommit = `C${commitNumber}`;
            return respond(200, { object: { sha: currentCommit } });
        }
        return null;
    };
    const worker = createWorker({ auth: AUTH, github });
    const message = aid => ({
        type: 'GITHUB_BACKUP_PROFILE_BATCH',
        entries: [{
            aid,
            snapshot: { ascent: { id: aid }, peak: { id: aid + 100, name: `Peak ${aid}` }, report: { markdown: '' } },
        }],
    });

    const first = worker.send(message(1), LIST_SENDER);
    await firstTreeStarted;
    const second = worker.send(message(2), LIST_SENDER);
    await Promise.resolve();
    assert.equal(repoReads, 1, 'the second writer must wait before resolving the repository or reading its head');
    releaseFirstTree();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(repoReads, 2);
    assert.equal(currentCommit, 'C2');
});

test('favorites backup and restore stay extension-only, ignore the ascent gate, and keep the token in the worker', async () => {
    const backend = gitDataBackend();
    const restoreContent = '{"schemaVersion":1,"exportedAt":"2026-07-21T12:00:00.000Z","entries":[]}\n';
    const github = (method, path, body) => {
        if (method === 'GET' && path === '/repos/me/backup/contents/favorite-climbers.json') {
            return respond(200, {
                type: 'file', encoding: 'base64', content: Buffer.from(restoreContent).toString('base64'),
            });
        }
        return backend.handler(method, path, body);
    };
    const entries = [{
        cid: 900002, name: 'Favorite Climber', addedAt: 10, source: 'manual',
    }];
    const local = {
        bpbGithubAuth: structuredClone(AUTH),
        [Favorites.FAVORITES_KEY]: { schemaVersion: Favorites.SCHEMA_VERSION, entries },
    };
    const worker = createWorker({
        settings: { enableGithubBackup: false, autoFavoritesBackup: true },
        auth: AUTH,
        local,
        github,
    });

    const backup = await worker.send({ type: 'GITHUB_FAVORITES_BACKUP' }, EXTENSION_SENDER);
    assert.equal(backup.ok, true);
    assert.equal(backup.result.path, 'favorite-climbers.json');
    const exported = Favorites.parseBackup(backend.state.contents['favorite-climbers.json']);
    assert.equal(exported.ok, true);
    assert.deepEqual(structuredClone(exported.favorites.entries), entries);
    assert.equal(worker.local.bpbFavoritesBackupState.signature, JSON.stringify(entries));
    assert.equal(backend.state.tree.tree.find(entry => entry.path === 'favorite-climbers.json').type, 'blob');
    assert.equal('token' in backup, false);

    worker.fireAlarm('bpb-favorites-backup');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(backend.state.commits, 1, 'manual backup state must suppress an equal automatic backup');

    const restore = await worker.send({ type: 'GITHUB_FAVORITES_RESTORE' }, EXTENSION_SENDER);
    assert.equal(restore.ok, true);
    assert.equal(restore.content, restoreContent);
    assert.equal('token' in restore, false);

    const forbidden = await worker.send({ type: 'GITHUB_FAVORITES_RESTORE' }, PEAK_SENDER);
    assert.equal(forbidden.error, 'forbidden');
});

test('an empty favorite list is a valid worker-built backup', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const result = await worker.send({ type: 'GITHUB_FAVORITES_BACKUP' }, EXTENSION_SENDER);

    assert.equal(result.ok, true);
    const parsed = Favorites.parseBackup(backend.state.contents['favorite-climbers.json']);
    assert.equal(parsed.ok, true);
    assert.deepEqual(structuredClone(parsed.favorites.entries), []);
});

test('enabling or changing favorites schedules one automatic backup and restore does not push', async () => {
    const backend = gitDataBackend();
    const entries = [{ cid: 7, name: 'Seven', addedAt: 10, source: 'manual' }];
    const local = {
        bpbGithubAuth: structuredClone(AUTH),
        [Favorites.FAVORITES_KEY]: { schemaVersion: 1, entries },
    };
    const worker = createWorker({
        settings: { autoFavoritesBackup: true }, auth: AUTH, local, github: backend.handler,
    });

    worker.fireStorageChange({
        bpbSettings: { newValue: structuredClone(worker.sync.bpbSettings) },
    }, 'sync');
    await waitFor(() => worker.alarms.created.filter(
        alarm => alarm.name === 'bpb-favorites-backup').length === 1);

    worker.fireStorageChange({
        [Favorites.FAVORITES_KEY]: { newValue: structuredClone(local[Favorites.FAVORITES_KEY]) },
    }, 'local');
    await waitFor(() => worker.alarms.created.filter(
        alarm => alarm.name === 'bpb-favorites-backup').length === 2);
    assert.deepEqual(structuredClone(worker.alarms.created.findLast(
        alarm => alarm.name === 'bpb-favorites-backup')), {
        name: 'bpb-favorites-backup', info: { delayInMinutes: 1 },
    });

    worker.fireAlarm('bpb-favorites-backup');
    await waitFor(() => worker.local.bpbFavoritesBackupState?.syncedAt);
    assert.equal(backend.state.commits, 1);
    const committed = Favorites.parseBackup(backend.state.contents['favorite-climbers.json']);
    assert.equal(committed.ok, true);
    assert.deepEqual(structuredClone(committed.favorites.entries), entries);

    // Applying the parsed backup is exactly what the options restore path does.
    worker.local[Favorites.FAVORITES_KEY] = structuredClone(committed.favorites);
    worker.fireStorageChange({
        [Favorites.FAVORITES_KEY]: { newValue: structuredClone(committed.favorites) },
    }, 'local');
    worker.fireAlarm('bpb-favorites-backup');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(backend.state.commits, 1);
});

test('favorites auto backup stays inert while off and retries failures only twice', async () => {
    const favorite = { schemaVersion: 1, entries: [{
        cid: 7, name: 'Seven', addedAt: 10, source: 'manual',
    }] };
    const off = createWorker({
        settings: { autoFavoritesBackup: false },
        local: { bpbGithubAuth: structuredClone(AUTH), [Favorites.FAVORITES_KEY]: favorite },
        github: gitDataBackend().handler,
    });
    off.fireStorageChange({ [Favorites.FAVORITES_KEY]: { newValue: favorite } }, 'local');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(off.alarms.created.some(alarm => alarm.name === 'bpb-favorites-backup'), false);

    const failing = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(500, { message: 'Nope' });
        return null;
    };
    const worker = createWorker({
        settings: { autoFavoritesBackup: true },
        local: { bpbGithubAuth: structuredClone(AUTH), [Favorites.FAVORITES_KEY]: favorite },
        github: failing,
    });
    for (let attempts = 1; attempts <= 3; attempts++) {
        worker.fireAlarm('bpb-favorites-backup');
        await waitFor(() => worker.local.bpbFavoritesBackupState?.attempts === attempts);
    }
    assert.deepEqual(structuredClone(worker.alarms.created.filter(
        alarm => alarm.name === 'bpb-favorites-backup'
    )), [
        { name: 'bpb-favorites-backup', info: { delayInMinutes: 10 } },
        { name: 'bpb-favorites-backup', info: { delayInMinutes: 10 } },
    ]);
});

test('favorites restore reports an absent file and ignores the ascent-backup feature gate', async () => {
    const missing = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') {
            return respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
        }
        if (method === 'GET' && path === '/repos/me/backup/contents/favorite-climbers.json') {
            return respond(404, { message: 'Not Found' });
        }
        return null;
    };
    const connected = createWorker({ auth: AUTH, github: missing });
    const absent = await connected.send({ type: 'GITHUB_FAVORITES_RESTORE' }, EXTENSION_SENDER);
    assert.equal(absent.ok, true);
    assert.equal(absent.content, null);

    const disabled = createWorker({
        settings: { enableGithubBackup: false }, auth: AUTH, github: missing,
    });
    const independent = await disabled.send({ type: 'GITHUB_FAVORITES_RESTORE' }, EXTENSION_SENDER);
    assert.equal(independent.ok, true);
    assert.equal(independent.content, null);

    const disconnected = createWorker({ auth: null, github: missing });
    assert.equal((await disconnected.send({
        type: 'GITHUB_FAVORITES_RESTORE',
    }, EXTENSION_SENDER)).error.code, 'not-connected');
});

test('settings backup and restore stay extension-only and ignore the ascent-backup gate', async () => {
    const backend = gitDataBackend();
    const restorePayload = Transfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '2.1.0',
        exportedAt: '2026-07-21T12:00:00.000Z',
    });
    const restoreContent = Transfer.serialize(restorePayload);
    const github = (method, path, body) => {
        if (method === 'GET' && path === '/repos/me/backup/contents/settings.json') {
            return respond(200, {
                type: 'file', encoding: 'base64', content: Buffer.from(restoreContent).toString('base64'),
            });
        }
        return backend.handler(method, path, body);
    };
    const worker = createWorker({
        settings: { enableGithubBackup: false, theme: 'dark' }, auth: AUTH, github,
    });

    const backup = await worker.send({ type: 'GITHUB_SETTINGS_BACKUP' }, EXTENSION_SENDER);
    assert.equal(backup.ok, true);
    assert.equal(backup.result.path, 'settings.json');
    const committed = JSON.parse(backend.state.contents['settings.json']);
    assert.equal(committed.kind, Transfer.KIND);
    assert.equal(committed.extensionVersion, '2.2.0');
    assert.equal(committed.settings.theme, 'dark');
    assert.deepEqual(Object.keys(committed.settings), Object.keys(Schema.DEFAULTS));
    assert.equal(worker.local.bpbSettingsBackupState.signature,
        Transfer.signature(Schema.clean({ enableGithubBackup: false, theme: 'dark' })));
    assert.equal('token' in backup, false);

    const restore = await worker.send({ type: 'GITHUB_SETTINGS_RESTORE' }, EXTENSION_SENDER);
    assert.equal(restore.ok, true);
    assert.equal(restore.content, restoreContent);
    assert.equal('token' in restore, false);

    const forbidden = await worker.send({ type: 'GITHUB_SETTINGS_BACKUP' }, PEAK_SENDER);
    assert.equal(forbidden.error, 'forbidden');
});

test('settings auto backup debounces changes, commits once, and skips an equal signature', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({
        settings: { enableGithubBackup: false, autoSettingsBackup: true, theme: 'dark' },
        auth: AUTH,
        github: backend.handler,
    });

    worker.fireStorageChange({
        bpbSettings: { newValue: structuredClone(worker.sync.bpbSettings) },
    }, 'sync');
    await waitFor(() => worker.alarms.created.some(alarm => alarm.name === 'bpb-settings-backup'));
    assert.deepEqual(structuredClone(worker.alarms.created.find(alarm => alarm.name === 'bpb-settings-backup')), {
        name: 'bpb-settings-backup', info: { delayInMinutes: 1 },
    });

    worker.fireAlarm('bpb-settings-backup');
    await waitFor(() => worker.local.bpbSettingsBackupState?.syncedAt);
    assert.equal(backend.state.commits, 1);
    const payload = JSON.parse(backend.state.contents['settings.json']);
    assert.equal(payload.settings.theme, 'dark');
    assert.equal(payload.settings.autoSettingsBackup, true);

    worker.fireAlarm('bpb-settings-backup');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(backend.state.commits, 1, 'an unchanged signature must not create another commit');
});

test('settings auto backup stays inert while off and retries failures only twice', async () => {
    const off = createWorker({
        settings: { autoSettingsBackup: false }, auth: AUTH, github: gitDataBackend().handler,
    });
    off.fireStorageChange({ bpbSettings: { newValue: {} } }, 'sync');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(off.alarms.created.some(alarm => alarm.name === 'bpb-settings-backup'), false);

    const failing = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(500, { message: 'Nope' });
        return null;
    };
    const worker = createWorker({ settings: { autoSettingsBackup: true }, auth: AUTH, github: failing });
    for (let attempts = 1; attempts <= 3; attempts++) {
        worker.fireAlarm('bpb-settings-backup');
        await waitFor(() => worker.local.bpbSettingsBackupState?.attempts === attempts);
    }
    const retries = worker.alarms.created.filter(alarm => alarm.name === 'bpb-settings-backup');
    assert.deepEqual(structuredClone(retries), [
        { name: 'bpb-settings-backup', info: { delayInMinutes: 10 } },
        { name: 'bpb-settings-backup', info: { delayInMinutes: 10 } },
    ]);
});

test('settings backup reports disconnected and missing-repository states', async () => {
    const github = gitDataBackend().handler;
    const disconnected = createWorker({ auth: null, github });
    assert.equal((await disconnected.send({
        type: 'GITHUB_SETTINGS_BACKUP',
    }, EXTENSION_SENDER)).error.code, 'not-connected');

    const missingRepo = createWorker({ auth: { token: 'gho_secret' }, github });
    assert.equal((await missingRepo.send({
        type: 'GITHUB_SETTINGS_RESTORE',
    }, EXTENSION_SENDER)).error.code, 'no-repo');
});

test('profile messages require ClimbListC and matching ascent identity', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const snapshot = { ascent: { id: 7 }, peak: { id: 8, name: 'Peak' }, report: { markdown: '' } };
    const wrongSurface = await worker.send({
        type: 'GITHUB_BACKUP_PROFILE_BATCH', entries: [{ aid: 7, snapshot }],
    }, PEAK_SENDER);
    assert.equal(wrongSurface.error.code, 'forbidden');
    const mismatched = await worker.send({
        type: 'GITHUB_BACKUP_PROFILE_BATCH', entries: [{ aid: 9, snapshot }],
    }, LIST_SENDER);
    assert.equal(mismatched.error.code, 'no-data');
});

test('the options page resolves My Ascents for the signed-in climber and rejects web senders', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const resolved = await worker.send({ type: 'PEAKBAGGER_MY_ASCENTS' }, EXTENSION_SENDER);
    assert.equal(resolved.ok, true);
    const url = new URL(resolved.url);
    assert.equal(url.origin + url.pathname, 'https://www.peakbagger.com/climber/ClimbListC.aspx');
    assert.equal(url.searchParams.get('cid'), '900001');
    assert.equal(url.searchParams.get('j'), '-1');
    assert.equal(url.searchParams.get('y'), '9999');
    assert.equal(url.searchParams.get('sort'), 'AscentDate');

    const forbidden = await worker.send({ type: 'PEAKBAGGER_MY_ASCENTS' }, PEAK_SENDER);
    assert.equal(forbidden.error, 'forbidden');

    const signedOut = createWorker({
        auth: AUTH,
        github: backend.handler,
        peakbaggerLoginHtml: '<a href="/climber/login.aspx">Log In</a>',
    });
    const missing = await signedOut.send({ type: 'PEAKBAGGER_MY_ASCENTS' }, EXTENSION_SENDER);
    assert.equal(missing.error.code, 'peakbagger-signed-out');
    assert.match(missing.error.message, /Sign in to Peakbagger, then try again/);
});

test('backup fails closed when the feature is off, disconnected, or the sender is not Peakbagger', async () => {
    const backend = gitDataBackend();
    const push = sender => createWorker({ auth: AUTH, github: backend.handler }).send({
        type: 'GITHUB_BACKUP_ASCENT',
        page: { ascent: { id: 1 }, peak: { id: 2, name: 'X' } },
    }, sender);

    // A non-Peakbagger sender is refused.
    assert.equal((await push({ tab: { id: 1 }, url: 'https://evil.example/' })).error.code, 'forbidden');

    // Disconnected (no token).
    const noAuth = await createWorker({ auth: null, github: backend.handler }).send({
        type: 'GITHUB_BACKUP_ASCENT', page: { ascent: { id: 1 }, peak: { id: 2, name: 'X' } },
    }, PEAK_SENDER);
    assert.equal(noAuth.error.code, 'not-connected');

    // Feature disabled.
    const off = await createWorker({ settings: { enableGithubBackup: false }, auth: AUTH, github: backend.handler }).send({
        type: 'GITHUB_BACKUP_ASCENT', page: { ascent: { id: 1 }, peak: { id: 2, name: 'X' } },
    }, PEAK_SENDER);
    assert.equal(off.error.code, 'disabled');
});

test('automatic backup declines on a revisit with no fresh snapshot, but pushes when one exists', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ settings: { enableGithubBackup: true, autoGithubBackup: true }, auth: AUTH, github: backend.handler });
    const page = {
        ascent: { id: 7654321, date: '2026-07-12' },
        peak: { id: 2296, name: 'Mount Rainier' },
        report: { markdown: '' },
    };

    // No snapshot stored yet: an auto push on a mere revisit declines quietly.
    const revisit = await worker.send({ type: 'GITHUB_BACKUP_ASCENT', page, auto: true }, PEAK_SENDER);
    assert.equal(revisit.ok, false);
    assert.equal(revisit.error.code, 'no-fresh-save');

    // After a save-time snapshot, the same auto push commits.
    await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...editSnapshot() }, EDIT_SENDER);
    const pushed = await worker.send({ type: 'GITHUB_BACKUP_ASCENT', page, auto: true }, PEAK_SENDER);
    assert.equal(pushed.ok, true);
    assert.equal(pushed.result.commitUrl, 'https://github.com/me/backup/commit/C1');

    // The status query reports the auto preference to the surface.
    const status = await worker.send({ type: 'GITHUB_BACKUP_STATUS' }, EDIT_SENDER);
    assert.equal(status.auto, true);
});

test('an edited ascent matches its save snapshot by aid after peak and date changes', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ settings: { enableGithubBackup: true, autoGithubBackup: true }, auth: AUTH, github: backend.handler });
    const pending = editSnapshot();
    pending.key = '900001|875|2026-07-13';
    pending.identity = { climberId: 900001, ascentId: 7654321, peakId: 875, date: '2026-07-13' };
    pending.snapshot.ascent = {
        id: 7654321,
        date: '2026-07-13',
        suffix: 'b',
        type: 'Successful Ascent (stood on the summit)',
        gainFt: '4200',
    };
    pending.snapshot.peak = { id: 875, name: 'Mount Garibaldi' };
    pending.snapshot.report = { markdown: 'Exact **edited** Markdown.' };

    await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...pending }, {
        tab: { id: 4 },
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001&aid=7654321',
    });
    const result = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT',
        auto: true,
        pageComplete: true,
        page: {
            ascent: {
                id: 7654321,
                date: '2026-07-13',
                suffix: 'b',
                type: 'Successful Ascent (stood on the summit)',
                gainFt: '4200',
            },
            peak: { id: 875, name: 'Mount Garibaldi', elevationFt: 8786 },
            report: { markdown: 'Converted edited Markdown.' },
        },
    }, PEAK_SENDER);

    assert.equal(result.ok, true);
    assert.equal(result.result.folder, '2026-07-13-mount-garibaldi-a7654321');
    const report = Object.entries(backend.state.contents)
        .find(([path]) => path.endsWith('/report.md'))[1];
    assert.match(report, /Exact \*\*edited\*\* Markdown\./,
        'the aid match preserves the save-time exact Markdown sidecar');
    assert.equal(worker.session.bpbGithubSnapshots[storedSnapshotKey(pending)], undefined,
        'the edited-ascent snapshot is consumed after the push');
});

test('identical new ascents in separate tabs retain and consume their own save snapshots', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ settings: { enableGithubBackup: true, autoGithubBackup: true }, auth: AUTH, github: backend.handler });
    const firstSender = { tab: { id: 41 }, url: EDIT_SENDER.url };
    const secondSender = { tab: { id: 42 }, url: EDIT_SENDER.url };
    const first = editSnapshot();
    first.snapshot.report.markdown = 'First tab report.';
    first.snapshot.ascent.gainFt = '4100';
    const second = editSnapshot();
    second.snapshot.report.markdown = 'Second tab report.';
    second.snapshot.ascent.gainFt = '4200';

    await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...first }, firstSender);
    await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...second }, secondSender);
    assert.ok(worker.session.bpbGithubSnapshots[storedSnapshotKey(first, firstSender)]);
    assert.ok(worker.session.bpbGithubSnapshots[storedSnapshotKey(second, secondSender)]);

    const page = aid => ({
        ascent: { id: aid, date: '2026-07-12' },
        peak: { id: 2296, name: 'Mount Rainier' },
        report: { markdown: 'Persisted fallback.' },
    });
    const savedSender = (tabId, aid) => ({
        tab: { id: tabId },
        url: `https://www.peakbagger.com/climber/ascent.aspx?aid=${aid}`,
    });

    const firstPush = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT',
        page: page(7000001),
        pageComplete: true,
        auto: true,
    }, savedSender(41, 7000001));
    assert.equal(firstPush.ok, true);
    let report = Object.entries(backend.state.contents)
        .find(([path]) => path.includes('a7000001/') && path.endsWith('/report.md'))[1];
    assert.match(report, /First tab report/);
    assert.equal(worker.session.bpbGithubSnapshots[storedSnapshotKey(first, firstSender)], undefined);
    assert.ok(worker.session.bpbGithubSnapshots[storedSnapshotKey(second, secondSender)],
        'consuming the first tab must leave the second tab pending');

    const secondPush = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT',
        page: page(7000002),
        pageComplete: true,
        auto: true,
    }, savedSender(42, 7000002));
    assert.equal(secondPush.ok, true);
    report = Object.entries(backend.state.contents)
        .find(([path]) => path.includes('a7000002/') && path.endsWith('/report.md'))[1];
    assert.match(report, /Second tab report/);
    assert.equal(worker.session.bpbGithubSnapshots[storedSnapshotKey(second, secondSender)], undefined);
});

test('individual backup never uses a different same-peak snapshot or accepts a sparse fallback', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ settings: { enableGithubBackup: true, autoGithubBackup: true }, auth: AUTH, github: backend.handler });
    const pageWithoutDate = {
        ascent: { id: 7654321 },
        peak: { id: 2296, name: 'Mount Rainier' },
        report: { markdown: '' },
    };

    await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...editSnapshot() }, EDIT_SENDER);
    const automatic = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT', page: pageWithoutDate, auto: true,
    }, PEAK_SENDER);
    assert.equal(automatic.ok, false);
    assert.equal(automatic.error.code, 'no-fresh-save',
        'auto mode must not merge a different same-peak ascent when the page date is unavailable');

    const sparseManual = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT', page: pageWithoutDate,
    }, PEAK_SENDER);
    assert.equal(sparseManual.ok, false);
    assert.equal(sparseManual.error.code, 'no-data');

    const persistedPage = {
        ascent: {
            id: 7654321,
            date: '2022-06-04',
            suffix: '',
            type: 'Successful Ascent (stood on the summit)',
            nightsOut: '0',
            pointFt: '4425',
            quality: '0',
        },
        peak: { id: 2296, name: 'Mount Rainier' },
        report: { markdown: '' },
    };
    const manual = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT', page: persistedPage, pageComplete: true,
    }, PEAK_SENDER);
    assert.equal(manual.ok, true);
    assert.equal(manual.result.folder, '2022-06-04-mount-rainier-a7654321');
    const jsonBlob = Object.entries(backend.state.contents).find(([path]) => path.endsWith('/ascent.json'))[1];
    const json = JSON.parse(jsonBlob);
    assert.equal(json.ascent.date, '2022-06-04');
    assert.equal(json.ascent.type, 'Successful Ascent (stood on the summit)');
    assert.equal(json.ascent.nightsOut, 0);
    assert.equal(json.ascent.pointFt, 4425);
    assert.equal(json.ascent.quality, 0);
    assert.ok(worker.session.bpbGithubSnapshots[storedSnapshotKey()],
        'the unrelated same-peak snapshot was not consumed');
});

test('a GitHub failure surfaces its typed code without throwing', async () => {
    const failing = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(401, { message: 'Bad credentials' });
        return null;
    };
    const worker = createWorker({ auth: AUTH, github: failing });
    const result = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT',
        pageComplete: true,
        page: { ascent: { id: 7654321 }, peak: { id: 2296, name: 'Mount Rainier' } },
    }, PEAK_SENDER);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'auth');
});

test('the snapshot store rejects a non-Peakbagger sender', async () => {
    const worker = createWorker({ auth: AUTH, github: gitDataBackend().handler });
    const res = await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...editSnapshot() }, { tab: { id: 1 }, url: 'https://evil.example/' });
    assert.equal(res.ok, false);
    // Nothing was stored (the cleanup pass may have initialised an empty map).
    assert.equal(Object.keys(worker.session.bpbGithubSnapshots || {}).length, 0);
});

test('repository selection inspects populated content before storing the choice', async () => {
    const extensionSender = { url: 'chrome-extension://test/options/options.html' };
    const repo = { owner: 'me', name: 'project', fullName: 'me/project', defaultBranch: 'main', installationId: 7 };
    const github = (method, path) => {
        if (method === 'GET' && path === '/repos/me/project') return respond(200, {
            default_branch: 'main', archived: false, size: 1, permissions: { push: true },
        });
        if (method === 'GET' && path === '/repos/me/project/git/ref/heads/main') return respond(200, { object: { sha: 'C0' } });
        if (method === 'GET' && path === '/repos/me/project/git/commits/C0') return respond(200, { tree: { sha: 'T0' } });
        if (method === 'GET' && path === '/repos/me/project/git/trees/T0') return respond(200, {
            tree: [{ path: 'README.md', type: 'blob', sha: 'r' }],
        });
        return null;
    };
    const worker = createWorker({ auth: { token: 'gho_secret', account: { login: 'me' } }, github });

    const first = await worker.send({ type: 'GITHUB_AUTH_SELECT_REPO', repo }, extensionSender);
    assert.equal(first.needsConfirmation, true);
    assert.equal(first.inspection.kind, 'existing');
    assert.equal(worker.local.bpbGithubAuth.repo, undefined, 'inspection must not persist an unconfirmed repository');

    const confirmed = await worker.send({ type: 'GITHUB_AUTH_SELECT_REPO', repo, confirmExisting: true }, extensionSender);
    assert.equal(confirmed.connected, true);
    assert.equal(worker.local.bpbGithubAuth.repo.fullName, 'me/project');
    assert.equal(worker.local.bpbGithubAuth.installationId, 7);
});

test('repository selection accepts GitHub\'s 409 response for an empty repository', async () => {
    const extensionSender = { url: 'chrome-extension://test/options/options.html' };
    const repo = { owner: 'me', name: 'backup', fullName: 'me/backup', defaultBranch: 'main', installationId: 7 };
    const github = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(200, {
            default_branch: 'main', archived: false, size: 0, permissions: { push: true },
        });
        if (method === 'GET' && path === '/repos/me/backup/git/ref/heads/main') {
            return respond(409, { message: 'Git Repository is empty.' });
        }
        return null;
    };
    const worker = createWorker({ auth: { token: 'gho_secret', account: { login: 'me' } }, github });

    const result = await worker.send({ type: 'GITHUB_AUTH_SELECT_REPO', repo }, extensionSender);
    assert.equal(result.connected, true);
    assert.equal(result.inspection.kind, 'empty');
    assert.equal(worker.local.bpbGithubAuth.repo.fullName, 'me/backup');
    assert.equal(worker.local.bpbGithubAuth.installationId, 7);
});

test('repository selection rejects ambiguous root backup folders', async () => {
    const extensionSender = { url: 'chrome-extension://test/options/options.html' };
    const repo = { owner: 'me', name: 'project', fullName: 'me/project', defaultBranch: 'main' };
    const github = (method, path) => {
        if (method === 'GET' && path === '/repos/me/project') return respond(200, {
            default_branch: 'main', archived: false, size: 1, permissions: { push: true },
        });
        if (method === 'GET' && path === '/repos/me/project/git/ref/heads/main') return respond(200, { object: { sha: 'C0' } });
        if (method === 'GET' && path === '/repos/me/project/git/commits/C0') return respond(200, { tree: { sha: 'T0' } });
        if (method === 'GET' && path === '/repos/me/project/git/trees/T0') return respond(200, {
            tree: [{ path: '2026-07-12-some-peak-a123', type: 'tree', sha: 'F0' }],
        });
        return null;
    };
    const worker = createWorker({ auth: { token: 'gho_secret', account: { login: 'me' } }, github });
    const result = await worker.send({ type: 'GITHUB_AUTH_SELECT_REPO', repo }, extensionSender);
    assert.equal(result.connected, false);
    assert.equal(result.error.code, 'repo-conflict');
    assert.equal(worker.local.bpbGithubAuth.repo, undefined);
});

test('a restarted worker resumes a pending device flow from session storage', async () => {
    const session = {};
    const local = { bpbGithubAuth: {
        token: 'gho_old',
        repo: { owner: 'old-account', name: 'old-repo', branch: 'main' },
        installationId: 99,
    } };
    const extensionSender = { url: 'chrome-extension://test/options/options.html' };
    const github = (method, path) => {
        if (method === 'POST' && path === 'https://github.com/login/device/code') return respond(200, {
            device_code: 'DC', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device',
            expires_in: 900, interval: 5,
        });
        if (method === 'POST' && path === 'https://github.com/login/oauth/access_token') {
            return respond(200, { access_token: 'gho_resumed', token_type: 'bearer', scope: '' });
        }
        if (method === 'GET' && path === '/user') return respond(200, { login: 'ada', id: 7 });
        if (method === 'GET' && path === '/user/installations') return respond(200, { installations: [] });
        return null;
    };

    const firstWorker = createWorker({ github, session, local });
    const began = await firstWorker.send({ type: 'GITHUB_AUTH_BEGIN' }, extensionSender);
    assert.equal(began.phase, 'polling');
    assert.equal(session.bpbGithubAuthPending.deviceCode, 'DC');

    // Simulate the service worker being torn down and later woken by the next
    // options-page status message after the server interval has elapsed.
    session.bpbGithubAuthPending.nextPollAt = 0;
    const restartedWorker = createWorker({ github, session, local });
    const resumed = await restartedWorker.send({ type: 'GITHUB_AUTH_STATE' }, extensionSender);
    assert.equal(resumed.phase, 'authorized');
    assert.equal(local.bpbGithubAuth.token, 'gho_resumed');
    assert.equal(local.bpbGithubAuth.repo, null, 'a new authorization must require a fresh inspected repository choice');
    assert.equal(local.bpbGithubAuth.installationId, null);
    assert.equal(session.bpbGithubAuthPending, undefined);
});
