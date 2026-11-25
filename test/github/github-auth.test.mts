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
import {
    githubAuth as Auth,
    STORAGE_KEY,
    EPOCH_KEY,
    type GithubAccount,
    type GithubAuthRecord,
} from '../../src/github/github-auth.ts';
import { githubErrors as GithubErrors } from '../../src/github/github-errors.ts';
import type { GithubFetch, GithubFetchResponse } from '../../src/github/github-api.ts';
import { required } from '../helpers/required.mts';

const { ERROR_CODES, GithubError } = GithubErrors;

test('GitHub auth publishes its local storage key', () => {
    assert.equal(STORAGE_KEY, 'bpbGithubAuth');
    assert.equal(Auth.STORAGE_KEY, STORAGE_KEY);
    assert.equal(EPOCH_KEY, 'bpbGithubAuthEpoch');
    assert.equal(Auth.EPOCH_KEY, EPOCH_KEY);
});

// A controllable clock: wait() advances virtual time so a poll deadline can be
// reached without real delays.
const makeClock = () => {
    let t = 0;
    return {
        now: () => t,
        wait: async (ms: number) => { t += ms; },
        set: (value: number) => { t = value; },
    };
};

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): GithubFetchResponse => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] || null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// A fetch stub that returns queued responses per URL. Each URL maps to a
// function (callCount) => response, so the token endpoint can answer
// differently on successive polls.
const makeFetch = (routes: Record<string, (count: number) => GithubFetchResponse | Error>) => {
    const calls: ({ url: string } & Pick<RequestInit, 'method' | 'cache' | 'body' | 'headers'>)[] = [];
    const counts: Record<string, number> = {};
    const fetch: GithubFetch = async (url, init = {}) => {
        counts[url] = (counts[url] || 0) + 1;
        calls.push({ url, method: init.method, cache: init.cache, body: init.body, headers: init.headers });
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
    assert.equal(calls.length, 1);
    const { body, headers, method } = required(calls[0]);
    assert.equal(method, 'POST');
    assert.ok(typeof body === 'string');
    assert.equal(new URLSearchParams(body).get('client_id'), Auth.CLIENT_ID);
    const requestHeaders = new Headers(headers);
    assert.equal(requestHeaders.get('Accept'), 'application/json');
    assert.equal(requestHeaders.get('Content-Type'), 'application/x-www-form-urlencoded');
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
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); clock.set(clock.now() + ms); };
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
        err => err instanceof GithubError && err.code === ERROR_CODES.DENIED,
    );
});

test('a structured non-2xx OAuth response keeps its typed error', async () => {
    const clock = makeClock();
    const { fetch } = makeFetch({
        [TOKEN]: () => respond(400, { error: 'access_denied', error_description: 'The user declined.' }),
    });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 }),
        err => err instanceof GithubError && err.code === ERROR_CODES.DENIED && /declined/.test(err.message),
    );
});

test('an expired user code maps to expired', async () => {
    const clock = makeClock();
    const { fetch } = makeFetch({ [TOKEN]: () => respond(200, { error: 'expired_token' }) });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 900 }),
        err => err instanceof GithubError && err.code === ERROR_CODES.EXPIRED,
    );
});

test('the poll stops with expired once the deadline passes', async () => {
    const clock = makeClock();
    // Always pending; the deadline (30s) is reached after a few 5s waits.
    const { fetch } = makeFetch({ [TOKEN]: () => respond(200, { error: 'authorization_pending' }) });
    const flow = Auth.createDeviceFlow({ fetch, wait: clock.wait, now: clock.now });
    await assert.rejects(
        flow.pollForToken({ deviceCode: 'DC', interval: 5, expiresIn: 30 }),
        err => err instanceof GithubError && err.code === ERROR_CODES.EXPIRED,
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
        err => err instanceof GithubError && err.code === ERROR_CODES.CANCELLED,
    );
});

test('a disabled device flow surfaces its own code from the code request', async () => {
    const { fetch } = makeFetch({ [DEVICE]: () => respond(200, { error: 'device_flow_disabled' }) });
    const flow = Auth.createDeviceFlow({ fetch });
    await assert.rejects(flow.requestCode(), err => err instanceof GithubError && err.code === ERROR_CODES.DEVICE_FLOW_DISABLED);
});

