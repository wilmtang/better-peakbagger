// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { imgbbClient as Client } from '../../src/photos/imgbb-client.js';

const KEY = 'secret-imgbb-key';
const successPayload = (overrides = {}) => ({
    data: {
        id: 'abc123',
        title: 'topo',
        url_viewer: 'https://ibb.co/abc123',
        url: 'https://i.ibb.co/a/topo.jpg',
        display_url: 'https://i.ibb.co/a/topo.jpg',
        width: '1600',
        height: '1200',
        size: 123456,
        time: 1785213600,
        expiration: 0,
        image: { url: 'https://i.ibb.co/a/topo.jpg' },
        thumb: { url: 'https://i.ibb.co/a/topo-thumb.jpg' },
        medium: { url: 'https://i.ibb.co/a/topo-medium.jpg' },
        delete_url: 'https://ibb.co/delete/delete-capability',
        ...overrides,
    },
    success: true,
    status: 200,
});

const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
});

test('uploads one multipart Blob and returns only validated provider metadata', async () => {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init });
        return response(200, successPayload());
    };
    const result = await Client.upload({
        fetch,
        key: KEY,
        blob: new Blob(['edited-photo'], { type: 'image/jpeg' }),
        name: 'North Face.jpg',
    });

    assert.equal(calls.length, 1);
    const requestUrl = new URL(calls[0].url);
    assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, Client.API_ROOT);
    assert.equal(requestUrl.searchParams.get('key'), KEY);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
    assert.equal(calls[0].init.body.get('name'), 'North Face');
    assert.equal(calls[0].init.body.get('image').type, 'image/jpeg');
    assert.deepEqual(result, {
        remote: {
            providerId: 'abc123',
            url: 'https://i.ibb.co/a/topo.jpg',
            displayUrl: 'https://i.ibb.co/a/topo.jpg',
            viewerUrl: 'https://ibb.co/abc123',
            thumbnailUrl: 'https://i.ibb.co/a/topo-thumb.jpg',
            mediumUrl: 'https://i.ibb.co/a/topo-medium.jpg',
            uploadedAt: '2026-07-28T04:40:00.000Z',
            expiresAt: null,
        },
        deleteUrl: 'https://ibb.co/delete/delete-capability',
        providerImage: { width: 1600, height: 1200, bytes: 123456 },
    });
});

test('supports a missing medium image and provider expiration timestamp', () => {
    const result = Client.cleanUploadResponse(successPayload({
        medium: null,
        expiration: 1785217200,
    }), 200);
    assert.equal(result.remote.mediumUrl, null);
    assert.equal(result.remote.expiresAt, '2026-07-28T05:40:00.000Z');
});

test('rejects files above exactly the documented provider maximum without fetching', async () => {
    let called = false;
    const blob = new Blob([new Uint8Array(Client.MAX_UPLOAD_BYTES + 1)], { type: 'image/png' });
    await assert.rejects(Client.upload({
        fetch: async () => { called = true; },
        key: KEY,
        blob,
    }), error => error.code === 'too-large' && /32 MB/.test(error.message));
    assert.equal(called, false);
});

test('treats a network end after request start as ambiguous and does not leak the key', async () => {
    let calls = 0;
    let caught;
    try {
        await Client.upload({
            fetch: async () => { calls += 1; throw new TypeError(`offline ${KEY}`); },
            key: KEY,
            blob: new Blob(['image'], { type: 'image/jpeg' }),
        });
    } catch (error) {
        caught = error;
    }
    assert.equal(calls, 1, 'the client must not retry an ambiguous POST');
    assert.equal(caught.code, 'ambiguous');
    assert.equal(caught.ambiguous, true);
    assert.doesNotMatch(caught.message, new RegExp(KEY));
    assert.doesNotMatch(JSON.stringify(Client.publicError(caught)), new RegExp(KEY));
});

test('maps an API rejection without retaining a request URL or key', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => response(400, {
            error: { message: 'Invalid API v1 key.' },
            status: 400,
        }),
        key: KEY,
        blob: new Blob(['image'], { type: 'image/jpeg' }),
    }), error => {
        assert.equal(error.code, 'rejected');
        assert.equal(error.status, 400);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(KEY));
        return true;
    });
});

test('fails closed when a nominal success omits a direct or deletion URL', () => {
    assert.throws(() => Client.cleanUploadResponse(successPayload({ url: null }), 200),
        error => error.code === 'invalid-response' && error.ambiguous);
    assert.throws(() => Client.cleanUploadResponse(successPayload({ delete_url: null }), 200),
        error => error.code === 'invalid-response' && error.ambiguous);
});

test('rejects non-HTTPS response URLs', () => {
    assert.throws(() => Client.cleanUploadResponse(successPayload({
        thumb: { url: 'http://i.ibb.co/a/thumb.jpg' },
    }), 200), error => error.code === 'invalid-response');
});
