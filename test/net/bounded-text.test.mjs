// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assertBoundedStructure,
    readBoundedBlobText,
    readBoundedResponseText,
} from '../../src/net/bounded-text.js';

const response = (chunks, headers = {}) => ({
    headers: new Headers(headers),
    body: new ReadableStream({
        start(controller) {
            chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk)));
            controller.close();
        },
    }),
});

test('bounded response text accepts the exact byte and character limits', async () => {
    const result = await readBoundedResponseText(response(['1234', '5678'], { 'content-length': '8' }), {
        maxBytes: 8,
        maxChars: 8,
    });
    assert.equal(result, '12345678');
});

test('bounded response text rejects declared, streamed, and decoded limit plus one', async () => {
    let cancelled = false;
    const declared = {
        headers: new Headers({ 'content-length': '9' }),
        body: new ReadableStream({ cancel() { cancelled = true; } }),
    };
    await assert.rejects(readBoundedResponseText(declared, {
        maxBytes: 8,
    }), error => error?.code === 'response-too-large');
    assert.equal(cancelled, true, 'a rejected declared body releases its stream');

    await assert.rejects(readBoundedResponseText(response(['1234', '56789']), {
        maxBytes: 8,
    }), error => error?.code === 'response-too-large');

    await assert.rejects(readBoundedResponseText(response(['123456789'], { 'content-length': '2' }), {
        maxBytes: 8,
    }), error => error?.code === 'response-too-large',
    'a compressed or dishonest Content-Length cannot hide the expanded stream');

    await assert.rejects(readBoundedResponseText(response(['123456789']), {
        maxBytes: 20,
        maxChars: 8,
    }), error => error?.code === 'response-too-large');
});

test('bounded blob text preflights size and validates fallback text', async () => {
    let read = false;
    await assert.rejects(readBoundedBlobText({
        size: 9,
        text: async () => { read = true; return '123456789'; },
    }, { maxBytes: 8 }), error => error?.code === 'response-too-large');
    assert.equal(read, false, 'an oversized local file is rejected before it is read');

    await assert.rejects(readBoundedBlobText({
        size: 1,
        text: async () => '123456789',
    }, { maxBytes: 8 }), error => error?.code === 'response-too-large',
    'fallback readers still validate the decoded result');
});

test('caller cancellation stops a streaming body immediately', async () => {
    let cancelled = false;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
        },
        cancel() { cancelled = true; },
    });
    const controller = new AbortController();
    const reading = readBoundedResponseText({ headers: new Headers(), body }, {
        maxBytes: 100,
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(reading, error => error?.name === 'AbortError');
    assert.equal(cancelled, true);
});

test('parsed structure budgets bound depth, breadth, nodes, and strings', () => {
    const limits = {
        maxDepth: 2,
        maxNodes: 6,
        maxArrayItems: 2,
        maxObjectKeys: 2,
        maxStringChars: 4,
    };
    assert.deepEqual(assertBoundedStructure({ one: ['1234', 2] }, limits), { one: ['1234', 2] });
    for (const value of [
        { one: { two: { three: true } } },
        { one: [1, 2, 3] },
        { one: 1, two: 2, three: 3 },
        { one: '12345' },
        [1, 2, { three: 3 }],
    ]) {
        assert.throws(() => assertBoundedStructure(value, limits),
            error => error?.code === 'response-too-large');
    }
});
