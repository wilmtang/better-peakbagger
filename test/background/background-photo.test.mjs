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

const harness = ({
    sendResult = null,
    mutateFailure = null,
    tabCreateFailure = null,
    tabRemoveFailure = null,
    buildOpenResponse = tabId => ({ ok: true, tabId }),
    consumeActivation = () => true,
} = {}) => {
    const local = makeStorageArea();
    const session = makeStorageArea();
    const sent = [];
    const created = [];
    const removed = [];
    const openTabs = new Set();
    const cleanupLogs = [];
    let createAttempts = 0;
    let removeAttempts = 0;
    let clock = Date.parse('2026-07-27T18:00:00.000Z');
    const ext = {
        runtime: { getURL: path => `chrome-extension://test-extension/${path}` },
        permissions: { contains: async value => value.origins[0] === 'https://api.imgbb.com/*' },
        tabs: {
            create: async ({ url }) => {
                createAttempts += 1;
                if (tabCreateFailure) await tabCreateFailure({ attempt: createAttempts, url });
                const id = 90 + createAttempts;
                created.push(url);
                openTabs.add(id);
                return { id };
            },
            remove: async tabId => {
                removeAttempts += 1;
                if (tabRemoveFailure) await tabRemoveFailure({ attempt: removeAttempts, tabId });
                removed.push(tabId);
                openTabs.delete(tabId);
            },
            sendMessage: async (tabId, message, options) => {
                sent.push({ tabId, message, options });
                return sendResult ? sendResult({ tabId, message, options, attempt: sent.length }) : { ok: true };
            },
        },
    };
    let queue = Promise.resolve();
    let mutationAttempts = 0;
    const readMap = async key => (await session.get(key))[key] || {};
    const mutateMap = (key, mutate) => {
        const result = queue.then(async () => {
            mutationAttempts += 1;
            const attempt = mutationAttempts;
            if (mutateFailure) await mutateFailure({ attempt, stage: 'before', key });
            const value = await readMap(key);
            const answer = await mutate(value);
            await session.set({ [key]: value });
            if (mutateFailure) await mutateFailure({ attempt, stage: 'after', key });
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
        trustedActions: { consumeCapability: consumeActivation },
        buildOpenResponse,
        logCleanupFailure: message => cleanupLogs.push(message),
    });
    return {
        routes,
        keyStore,
        local,
        session,
        sent,
        created,
        removed,
        openTabs,
        cleanupLogs,
        mutationAttempts: () => mutationAttempts,
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
const openMessage = {
    mode: 'edit',
    identity: { cid: 22, aid: null, pid: 33 },
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

test('opening a photo editor requires one matching trusted activation', async () => {
    const consumed = [];
    const h = harness({
        consumeActivation: (message, sender, action) => {
            consumed.push({ message, sender, action });
            return message.activationToken === 'trusted-token'
                && message.generation === 'report-photos-1';
        },
    });
    const rejected = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);
    assert.equal(rejected.error.code, 'activation-required');
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY], undefined);

    const allowed = await h.routes.handlers.PHOTO_EDITOR_OPEN({
        ...openMessage,
        activationToken: 'trusted-token',
        generation: 'report-photos-1',
    }, peakSender);
    assert.equal(allowed.ok, true);
    assert.equal(consumed.at(-1).action, 'photo-editor');
});

for (const stage of ['before', 'after']) {
    test(`context-creation ${stage}-write failure leaves no context or tab and retries`, async () => {
        const h = harness({
            mutateFailure: ({ attempt, stage: current }) => {
                if (attempt === 1 && current === stage) throw new Error('context creation failed');
            },
        });
        const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

        assert.equal(failed.error.code, 'open-failed');
        assert.deepEqual(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY], {});
        assert.deepEqual(h.created, []);
        assert.deepEqual([...h.openTabs], []);

        const retried = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);
        assert.deepEqual(retried, { ok: true, tabId: 91 });
        assert.deepEqual([...h.openTabs], [91]);
        assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].editorTabId, 91);
    });
}

test('tab-creation failure removes its prepared context and retries without a leaked tab', async () => {
    const h = harness({
        tabCreateFailure: ({ attempt }) => {
            if (attempt === 1) throw new Error('tab create failed');
        },
    });
    const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

    assert.equal(failed.error.code, 'open-failed');
    assert.deepEqual(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY], {});
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.removed, []);
    assert.deepEqual([...h.openTabs], []);

    const retried = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);
    assert.deepEqual(retried, { ok: true, tabId: 92 });
    assert.deepEqual([...h.openTabs], [92]);
});

for (const stage of ['before', 'after']) {
    test(`context-bind ${stage}-write failure rolls back both owners and retries`, async () => {
        const h = harness({
            mutateFailure: ({ attempt, stage: current }) => {
                if (attempt === 2 && current === stage) throw new Error('context bind failed');
            },
        });
        const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

        assert.equal(failed.error.code, 'open-failed');
        assert.deepEqual(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY], {});
        assert.deepEqual(h.removed, [91]);
        assert.deepEqual([...h.openTabs], []);

        const retried = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);
        assert.deepEqual(retried, { ok: true, tabId: 92 });
        assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].editorTabId, 92);
        assert.deepEqual([...h.openTabs], [92]);
    });
}

test('response construction failure rolls back its bound context and created tab', async () => {
    let responses = 0;
    const h = harness({
        buildOpenResponse: tabId => {
            responses += 1;
            if (responses === 1) throw new Error('response failed');
            return { ok: true, tabId };
        },
    });
    const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

    assert.equal(failed.error.code, 'open-failed');
    assert.deepEqual(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY], {});
    assert.deepEqual(h.removed, [91]);
    assert.deepEqual([...h.openTabs], []);
    assert.deepEqual(await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender), {
        ok: true, tabId: 92,
    });
});

