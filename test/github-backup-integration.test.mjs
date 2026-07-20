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

const workerBundle = await fs.readFile(new URL('../dist/background.js', import.meta.url), 'utf8');

const event = () => { const listeners = []; return { listeners, addListener: l => listeners.push(l) }; };
const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
});

const createWorker = ({ settings = { enableGithubBackup: true }, auth = null, github, session: sharedSession = null, local: sharedLocal = null } = {}) => {
    const session = sharedSession || {};
    const sync = { bpbSettings: structuredClone(settings) };
    const local = sharedLocal || (auth ? { bpbGithubAuth: structuredClone(auth) } : {});
    const area = values => ({
        get: async key => ({ [key]: structuredClone(values[key]) }),
        set: async patch => Object.assign(values, structuredClone(patch)),
        remove: async key => { delete values[key]; },
    });
    const runtimeMessage = event();
    const browser = {
        storage: { session: area(session), sync: area(sync), local: area(local), onChanged: { addListener: () => {} } },
        runtime: {
            id: 'test',
            onMessage: runtimeMessage,
            getManifest: () => ({ version: '2.2.0' }),
            getURL: p => `chrome-extension://test/${p || ''}`,
        },
        tabs: { onRemoved: event() },
        alarms: { create: () => {}, onAlarm: event() },
    };
    const githubCalls = [];
    const fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
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
        browser, fetch, URL, URLSearchParams, Math, Date, console, structuredClone, AbortController, TextEncoder,
    });
    context.globalThis = context;
    context.self = context;
    vm.runInContext(workerBundle, context, { filename: 'dist/background.js' });
    const listener = runtimeMessage.listeners[0];
    const send = (message, sender = {}) => new Promise(resolve => { listener(message, sender, resolve); });
    return { send, session, local };
};

// A scripted GitHub Git Data backend that records the tree it is asked to write.
const gitDataBackend = () => {
    const state = { blobs: {}, tree: null, n: 0 };
    const handler = (method, path, body) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(200, { default_branch: 'main', archived: false, permissions: { push: true } });
        if (method === 'GET' && path === '/repos/me/backup/git/ref/heads/main') return respond(200, { object: { sha: 'C0' } });
        if (method === 'GET' && path === '/repos/me/backup/git/commits/C0') return respond(200, { sha: 'C0', tree: { sha: 'T0' } });
        if (method === 'GET' && path === '/repos/me/backup/git/trees/T0') return respond(200, { tree: [] });
        if (method === 'POST' && path === '/repos/me/backup/git/blobs') { const sha = `blob${++state.n}`; state.blobs[sha] = body.content; return respond(201, { sha }); }
        if (method === 'POST' && path === '/repos/me/backup/git/trees') { state.tree = body; return respond(201, { sha: 'T1' }); }
        if (method === 'POST' && path === '/repos/me/backup/git/commits') return respond(201, { sha: 'C1', html_url: 'https://github.com/me/backup/commit/C1' });
        if (method === 'PATCH' && path === '/repos/me/backup/git/refs/heads/main') return respond(200, { object: { sha: 'C1' } });
        return null;
    };
    return { handler, state };
};

