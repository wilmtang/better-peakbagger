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

const response = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
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

// The size ceiling belongs to the ImgBB account and differs by plan, so a local
// byte limit would refuse uploads a paid key accepts. The upload is attempted
// and ImgBB's own rejection — which states the account's real maximum — becomes
// the message, with one remedy sentence appended.
test('a large image is offered to ImgBB, and its size rejection is what the user reads', async () => {
    let uploaded = 0;
    const blob = new Blob([new Uint8Array(64 * 1024 * 1024)], { type: 'image/png' });
    await assert.rejects(Client.upload({
        fetch: async () => {
            uploaded += 1;
            return response(400, {
                status_code: 400,
                error: { message: 'File too big - max 32 MB', code: 313 },
                status_txt: 'Bad Request',
            });
        },
        key: KEY,
        blob,
    }), error => error.code === 'too-large'
        && error.message === 'ImgBB: File too big - max 32 MB. Use a smaller photo, or crop it before drawing the topo.');
    assert.equal(uploaded, 1, 'the provider, not a hardcoded constant, decides the ceiling');
});

// A paid account reports a different ceiling; the message has to follow it
// rather than repeat a number this extension chose.
test('the message follows whatever maximum the account actually reports', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => response(400, { error: { message: 'File too big - max 64 MB', code: 313 } }),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => /max 64 MB/.test(error.message) && !/32 MB/.test(error.message));
});

test('an unusable key and an undecodable file each say what to do next', async () => {
    const reject = (message, code) => async () => response(400, { error: { message, code } });
    await assert.rejects(Client.upload({
        fetch: reject('Invalid API v1 key.', 100),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'not-configured'
        && /Invalid API v1 key/.test(error.message)
        && /Settings → Activity creation/.test(error.message));
    await assert.rejects(Client.upload({
        fetch: reject('Unsupported or unrecognized file format', 415),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'invalid-image' && /JPEG or PNG/.test(error.message));
});

// An unrecognized code must still surface ImgBB's own words rather than a
// generic "the upload failed".
test('an unmapped provider error still reads as ImgBB said it', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => response(429, { error: { message: 'Rate limit reached', code: 999 } }),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'rate-limit'
        && error.message === 'Rate limit reached'
        // Refused before the image pipeline: nothing was stored, so a retry is
        // safe and the library must not mark the photo's outcome unknown.
        && error.ambiguous === false);
});

test('a rate limit with no wording of its own still says what to do', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => response(429, '<html>429 Too Many Requests</html>'),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'rate-limit'
        && /rate-limiting uploads/.test(error.message)
        && error.ambiguous === false);
});

test('an ImgBB outage reads as an outage, not as an unreadable reply', async () => {
    // The regression: the body was parsed before the status was consulted, so
    // an edge error page — the normal shape of an outage — surfaced as
    // "ImgBB returned a response Better Peakbagger could not read", a parser
    // complaint standing in for "ImgBB is down".
    for (const status of [500, 502, 503]) {
        await assert.rejects(Client.upload({
            fetch: async () => response(status, '<html><body>Bad gateway</body></html>'),
            key: KEY,
            blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
        }), error => error.code === 'unavailable'
            && error.message.includes(`HTTP ${status}`)
            && /try again in a few minutes/i.test(error.message)
            // Nothing in front of ImgBB can say whether the backend stored it.
            && error.ambiguous === true);
    }
});

test('a 5xx carrying ImgBB’s own envelope stays a definite refusal', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => response(500, { error: { message: 'Image type not supported', code: 415 } }),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'invalid-image' && error.ambiguous === false);
});

test('a stalled upload fails on its deadline and keeps the outcome unknown', async () => {
    const aborts = [];
    await assert.rejects(Client.upload({
        fetch: async (_url, init) => {
            init.signal?.addEventListener('abort', () => aborts.push(true));
            return new Promise(() => {});
        },
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
        timeoutMs: 10,
    }), error => error.code === 'timeout'
        // The bytes were already on the wire; ImgBB may be holding the image.
        && error.ambiguous === true
        && /check your imgbb account/i.test(error.message));
    assert.equal(aborts.length, 1, 'the deadline must release the socket too');
});

test('a reply that stops mid-body keeps the outcome unknown', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => ({ ok: true, status: 200, text: async () => { throw new TypeError('stream closed'); } }),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.ambiguous === true && /check your imgbb account/i.test(error.message));
});

test('oversized ImgBB response bytes and structure keep the upload outcome unknown', async () => {
    let read = false;
    await assert.rejects(Client.upload({
        fetch: async () => ({
            ...response(200, successPayload(), {
                'content-length': String(Client.RESPONSE_MAX_BYTES + 1),
            }),
            body: { cancel: async () => {} },
            text: async () => { read = true; return '{}'; },
        }),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'response-too-large'
        && error.ambiguous === true
        && /check your imgbb account/i.test(error.message));
    assert.equal(read, false);

    const nested = {};
    let cursor = nested;
    for (let depth = 0; depth <= Client.RESPONSE_STRUCTURE_LIMITS.maxDepth; depth += 1) {
        cursor.child = {};
        cursor = cursor.child;
    }
    await assert.rejects(Client.upload({
        fetch: async () => response(200, nested),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'response-too-large' && error.ambiguous === true);
});

// The dangerous shape: ImgBB said yes, and the only thing lost is the URL of
// an image it is now hosting. Reporting that as a clean failure would reset the
// upload and let the user re-upload the same photo without ever being told.
test('an unreadable success is ambiguous, never a clean failure', async () => {
    await assert.rejects(Client.upload({
        fetch: async () => response(200, '<html>gateway rewrote the body</html>'),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
    }), error => error.code === 'invalid-response'
        && error.ambiguous === true
        && /check your imgbb account/i.test(error.message));
});

test('a caller’s own cancellation tears the upload down', async () => {
    const controller = new AbortController();
    const aborted = Client.upload({
        fetch: async (_url, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
        key: KEY,
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(aborted, error => error.ambiguous === true);
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