test('a network failure surfaces the network code', async () => {
    const fetch = async () => { throw new TypeError('offline'); };
    const flow = Auth.createDeviceFlow({ fetch });
    await assert.rejects(flow.requestCode(), err => err instanceof GithubError && err.code === ERROR_CODES.NETWORK);
});

test('device authorization rejects oversized bodies and valid-size excessive structure', async () => {
    let read = false;
    const declared = Auth.createDeviceFlow({
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: name => name === 'content-length' ? String(Auth.DEVICE_RESPONSE_MAX_BYTES + 1) : null },
            body: {
                getReader() { read = true; throw new Error('must not open oversized stream'); },
                cancel: async () => {},
            },
            text: async () => { read = true; return '{}'; },
        }),
    });
    await assert.rejects(declared.requestCode(),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /too large/.test(error.message));
    assert.equal(read, false);

    let nested: { child?: object } = {};
    for (let depth = 0; depth <= Auth.DEVICE_STRUCTURE_LIMITS.maxDepth; depth += 1) {
        nested = { child: nested };
    }
    const structured = Auth.createDeviceFlow({ fetch: async () => respond(200, nested) });
    await assert.rejects(structured.requestCode(),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /structure/.test(error.message));
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
        [`${API}/user/installations?per_page=100`]: () => respond(200, {
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
    const { fetch } = makeFetch({ [`${API}/user/installations?per_page=100`]: () => respond(200, { installations: [] }) });
    const result = await Auth.listBackupRepositories({ fetch, token: 't' });
    assert.equal(result.installationCount, 0);
    assert.deepEqual(result.repos, []);
});

test('a dead stored token during discovery maps to auth, not an expired device code', async () => {
    const { fetch } = makeFetch({ [`${API}/user/installations?per_page=100`]: () => respond(401, { message: 'Bad credentials' }) });
    await assert.rejects(
        Auth.listBackupRepositories({ fetch, token: 't' }),
        err => err instanceof GithubError && err.code === ERROR_CODES.AUTH,
    );
});

test('repository discovery uses the shared REST policy and preserves rate-limit errors', async () => {
    const { fetch, calls } = makeFetch({
        [`${API}/user/installations?per_page=100`]: () => respond(403,
            { message: 'API rate limit exceeded' },
            { 'x-ratelimit-remaining': '0' }),
    });
    await assert.rejects(
        Auth.listBackupRepositories({ fetch, token: 't' }),
        error => error instanceof GithubErrors.GithubError
            && error.code === ERROR_CODES.RATE_LIMIT
            && error.status === 403,
    );
    const request = required(calls[0]);
    const headers = new Headers(request.headers);
    assert.equal(request.method, 'GET');
    assert.equal(request.cache, 'no-store');
    assert.equal(headers.get('Authorization'), 'Bearer t');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2022-11-28');
});

test('repository discovery follows installation and repository pagination', async () => {
    const routes = {
        [`${API}/user/installations?per_page=100`]: () => respond(200, {
            installations: [{ id: 11, app_slug: 'better-peakbagger-backup' }],
        }, { link: `<${API}/user/installations?per_page=100&page=2>; rel="next"` }),
        [`${API}/user/installations?per_page=100&page=2`]: () => respond(200, {
            installations: [{ id: 22, app_slug: 'better-peakbagger-backup' }],
        }),
        [`${API}/user/installations/11/repositories?per_page=100`]: () => respond(200, {
            repositories: [{ id: 1, name: 'one', full_name: 'me/one', owner: { login: 'me' } }],
        }, { link: `<${API}/user/installations/11/repositories?per_page=100&page=2>; rel="next"` }),
        [`${API}/user/installations/11/repositories?per_page=100&page=2`]: () => respond(200, {
            repositories: [{ id: 2, name: 'two', full_name: 'me/two', owner: { login: 'me' } }],
        }),
        [`${API}/user/installations/22/repositories?per_page=100`]: () => respond(200, {
            repositories: [{ id: 3, name: 'three', full_name: 'me/three', owner: { login: 'me' } }],
        }),
    };
    const { fetch, calls } = makeFetch(routes);
    const result = await Auth.listBackupRepositories({ fetch, token: 't' });

    assert.equal(result.installationCount, 2);
    assert.deepEqual(result.repos.map(repo => repo.fullName), ['me/one', 'me/two', 'me/three']);
    assert.equal(calls.length, 5);
});