const AUTH = { token: 'gho_secret', repo: { owner: 'me', name: 'backup', branch: 'main', fullName: 'me/backup' }, account: { login: 'me' } };
const PEAK_SENDER = { tab: { id: 5 }, url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=7654321' };
const EDIT_SENDER = { tab: { id: 4 }, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?cid=900001&pid=2296' };
const LIST_SENDER = { tab: { id: 6 }, url: 'https://www.peakbagger.com/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999' };

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

test('a saved ascent is backed up: snapshot + page merge, one commit, snapshot consumed', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });

    // 1. The edit page stores the save-time snapshot.
    const stored = await worker.send({ type: 'GITHUB_BACKUP_SNAPSHOT', ...editSnapshot() }, EDIT_SENDER);
    assert.equal(stored.ok, true);
    assert.ok(worker.session.bpbGithubSnapshots['900001|2296|2026-07-12']);

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
        page: {
            ascent: { id: 7654321, date: '2026-07-12' },
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
    const jsonBlob = Object.values(backend.state.blobs).find(c => c.includes('"schemaVersion"'));
    const json = JSON.parse(jsonBlob);
    assert.equal(json.ascent.id, 7654321);
    assert.equal(json.ascent.gainFt, 9000);
    assert.equal(json.peak.elevationFt, 14411);
    assert.equal(json.peak.location, 'Washington, USA');
    assert.equal(json.backup.extensionVersion, '2.2.0');
    assert.ok(json.backup.syncedAt, 'syncedAt is stamped at push time');

    // report.md carries the snapshot's resolved Markdown body.
    const mdBlob = Object.values(backend.state.blobs).find(c => c.startsWith('---\n'));
    assert.match(mdBlob, /\*\*Great climb\*\* under blue skies\./);

    // The snapshot has served its purpose and is dropped.
    assert.equal(worker.session.bpbGithubSnapshots['900001|2296|2026-07-12'], undefined);
});

test('profile backfill lists repository folders and pushes a direct snapshot through the built worker', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const status = await worker.send({ type: 'GITHUB_BACKUP_PROFILE_STATUS' }, LIST_SENDER);
    assert.equal(status.ok, true);
    assert.deepEqual(Array.from(status.folders), []);
    assert.equal('token' in status, false);

    const snapshot = {
        ascent: { id: 7654321, date: '2026-07-12', suffix: '', route: 'Disappointment Cleaver' },
        peak: { id: 2296, name: 'Mount Rainier' },
        report: { markdown: 'Backfilled **report**.' },
        backup: { extensionVersion: '', syncedAt: null },
    };
    const result = await worker.send({
        type: 'GITHUB_BACKUP_PROFILE_ASCENT', aid: 7654321, snapshot, gpx: '<gpx/>',
    }, LIST_SENDER);
    assert.equal(result.ok, true);
    assert.equal(result.result.folder, '2026-07-12-mount-rainier-a7654321');
    const json = JSON.parse(Object.values(backend.state.blobs).find(content => content.includes('"schemaVersion"')));
    assert.equal(json.ascent.id, 7654321);
    assert.equal(json.backup.extensionVersion, '2.2.0');
    assert.ok(json.backup.syncedAt);
});

test('profile messages require ClimbListC and matching ascent identity', async () => {
    const backend = gitDataBackend();
    const worker = createWorker({ auth: AUTH, github: backend.handler });
    const snapshot = { ascent: { id: 7 }, peak: { id: 8, name: 'Peak' }, report: { markdown: '' } };
    const wrongSurface = await worker.send({ type: 'GITHUB_BACKUP_PROFILE_ASCENT', aid: 7, snapshot }, PEAK_SENDER);
    assert.equal(wrongSurface.error.code, 'forbidden');
    const mismatched = await worker.send({ type: 'GITHUB_BACKUP_PROFILE_ASCENT', aid: 9, snapshot }, LIST_SENDER);
    assert.equal(mismatched.error.code, 'no-data');
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
    const status = await worker.send({ type: 'GITHUB_BACKUP_STATUS' }, PEAK_SENDER);
    assert.equal(status.auto, true);
});

test('automatic backup rejects a peak-only snapshot match that manual backup may use', async () => {
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

    const manual = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT', page: pageWithoutDate,
    }, PEAK_SENDER);
    assert.equal(manual.ok, true, 'the visible manual action keeps the best-effort peak-only fallback');
});

test('a GitHub failure surfaces its typed code without throwing', async () => {
    const failing = (method, path) => {
        if (method === 'GET' && path === '/repos/me/backup') return respond(401, { message: 'Bad credentials' });
        return null;
    };
    const worker = createWorker({ auth: AUTH, github: failing });
    const result = await worker.send({
        type: 'GITHUB_BACKUP_ASCENT',
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
