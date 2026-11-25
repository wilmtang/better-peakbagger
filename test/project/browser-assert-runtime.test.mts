// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-page browser tests use test/dom/runtime/node-assert.mts in place of
// node:assert/strict. Each case here must pass or fail exactly as Node's own
// assertion does: a runtime that passes where Node fails would let a broken
// browser test go green.

import nodeAssert from 'node:assert/strict';
import test from 'node:test';
import runtimeAssert from '../dom/runtime/node-assert.mts';

type Assert = typeof nodeAssert;
// Assertion functions need declared types at their call sites.
type Run = (assert: Assert) => unknown;
const shared = { k: 1 }, sharedOther = { k: 2 }, lookalike = { k: 1 }, other = { k: 2 };

const CASES: [string, Run][] = [
    ['strict equal', assert => assert.equal(1, 1)],
    ['loose equal', assert => assert.equal(1, '1' as unknown as number)],
    ['NaN', assert => assert.equal(Number.NaN, Number.NaN)],
    ['signed zero', assert => assert.equal(0, -0)],
    ['nested deep equality', assert => assert.deepEqual({ a: [1, { b: new Date(5) }] }, { a: [1, { b: new Date(5) }] })],
    ['undefined property', assert => assert.deepEqual({ a: 1 }, { a: 1, b: undefined })],
    ['array vs array-like', assert => assert.deepEqual([1], { 0: 1, length: 1 } as unknown as number[])],
    ['null prototype', assert => assert.deepEqual(Object.create(null), {})],
    ['deep signed zero', assert => assert.deepEqual([-0], [0])],
    ['invalid dates', assert => assert.deepEqual(new Date(Number.NaN), new Date(Number.NaN))],
    ['regexp flags', assert => assert.deepEqual(/a/g, /a/i)],
    ['urls', assert => assert.deepEqual(new URL('https://a/x'), new URL('https://a/y'))],
    ['equal urls', assert => assert.deepEqual(new URL('https://a/x'), new URL('https://a/x'))],
    ['weak maps', assert => assert.deepEqual(new WeakMap(), new WeakMap())],
    ['boxed numbers', assert => assert.deepEqual(Object(1), Object(2))],
    ['symbol keys', assert => assert.deepEqual({ [Symbol.for('x')]: 1 }, { [Symbol.for('x')]: 2 })],
    ['sparse arrays', assert => assert.deepEqual([, 1], [undefined, 1])],
    ['getter vs value', assert => assert.deepEqual(Object.defineProperty({}, 'x', { get: () => 1, enumerable: true }), { x: 1 })],
    ['set duplicate members', assert => assert.deepEqual(new Set([{ a: 1 }, { a: 1 }]), new Set([{ a: 1 }, { b: 2 }]))],
    ['set equal members', assert => assert.deepEqual(new Set([{ a: 1 }, { b: 2 }]), new Set([{ b: 2 }, { a: 1 }]))],
    ['map duplicate keys', assert => assert.deepEqual(new Map([[{ a: 1 }, 1], [{ a: 1 }, 1]]), new Map([[{ a: 1 }, 1], [{ b: 2 }, 1]]))],
    ['failed trial is not cached', assert => assert.deepEqual({ s: new Set([shared, other]), x: shared }, { s: new Set([sharedOther, lookalike]), x: sharedOther })],
    ['error cause', assert => assert.deepEqual(new Error('m', { cause: 1 }), new Error('m', { cause: 2 }))],
    ['aggregate errors', assert => assert.deepEqual(new AggregateError([1], 'm'), new AggregateError([2], 'm'))],
    ['cycles', (assert: Assert) => {
        const left: Record<string, unknown> = {}, right: Record<string, unknown> = {};
        left.self = left; right.self = right;
        assert.deepEqual(left, right);
    }],
    ['match with a global regexp twice', assert => { const pattern = /a/g; assert.match('a', pattern); assert.match('a', pattern); }],
    ['match a non-string', assert => assert.match(1 as unknown as string, /1/)],
    ['throws class', assert => assert.throws(() => { throw new TypeError('x'); }, TypeError)],
    ['throws wrong class', assert => assert.throws(() => { throw new TypeError('x'); }, RangeError)],
    ['throws regexp', assert => assert.throws(() => { throw new TypeError('bad value'); }, /TypeError: bad value/)],
    ['throws error instance', assert => assert.throws(() => { throw new Error('other'); }, new Error('wanted'))],
    ['throws matching error instance', assert => assert.throws(() => { throw new Error('wanted'); }, new Error('wanted'))],
    ['throws object key', assert => assert.throws(() => { throw Object.assign(new Error('x'), { code: 'X' }); }, { code: 'X' })],
    ['throws object with a missing key', assert => assert.throws(() => { throw { code: 'X' }; }, { code: 'X', extra: undefined })],
    ['throws object regexp value', assert => assert.throws(() => { throw new Error('bad value'); }, { message: /bad/ })],
    ['validation function returns truthy', assert => assert.throws(() => { throw new Error('x'); }, (() => 1) as unknown as () => boolean)],
    ['nothing thrown', assert => assert.throws(() => {})],
    ['ok falsy', assert => assert.ok(0)],
];

const outcome = (assert: Assert, run: (assert: Assert) => unknown) => {
    try { run(assert); return 'pass'; } catch { return 'fail'; }
};

test('the browser assertion runtime passes and fails exactly where node:assert/strict does', () => {
    const differences = CASES.filter(([, run]) => outcome(nodeAssert, run) !== outcome(runtimeAssert as unknown as Assert, run))
        .map(([name]) => name);
    nodeAssert.deepEqual(differences, []);
});

test('the browser assertion runtime rejects as node:assert/strict does', async () => {
    const asyncCases: [string, (assert: Assert) => Promise<unknown>][] = [
        ['rejects error instance', assert => assert.rejects(Promise.reject(new Error('other')), new Error('wanted'))],
        ['rejects matching object', assert => assert.rejects(Promise.reject(Object.assign(new Error('x'), { code: 'E' })), { code: 'E' })],
        ['rejects nothing rejected', assert => assert.rejects(Promise.resolve())],
        ['rejects function', assert => assert.rejects(async () => { throw new Error('x'); }, /x/)],
    ];
    const settle = async (assert: Assert, run: (assert: Assert) => Promise<unknown>) => {
        try { await run(assert); return 'pass'; } catch { return 'fail'; }
    };
    const differences: string[] = [];
    for (const [name, run] of asyncCases) {
        if (await settle(nodeAssert, run) !== await settle(runtimeAssert as unknown as Assert, run)) differences.push(name);
    }
    nodeAssert.deepEqual(differences, []);
});
