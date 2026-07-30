// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoRoutes, photoRoutes as PhotoRoutes } from '../../src/background/photo-routes.js';
import { imgbbAuth as ImgbbAuth } from '../../src/photos/imgbb-auth.js';

const makeStorageArea = () => {
    const values = {};
    return {
        values,
        async get(key) { return { [key]: structuredClone(values[key]) }; },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) { delete values[key]; },
    };
};

const harness = () => {
    const local = makeStorageArea();
    const session = makeStorageArea();
    const sent = [];
    const created = [];
    let clock = Date.parse('2026-07-27T18:00:00.000Z');
    const ext = {
        runtime: { getURL: path => `chrome-extension://test-extension/${path}` },
        permissions: { contains: async value => value.origins[0] === 'https://api.imgbb.com/*' },
        tabs: {
            create: async ({ url }) => {
                created.push(url);
                return { id: 91 };
            },
            sendMessage: async (tabId, message, options) => {
                sent.push({ tabId, message, options });
                return { ok: true };
            },
        },
    };
    let queue = Promise.resolve();
    const readMap = async key => (await session.get(key))[key] || {};
    const mutateMap = (key, mutate) => {
        const result = queue.then(async () => {
            const value = await readMap(key);
            const answer = await mutate(value);
            await session.set({ [key]: value });
            return answer;
        });
        queue = result.catch(() => {});
        return result;
    };
    const keyStore = ImgbbAuth.createKeyStore(local);
    const routes = createPhotoRoutes({
        ext,
        storage: () => session,
        now: () => clock,
        isPeakbaggerSender: sender => sender?.url?.startsWith('https://www.peakbagger.com/'),
        mutateMap,
        readMap,
        randomToken: () => 'return-token',
        keyStore,
    });
    return {
        routes,
        keyStore,
        local,
        session,
        sent,
        created,
        advance(ms) { clock += ms; },
    };
};

const peakSender = {
    url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=33&cid=22',
    tab: { id: 41 },
    frameId: 0,
};
const photoSender = {
    url: 'chrome-extension://test-extension/photos/photos.html?mode=edit&returnToken=return-token',
    tab: { id: 91 },
    frameId: 0,
};
const optionsSender = {
    url: 'chrome-extension://test-extension/options/options.html#capture-photos',
    tab: { id: 77 },
    frameId: 0,
};
// A different packaged page of the same extension: same origin, wrong path.
const strayExtensionSender = {
    url: 'chrome-extension://test-extension/options/buddy-refresh.html',
    tab: { id: 78 },
    frameId: 0,
};

test('opens one bound extension editor and stores a short-lived return context', async () => {
    const h = harness();
    const result = await h.routes.handlers.PHOTO_EDITOR_OPEN({
        mode: 'edit',
        identity: { cid: 22, aid: null, pid: 33 },
    }, peakSender);
    assert.deepEqual(result, { ok: true, tabId: 91 });
    assert.equal(h.created.length, 1);
    const url = new URL(h.created[0]);
    assert.equal(url.pathname, '/photos/photos.html');
    assert.equal(url.searchParams.get('returnToken'), 'return-token');
    const contexts = h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY];
    assert.equal(contexts['return-token'].sourceTabId, 41);
    assert.equal(contexts['return-token'].editorTabId, 91);
    assert.deepEqual(contexts['return-token'].identity, { cid: 22, aid: null, pid: 33 });
});

test('leases a remembered key only to the exact packaged photo page', async () => {
    const h = harness();
    await h.keyStore.setKey('secret-key');
    assert.deepEqual(await h.routes.handlers.PHOTO_IMGBB_LEASE_KEY({}, photoSender), {
        ok: true,
        key: 'secret-key',
    });
    assert.deepEqual(await h.routes.handlers.PHOTO_IMGBB_LEASE_KEY({}, peakSender), {
        ok: false,
        error: { code: 'forbidden' },
    });
    const status = await h.routes.handlers.PHOTO_IMGBB_STATUS({}, photoSender);
    assert.equal(status.configured, true);
    assert.equal(status.permissionGranted, true);
    assert.equal('key' in status, false);
});

test('saves and removes the remembered key without exposing it in status', async () => {
    const h = harness();
    assert.equal((await h.routes.handlers.PHOTO_IMGBB_SAVE_KEY({
        key: 'new-key',
    }, photoSender)).ok, true);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'new-key');
    const status = await h.routes.handlers.PHOTO_IMGBB_STATUS({}, photoSender);
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('new-key'), false);
    assert.deepEqual(await h.routes.handlers.PHOTO_IMGBB_REMOVE_KEY({}, photoSender), { ok: true });
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY], undefined);
});