test('repository discovery rejects missing and excessive paginated collections', async () => {
    const missing = makeFetch({
        [`${API}/user/installations?per_page=100`]: () => respond(200, {}),
    });
    await assert.rejects(Auth.listBackupRepositories({ fetch: missing.fetch, token: 't' }),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID && /unexpected/.test(error.message));

    const excessive = makeFetch({
        [`${API}/user/installations?per_page=100`]: () => respond(200, {
            installations: Array.from({ length: Auth.DISCOVERY_MAX_ITEMS + 1 }, (_, id) => ({ id })),
        }),
    });
    await assert.rejects(Auth.listBackupRepositories({ fetch: excessive.fetch, token: 't' }),
        error => error instanceof GithubError && error.code === ERROR_CODES.INVALID);
});

test('fetchAccount returns the login behind the token', async () => {
    const { fetch } = makeFetch({ [`${API}/user`]: () => respond(200, { login: 'ada', id: 7 }) });
    assert.deepEqual(await Auth.fetchAccount({ fetch, token: 't' }), { login: 'ada', id: 7 });
});

// ---- storage accessor -----------------------------------------------------

// Legacy persisted credentials can have a login without an account ID.
const account = { login: 'ada' } as GithubAccount;

// A minimal chrome.storage.local stand-in.
const makeArea = () => {
    const data: Record<string, unknown> = {};
    return {
        data,
        get: async (keys: string | string[]) => {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested
                .filter(key => key in data)
                .map(key => [key, data[key]]));
        },
        set: async (obj: Record<string, unknown>) => { Object.assign(data, obj); },
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
    const saved = area.data[STORAGE_KEY];
    assert.ok(saved && typeof saved === 'object' && 'token' in saved);
    assert.equal(saved.token, 'gho_secret');
    assert.equal(area.data.bpbGithubAuthEpoch, 2);
});

test('clear drops the local token and repo while preserving a generation tombstone', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    await store.setCredential({ token: 'gho_secret' });
    await store.setRepo({ owner: 'me', name: 'backup' });
    await store.clear();
    assert.equal(await store.getToken(), null);
    assert.equal(await store.isConnected(), false);
    assert.equal(area.data.bpbGithubAuth, null);
    assert.equal(area.data.bpbGithubAuthEpoch, 3);
});

test('auth-store replacement atomically installs or restores one complete connection', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    const imported = {
        token: 'ghu_imported',
        account,
        repo: { owner: 'ada', name: 'peaks', branch: 'main' },
        installationId: 7,
    };

    assert.deepEqual(await store.replace(imported), imported);
    assert.deepEqual(await store.read(), imported);
    await store.replace(null);
    assert.equal(await store.read(), null);
    await assert.rejects(store.replace([] as unknown as GithubAuthRecord), /must be an object/);
});

test('conditional auth restore yields to a newer queued reconnect', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    const previous = { token: 'old-token', repo: { owner: 'old', name: 'backup' } };
    const imported = { token: 'imported-token', repo: { owner: 'ada', name: 'peaks' } };
    const newer = { token: 'newer-token', repo: { owner: 'grace', name: 'summits' } };
    await store.replace(previous);
    await store.replace(imported);

    const reconnect = store.replace(newer);
    const rollback = store.replaceIfCurrent(imported, previous);
    await reconnect;

    assert.deepEqual(await rollback, { replaced: false, current: newer });
    assert.deepEqual(await store.read(), newer);
});

test('snapshot replacement rejects disconnect and same-record reconnect generations', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    const credential = { token: 'same-token', account };
    await store.replace(credential);
    const inspected = await store.readSnapshot();

    await store.clear();
    await store.replace(credential);
    const result = await store.replaceIfSnapshot(inspected, {
        ...credential,
        repo: { owner: 'ada', name: 'stale-repo' },
    });

    assert.equal(result.replaced, false);
    assert.deepEqual(result.current, { auth: credential, epoch: 3 });
    assert.deepEqual(await store.read(), credential);
});

