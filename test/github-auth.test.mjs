// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The GitHub App device-flow client and the token/repo storage accessor. The
// device flow is driven against a scripted fetch with an injected clock (no
// network, no real timers) to pin the code request, the poll loop's handling of
// authorization_pending / slow_down / success, expiry, cancellation, and the
// error mapping. The store is exercised over a fake storage area.

import test from 'node:test';
import assert from 'node:assert/strict';
import { githubAuth as Auth } from '../src/github-auth.js';

// A controllable clock: wait() advances virtual time so a poll deadline can be
// reached without real delays.
const makeClock = () => {
    let t = 0;
    return {
        now: () => t,
        wait: async ms => { t += ms; },
        set: value => { t = value; },
    };
};

const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// A fetch stub that returns queued responses per URL. Each URL maps to a
// function (callCount) => response, so the token endpoint can answer
// differently on successive polls.
const makeFetch = routes => {
    const calls = [];
    const counts = {};
    const fetch = async (url, init = {}) => {
        counts[url] = (counts[url] || 0) + 1;
        calls.push({ url, body: init.body, headers: init.headers });
        const handler = routes[url];
        if (!handler) throw new Error(`unrouted: ${url}`);
        const result = handler(counts[url]);
        if (result instanceof Error) throw result;
        return result;
    };
    return { fetch, calls };
};

const DEVICE = 'https://github.com/login/device/code';
const TOKEN = 'https://github.com/login/oauth/access_token';

test('requestCode posts the client_id and returns the parsed device code', async () => {
    const { fetch, calls } = makeFetch({
        [DEVICE]: () => respond(200, {
            device_code: 'DC', user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900, interval: 5,
        }),
    });
    const flow = Auth.createDeviceFlow({ fetch });
    const code = await flow.requestCode();
    assert.equal(code.deviceCode, 'DC');
    assert.equal(code.userCode, 'ABCD-1234');
    assert.equal(code.interval, 5);
    assert.ok(calls[0].body.includes(`client_id=${Auth.CLIENT_ID}`));
    assert.equal(calls[0].headers.Accept, 'application/json');
});

test('pollForToken waits out authorization_pending and returns the token', async () => {
    const clock = makeClock();
    const { fetch } = makeFetch({
        [TOKEN]: n => (n < 3
            ? respond(200, { error: 'authorization_pending' })
            : respond(200, { access_token: 'gho_abc', token_type: 'bearer', scope: '' })),
    });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    const result = await flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 });
    assert.equal(result.token, 'gho_abc');
    assert.equal(result.tokenType, 'bearer');
});

test('slow_down lengthens the interval before the next poll', async () => {
    const clock = makeClock();
    const waits = [];
    const wait = async ms => { waits.push(ms); clock.set(clock.now() + ms); };
    const { fetch } = makeFetch({
        [TOKEN]: n => (n === 1
            ? respond(200, { error: 'slow_down', interval: 10 })
            : respond(200, { access_token: 'gho_xyz' })),
    });
    const flow = Auth.createDeviceFlow({ fetch, wait, now: clock.now });
    const result = await flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 });
    assert.equal(result.token, 'gho_xyz');
    // First poll waited 5s; after slow_down the interval became max(5+5, 10) = 10s.
    assert.deepEqual(waits, [5000, 10000]);
});

test('a denied authorization maps to the denied code', async () => {
    const clock = makeClock();
    const { fetch } = makeFetch({ [TOKEN]: () => respond(200, { error: 'access_denied' }) });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 }),
        err => err.code === Auth.AUTH_ERROR_CODES.DENIED,
    );
});

test('an expired user code maps to expired', async () => {
    const clock = makeClock();
    const { fetch } = makeFetch({ [TOKEN]: () => respond(200, { error: 'expired_token' }) });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 }),
        err => err.code === Auth.AUTH_ERROR_CODES.EXPIRED,
    );
});

test('the poll stops with expired once the deadline passes', async () => {
    const clock = makeClock();
    // Always pending; the deadline (30s) is reached after a few 5s waits.
    const { fetch } = makeFetch({ [TOKEN]: () => respond(200, { error: 'authorization_pending' }) });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 30 }),
        err => err.code === Auth.AUTH_ERROR_CODES.EXPIRED,
    );
});

test('an abort signal cancels a pending authorization', async () => {
    const clock = makeClock();
    const controller = new AbortController();
    const { fetch } = makeFetch({
        [TOKEN]: n => { if (n === 1) controller.abort(); return respond(200, { error: 'authorization_pending' }); },
    });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 }, { signal: controller.signal }),
        err => err.code === Auth.AUTH_ERROR_CODES.CANCELLED,
    );
});