test('context-cleanup failure cannot suppress tab cleanup and a retry replaces stale context', async () => {
    const h = harness({
        mutateFailure: ({ attempt, stage }) => {
            if (attempt === 2 && stage === 'before') throw new Error('bind failed');
            if (attempt === 3 && stage === 'before') throw new Error('context cleanup failed');
        },
    });
    const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

    assert.equal(failed.error.code, 'open-failed');
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].editorTabId, null);
    assert.deepEqual(h.removed, [91]);
    assert.deepEqual([...h.openTabs], []);
    assert.deepEqual(h.cleanupLogs, [
        'Better Peakbagger: photo editor return context cleanup failed',
    ]);

    const retried = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);
    assert.deepEqual(retried, { ok: true, tabId: 92 });
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].editorTabId, 92);
    assert.deepEqual([...h.openTabs], [92]);
});

test('tab-cleanup failure cannot suppress context cleanup and retry remains usable', async () => {
    const h = harness({
        mutateFailure: ({ attempt, stage }) => {
            if (attempt === 2 && stage === 'before') throw new Error('bind failed');
        },
        tabRemoveFailure: ({ attempt }) => {
            if (attempt === 1) throw new Error('tab cleanup failed');
        },
    });
    const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

    assert.equal(failed.error.code, 'open-failed');
    assert.deepEqual(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY], {});
    assert.deepEqual(h.removed, []);
    assert.deepEqual([...h.openTabs], [91]);
    assert.deepEqual(h.cleanupLogs, [
        'Better Peakbagger: photo editor tab cleanup failed',
    ]);

    const retried = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);
    assert.deepEqual(retried, { ok: true, tabId: 92 });
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].editorTabId, 92);
    assert.deepEqual([...h.openTabs], [91, 92], 'only the browser-owned failed removal remains');
});

test('independent rollback failures are both contained and reported without raw details', async () => {
    const h = harness({
        mutateFailure: ({ attempt, stage }) => {
            if (attempt === 2 && stage === 'before') throw new Error('raw bind secret');
            if (attempt === 3 && stage === 'before') throw new Error('raw context secret');
        },
        tabRemoveFailure: () => { throw new Error('raw tab secret'); },
    });
    const failed = await h.routes.handlers.PHOTO_EDITOR_OPEN(openMessage, peakSender);

    assert.equal(failed.error.code, 'open-failed');
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].editorTabId, null);
    assert.deepEqual([...h.openTabs], [91]);
    assert.deepEqual(h.cleanupLogs, [
        'Better Peakbagger: photo editor return context cleanup failed',
        'Better Peakbagger: photo editor tab cleanup failed',
    ]);
    assert.doesNotMatch(JSON.stringify({ failed, logs: h.cleanupLogs }), /raw .* secret/);
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

test('failed delivery and negative acknowledgement both release the return context', async () => {
    const h = harness({
        sendResult: ({ attempt }) => {
            if (attempt === 1) throw new Error('receiving end disappeared');
            if (attempt === 2) return { ok: false, error: { code: 'editor-unavailable' } };
            return { ok: true };
        },
    });
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

    const first = await h.routes.handlers.PHOTO_INSERT_COMMIT(message, photoSender);
    assert.equal(first.ok, false);
    assert.equal(first.error.code, 'insert-failed');
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].consumed, false);
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].inFlight, false);

    const second = await h.routes.handlers.PHOTO_INSERT_COMMIT(message, photoSender);
    assert.equal(second.ok, false);
    assert.equal(second.error.code, 'insert-failed');
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].consumed, false);
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].inFlight, false);

    assert.deepEqual(await h.routes.handlers.PHOTO_INSERT_COMMIT(message, photoSender), {
        ok: true,
        identity: { cid: 22, aid: null, pid: 33 },
    });
    assert.equal(h.sent.length, 3);
    assert.equal(h.session.values[PhotoRoutes.RETURN_CONTEXTS_KEY]['return-token'].consumed, true);
});

test('forwards only a bounded optional report display width', async () => {
    const sized = harness();
    await sized.routes.handlers.PHOTO_EDITOR_OPEN({
        mode: 'edit',
        identity: { cid: 22, pid: 33 },
    }, peakSender);
    assert.deepEqual(await sized.routes.handlers.PHOTO_INSERT_COMMIT({
        returnToken: 'return-token',
        localPhotoId: 'photo-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        alt: 'North face route',
        displayWidth: 640,
    }, photoSender), {
        ok: true,
        identity: { cid: 22, aid: null, pid: 33 },
    });
    assert.deepEqual(sized.sent[0].message, {
        type: 'PHOTO_INSERT_RESULT',
        returnToken: 'return-token',
        localPhotoId: 'photo-1',
        url: 'https://i.ibb.co/a/topo.jpg',
        alt: 'North face route',
        displayWidth: 640,
    });

    const oversized = harness();
    await oversized.routes.handlers.PHOTO_EDITOR_OPEN({
        mode: 'edit',
        identity: { cid: 22, pid: 33 },
    }, peakSender);
    assert.equal((await oversized.routes.handlers.PHOTO_INSERT_COMMIT({
        returnToken: 'return-token',
        localPhotoId: 'photo-2',
        url: 'https://i.ibb.co/a/topo.jpg',
        alt: 'North face route',
        displayWidth: 4032,
    }, photoSender)).ok, true);
    assert.equal('displayWidth' in oversized.sent[0].message, false,
        'invalid optional sizing must not lose an already-uploaded photo');
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