test('snapshot replacement writes repository, installation, and epoch atomically', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    await store.replace({ token: 'gho_secret', account });
    const inspected = await store.readSnapshot();
    const writes: Record<string, unknown>[] = [];
    const set = area.set;
    area.set = async patch => {
        writes.push(structuredClone(patch));
        await set(patch);
    };
    const replacement = {
        ...inspected.auth,
        repo: { owner: 'ada', name: 'peaks', branch: 'main' },
        installationId: 7,
    };

    const result = await store.replaceIfSnapshot(inspected, replacement);

    assert.deepEqual(result, { replaced: true, current: { auth: replacement, epoch: 2 } });
    const expected = {
        bpbGithubAuth: replacement,
        bpbGithubAuthEpoch: 2,
    };
    assert.deepEqual(writes, [expected]);
    assert.deepEqual(area.data, expected);
});

test('concurrent auth-store writes preserve both patches', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    await Promise.all([
        store.setAccount(account),
        store.setRepo({ owner: 'ada', name: 'peaks' }),
    ]);

    assert.deepEqual(await store.read(), {
        account,
        repo: { owner: 'ada', name: 'peaks' },
    });
});

test('auth-store mutations fail closed when their authoritative read fails', async () => {
    let writes = 0;
    const store = Auth.createAuthStore({
        get: async () => { throw new Error('local read failed'); },
        set: async () => { writes++; },
    });

    await assert.rejects(store.read(), /local read failed/);
    await assert.rejects(store.setRepo({ owner: 'ada', name: 'peaks' }), /local read failed/);
    assert.equal(writes, 0, 'a failed read must not be replaced with an empty auth record');
});

test('auth-store write failures propagate and do not poison later mutations', async () => {
    const area = makeArea();
    const nativeSet = area.set;
    let fail = true;
    area.set = async value => {
        if (fail) {
            fail = false;
            throw new Error('local write failed');
        }
        await nativeSet(value);
    };
    const store = Auth.createAuthStore(area);

    await assert.rejects(store.setAccount(account), /local write failed/);
    await store.setRepo({ owner: 'ada', name: 'peaks' });
    assert.deepEqual(await store.read(), {
        repo: { owner: 'ada', name: 'peaks' },
    });
});

test('auth-store clear propagates replacement failures and keeps the credential generation', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    await store.setCredential({ token: 'gho_secret' });
    const nativeSet = area.set;
    area.set = async value => {
        if (value[STORAGE_KEY] === null) throw new Error('local replacement failed');
        return nativeSet(value);
    };

    await assert.rejects(store.clear(), /local replacement failed/);
    assert.equal(await store.getToken(), 'gho_secret');
    assert.equal(area.data[EPOCH_KEY], 1);
});

test('snapshot replacement storage failure preserves the complete prior generation', async () => {
    const area = makeArea();
    const store = Auth.createAuthStore(area);
    await store.replace({ token: 'gho_secret', account });
    const inspected = await store.readSnapshot();
    const nativeSet = area.set;
    area.set = async value => {
        const next = value[STORAGE_KEY];
        if (next && typeof next === 'object' && 'repo' in next && next.repo) {
            throw new Error('local replacement failed');
        }
        return nativeSet(value);
    };

    await assert.rejects(store.replaceIfSnapshot(inspected, {
        ...inspected.auth,
        repo: { owner: 'ada', name: 'peaks' },
        installationId: 7,
    }), /local replacement failed/);
    assert.deepEqual(await store.readSnapshot(), inspected);
});

test('device authorization identifies HTTP 429 before reading an unusable body', async () => {
    let cancelled = false;
    let calls = 0;
    let read = false;
    const flow = Auth.createDeviceFlow({ now: () => 1000, fetch: async () => {
        calls++;
        return {
            status: 429,
            ok: false,
            headers: new Headers({ 'retry-after': '60' }),
            body: {
                getReader() { read = true; throw new Error('must not open rate-limited stream'); },
                cancel() { cancelled = true; },
            },
            text() { read = true; throw new Error('unreadable'); },
        };
    } });
    await assert.rejects(flow.requestCode(), { code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 60 });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(read, false);
});