test('a disabled device flow surfaces its own code from the code request', async () => {
    const { fetch } = makeFetch({ [DEVICE]: () => respond(200, { error: 'device_flow_disabled' }) });
    const flow = Auth.createDeviceFlow({ fetch });
    await assert.rejects(flow.requestCode(), err => err.code === Auth.AUTH_ERROR_CODES.DEVICE_FLOW_DISABLED);
});

test('a network failure surfaces the network code', async () => {
    const fetch = async () => { throw new TypeError('offline'); };
    const flow = Auth.createDeviceFlow({ fetch });
    await assert.rejects(flow.requestCode(), err => err.code === Auth.AUTH_ERROR_CODES.NETWORK);
});

test('authorize requests a code, reports it, then resolves with the token', async () => {
    const clock = makeClock();
    const { fetch } = makeFetch({
        [DEVICE]: () => respond(200, { device_code: 'DC', user_code: 'WXYZ-7890', expires_in: 900, interval: 5 }),
        [TOKEN]: () => respond(200, { access_token: 'gho_final' }),
    });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    let shown = null;
    const result = await flow.authorize({ onCode: code => { shown = code.userCode; } });
    assert.equal(shown, 'WXYZ-7890');
    assert.equal(result.token, 'gho_final');
});

// ---- installation / repository discovery ----------------------------------

const API = 'https://api.github.com';

test('listBackupRepositories returns every granted repo across the app installations', async () => {
    const routes = {
        [`${API}/user/installations`]: () => respond(200, {
            installations: [
                { id: 11, app_slug: 'better-peakbagger-backup', account: { login: 'me' } },
                { id: 22, app_slug: 'some-other-app', account: { login: 'me' } },
            ],
        }),
        [`${API}/user/installations/11/repositories?per_page=100`]: () => respond(200, {
            repositories: [
                { id: 1, name: 'peaks', full_name: 'me/peaks', default_branch: 'main', owner: { login: 'me' } },
            ],
        }),
    };
    const { fetch } = makeFetch(routes);
    const result = await Auth.listBackupRepositories({ fetch, token: 't' });
    // Only our app's installation (11) is queried; the other app is ignored.
    assert.equal(result.installationCount, 1);
    assert.deepEqual(result.repos, [{
        owner: 'me', name: 'peaks', fullName: 'me/peaks', id: 1, defaultBranch: 'main', installationId: 11,
    }]);
});

test('discovery reports zero installations so the UI can offer the install link', async () => {
    const { fetch } = makeFetch({ [`${API}/user/installations`]: () => respond(200, { installations: [] }) });
    const result = await Auth.listBackupRepositories({ fetch, token: 't' });
    assert.equal(result.installationCount, 0);
    assert.deepEqual(result.repos, []);
});

test('a dead token during discovery maps to expired', async () => {
    const { fetch } = makeFetch({ [`${API}/user/installations`]: () => respond(401, { message: 'Bad credentials' }) });
    await assert.rejects(
        Auth.listBackupRepositories({ fetch, token: 't' }),
        err => err.code === Auth.AUTH_ERROR_CODES.EXPIRED,
    );
});

test('fetchAccount returns the login behind the token', async () => {
    const { fetch } = makeFetch({ [`${API}/user`]: () => respond(200, { login: 'ada', id: 7 }) });
    assert.deepEqual(await Auth.fetchAccount({ fetch, token: 't' }), { login: 'ada', id: 7 });
});

// ---- storage accessor -----------------------------------------------------

// A minimal chrome.storage.local stand-in.
const makeArea = () => {
    const data = {};
    return {
        data,
        get: async key => (key in data ? { [key]: data[key] } : {}),
        set: async obj => { Object.assign(data, obj); },
        remove: async key => { delete data[key]; },
    };
};

test('the auth store keeps the token and repo locally and reports connection', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    assert.equal(await store.isConnected(), false);
    assert.equal(await store.getToken(), null);

    await store.setCredential({ token: 'gho_secret', scope: '' });
    assert.equal(await store.getToken(), 'gho_secret');
    // A token alone is not "connected" — a repo must be chosen.
    assert.equal(await store.isConnected(), false);

    await store.setRepo({ owner: 'me', name: 'backup', branch: 'main' });
    assert.equal(await store.isConnected(), true);
    assert.deepEqual(await store.getRepo(), { owner: 'me', name: 'backup', branch: 'main' });

    // The secret lands only under the local key, never a sync key.
    assert.ok('bpbGithubAuth' in area.data);
    assert.equal(area.data.bpbGithubAuth.token, 'gho_secret');
});

test('clear drops the local token and repo', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    await store.setCredential({ token: 'gho_secret' });
    await store.setRepo({ owner: 'me', name: 'backup' });
    await store.clear();
    assert.equal(await store.getToken(), null);
    assert.equal(await store.isConnected(), false);
    assert.ok(!('bpbGithubAuth' in area.data));
});