test('the settings page configures the key but can never lease it back', async () => {
    const h = harness();
    assert.equal((await h.routes.handlers.PHOTO_IMGBB_SAVE_KEY({
        key: 'options-key',
    }, optionsSender)).ok, true);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'options-key');

    const status = await h.routes.handlers.PHOTO_IMGBB_STATUS({}, optionsSender);
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('options-key'), false);

    // Reading the credential back belongs to the page that uploads, and only
    // that page can return an insertion to a report.
    assert.deepEqual(await h.routes.handlers.PHOTO_IMGBB_LEASE_KEY({}, optionsSender), {
        ok: false,
        error: { code: 'forbidden' },
    });
    assert.deepEqual(await h.routes.handlers.PHOTO_INSERT_COMMIT({
        returnToken: 'return-token',
        localPhotoId: 'photo-1',
        url: 'https://i.ibb.co/abc/topo.jpg',
        alt: 'Topo',
    }, optionsSender), { ok: false, error: { code: 'forbidden' } });

    // The gate is path-exact: another packaged page of the same extension is
    // not a credential surface.
    for (const type of ['PHOTO_IMGBB_STATUS', 'PHOTO_IMGBB_SAVE_KEY', 'PHOTO_IMGBB_REMOVE_KEY']) {
        assert.deepEqual(await h.routes.handlers[type]({ key: 'stray-key' }, strayExtensionSender), {
            ok: false,
            error: { code: 'forbidden' },
        }, `${type} must reject an unrelated extension page`);
    }
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'options-key');

    assert.deepEqual(await h.routes.handlers.PHOTO_IMGBB_REMOVE_KEY({}, optionsSender), { ok: true });
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY], undefined);
});

test('returns one sanitized insertion to the originating tab and rejects replay', async () => {
    const h = harness();
    await h.routes.handlers.PHOTO_EDITOR_OPEN({
        mode: 'edit',
        identity: { cid: 22, pid: 33 },
    }, peakSender);
    const message = {
        returnToken: 'return-token',
        localPhotoId: 'photo-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        alt: 'North face route',
    };
    assert.deepEqual(await h.routes.handlers.PHOTO_INSERT_COMMIT(message, photoSender), {
        ok: true,
        identity: { cid: 22, aid: null, pid: 33 },
    });
    assert.deepEqual(h.sent, [{
        tabId: 41,
        message: { type: 'PHOTO_INSERT_RESULT', ...message },
        options: { frameId: 0 },
    }]);
    const replay = await h.routes.handlers.PHOTO_INSERT_COMMIT(message, photoSender);
    assert.equal(replay.ok, false);
    assert.equal(replay.error.code, 'expired-context');
});

// The photo page leaves the description optional, so an empty one is a real
// result to forward — not a malformed one to fail closed on.
test('forwards an insertion whose description is empty', async () => {
    const h = harness();
    await h.routes.handlers.PHOTO_EDITOR_OPEN({
        mode: 'edit',
        identity: { cid: 22, pid: 33 },
    }, peakSender);
    assert.deepEqual(await h.routes.handlers.PHOTO_INSERT_COMMIT({
        returnToken: 'return-token',
        localPhotoId: 'photo-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        alt: '   ',
    }, photoSender), { ok: true, identity: { cid: 22, aid: null, pid: 33 } });
    assert.deepEqual(h.sent, [{
        tabId: 41,
        message: {
            type: 'PHOTO_INSERT_RESULT',
            returnToken: 'return-token',
            localPhotoId: 'photo-1',
            url: 'https://i.ibb.co/a/topo.jpg',
            alt: '',
        },
        options: { frameId: 0 },
    }]);
});

test('fails closed for wrong editor tab, invalid public URL, and expired contexts', async () => {
    const h = harness();
    await h.routes.handlers.PHOTO_EDITOR_OPEN({
        mode: 'edit',
        identity: { cid: 22, pid: 33 },
    }, peakSender);
    const base = {
        returnToken: 'return-token',
        localPhotoId: 'photo-1',
        url: 'http://i.ibb.co/a/topo.jpg',
        alt: 'Topo',
    };
    assert.equal((await h.routes.handlers.PHOTO_INSERT_COMMIT(base, photoSender)).error.code,
        'invalid-result');
    h.advance(PhotoRoutes.RETURN_TTL_MS + 1);
    assert.equal((await h.routes.handlers.PHOTO_INSERT_COMMIT({
        ...base,
        url: 'https://i.ibb.co/a/topo.jpg',
    }, photoSender)).error.code, 'expired-context');
    assert.equal(h.sent.length, 0);
});
