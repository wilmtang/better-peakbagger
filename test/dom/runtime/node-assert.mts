/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The subset of `node:assert/strict` that in-page browser tests use, with
// Node's strict semantics: `equal` is Object.is, and `deepEqual` compares
// prototypes, own enumerable string and symbol keys, and the internal state
// of dates, regular expressions, boxed primitives, maps, sets, typed arrays
// and errors. As in Node, objects from another realm (a fixture window) have
// different prototypes from the page's, so copy them across before comparing.

export class AssertionError extends Error {
    readonly code = 'ERR_ASSERTION';
    readonly actual: unknown;
    readonly expected: unknown;
    readonly operator: string;
    readonly generatedMessage: boolean;
    constructor({ message, actual, expected, operator }: { message?: string | Error; actual?: unknown; expected?: unknown; operator: string }) {
        const generated = message === undefined;
        super(generated ? `${operator} failed:\n  actual:   ${inspect(actual)}\n  expected: ${inspect(expected)}` : String(message));
        this.name = 'AssertionError';
        this.actual = actual;
        this.expected = expected;
        this.operator = operator;
        this.generatedMessage = generated;
    }
}

const tag = (value: unknown) => Object.prototype.toString.call(value);

export function inspect(value: unknown, depth = 0, seen = new Set<unknown>()): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol' || typeof value === 'function') return String(value);
    if (value === null || typeof value !== 'object') return Object.is(value, -0) ? '-0' : String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth > 4) return tag(value);
    seen.add(value);
    try {
        if (value instanceof Object && 'nodeType' in value && 'nodeName' in value) return `<${String(value.nodeName).toLowerCase()}>`;
        const kind = tag(value);
        if (kind === '[object Date]') return `Date(${(value as Date).toISOString?.() ?? 'invalid'})`;
        if (kind === '[object RegExp]' || kind === '[object Error]') return String(value);
        if (Array.isArray(value)) return `[${value.map(item => inspect(item, depth + 1, seen)).join(', ')}]`;
        if (kind === '[object Map]') return `Map(${[...(value as Map<unknown, unknown>)].map(([key, item]) => `${inspect(key, depth + 1, seen)} => ${inspect(item, depth + 1, seen)}`).join(', ')})`;
        if (kind === '[object Set]') return `Set(${[...(value as Set<unknown>)].map(item => inspect(item, depth + 1, seen)).join(', ')})`;
        const entries = Reflect.ownKeys(value).filter(key => Object.prototype.propertyIsEnumerable.call(value, key))
            .map(key => `${String(key)}: ${inspect((value as Record<PropertyKey, unknown>)[key], depth + 1, seen)}`);
        return `{ ${entries.join(', ')} }`;
    } finally { seen.delete(value); }
}

const ownEnumerableKeys = (value: object) => Reflect.ownKeys(value)
    .filter(key => Object.prototype.propertyIsEnumerable.call(value, key));

type Memo = Map<object, Set<object>>;

// Values whose state is internal and not comparable by property walk. Node
// compares these by identity; matching that keeps distinct ones unequal.
const IDENTITY_ONLY = new Set(['[object WeakMap]', '[object WeakSet]', '[object WeakRef]', '[object Promise]']);

// A pair is recorded while it is being compared, so cycles terminate, and
// removed again if the comparison fails, so a failed trial (for example a
// candidate Set member) cannot later count as an established equality.
function deepStrict(actual: unknown, expected: unknown, memo: Memo): boolean {
    if (Object.is(actual, expected)) return true;
    if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) {
        return false;
    }
    const seen = memo.get(actual);
    if (seen?.has(expected)) return true;
    if (seen) seen.add(expected); else memo.set(actual, new Set([expected]));
    const same = compareObjects(actual, expected, memo);
    if (!same) memo.get(actual)?.delete(expected);
    return same;
}

// Finds a distinct, still unused right-hand member deep-equal to `value`.
function takeMatch<T>(candidates: T[], used: Set<number>, matches: (candidate: T) => boolean): boolean {
    for (const [index, candidate] of candidates.entries()) {
        if (used.has(index)) continue;
        if (matches(candidate)) { used.add(index); return true; }
    }
    return false;
}

function compareObjects(actual: object, expected: object, memo: Memo): boolean {
    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
    const kind = tag(actual);
    if (kind !== tag(expected)) return false;
    if (IDENTITY_ONLY.has(kind)) return false;

    if (Array.isArray(actual)) {
        if (actual.length !== (expected as unknown[]).length) return false;
    } else if (kind === '[object Date]') {
        if (!Object.is((actual as Date).getTime(), (expected as Date).getTime())) return false;
    } else if (kind === '[object RegExp]') {
        const left = actual as RegExp, right = expected as RegExp;
        if (left.source !== right.source || left.flags !== right.flags || left.lastIndex !== right.lastIndex) return false;
    } else if (kind === '[object URL]' || actual instanceof URL) {
        if ((actual as URL).href !== (expected as URL).href) return false;
    } else if (actual instanceof Error || kind === '[object Error]') {
        const left = actual as Error & { errors?: unknown }, right = expected as Error & { errors?: unknown };
        if (left.message !== right.message || left.name !== right.name) return false;
        if (Object.hasOwn(left, 'cause') !== Object.hasOwn(right, 'cause') || !deepStrict(left.cause, right.cause, memo)) return false;
        if (Object.hasOwn(left, 'errors') !== Object.hasOwn(right, 'errors') || !deepStrict(left.errors, right.errors, memo)) return false;
    } else if (['[object Number]', '[object String]', '[object Boolean]', '[object BigInt]', '[object Symbol]'].includes(kind)) {
        if (!Object.is((actual as { valueOf(): unknown }).valueOf(), (expected as { valueOf(): unknown }).valueOf())) return false;
    } else if (ArrayBuffer.isView(actual)) {
        const left = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
        const view = expected as ArrayBufferView;
        const right = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (left.length !== right.length || left.some((byte, index) => byte !== right[index])) return false;
    } else if (kind === '[object ArrayBuffer]') {
        const left = new Uint8Array(actual as ArrayBuffer), right = new Uint8Array(expected as ArrayBuffer);
        if (left.length !== right.length || left.some((byte, index) => byte !== right[index])) return false;
    } else if (kind === '[object Map]') {
        const left = actual as Map<unknown, unknown>, right = expected as Map<unknown, unknown>;
        if (left.size !== right.size) return false;
        const loose: [unknown, unknown][] = [];
        for (const [key, value] of left) {
            if (right.has(key)) { if (!deepStrict(value, right.get(key), memo)) return false; continue; }
            if (typeof key !== 'object' || key === null) return false;
            loose.push([key, value]);
        }
        const candidates = [...right].filter(([key]) => !left.has(key)), used = new Set<number>();
        for (const [key, value] of loose) {
            if (!takeMatch(candidates, used, ([otherKey, otherValue]) =>
                deepStrict(key, otherKey, memo) && deepStrict(value, otherValue, memo))) return false;
        }
    } else if (kind === '[object Set]') {
        const left = actual as Set<unknown>, right = expected as Set<unknown>;
        if (left.size !== right.size) return false;
        const loose: unknown[] = [];
        for (const value of left) {
            if (right.has(value)) continue;
            if (typeof value !== 'object' || value === null) return false;
            loose.push(value);
        }
        const candidates = [...right].filter(value => !left.has(value)), used = new Set<number>();
        for (const value of loose) if (!takeMatch(candidates, used, other => deepStrict(value, other, memo))) return false;
    }
    const leftKeys = ownEnumerableKeys(actual), rightKeys = ownEnumerableKeys(expected);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.propertyIsEnumerable.call(expected, key)) return false;
        if (!deepStrict((actual as Record<PropertyKey, unknown>)[key], (expected as Record<PropertyKey, unknown>)[key], memo)) return false;
    }
    return true;
}

export const isDeepStrictEqual = (actual: unknown, expected: unknown) => deepStrict(actual, expected, new Map());

const fail = (options: ConstructorParameters<typeof AssertionError>[0]): never => {
    if (options.message instanceof Error) throw options.message;
    throw new AssertionError(options);
};

export function ok(value: unknown, message?: string | Error): asserts value {
    if (!value) fail({ message: message ?? `The expression evaluated to a falsy value: ${inspect(value)}`, actual: value, expected: true, operator: '==' });
}

export function equal<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
    if (!Object.is(actual, expected)) fail({ message, actual, expected, operator: 'strictEqual' });
}

export function notEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (Object.is(actual, expected)) fail({ message, actual, expected, operator: 'notStrictEqual' });
}

export function deepEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
    if (!isDeepStrictEqual(actual, expected)) fail({ message, actual, expected, operator: 'deepStrictEqual' });
}

export function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    if (isDeepStrictEqual(actual, expected)) fail({ message, actual, expected, operator: 'notDeepStrictEqual' });
}

export function match(actual: string, expected: RegExp, message?: string | Error): void {
    if (typeof actual !== 'string') fail({ message: message ?? `The "string" argument must be of type string. Received ${inspect(actual)}`, actual, expected, operator: 'match' });
    if (expected.exec(actual) === null) fail({ message, actual, expected, operator: 'match' });
}

export function doesNotMatch(actual: string, expected: RegExp, message?: string | Error): void {
    if (typeof actual !== 'string') fail({ message: message ?? `The "string" argument must be of type string. Received ${inspect(actual)}`, actual, expected, operator: 'doesNotMatch' });
    if (expected.exec(actual) !== null) fail({ message, actual, expected, operator: 'doesNotMatch' });
}

type ErrorMatcher = RegExp | (new (...args: never[]) => unknown) | ((error: unknown) => boolean) | Record<string, unknown> | Error;

function checkError(error: unknown, expected: ErrorMatcher | undefined, message: string | Error | undefined, operator: string) {
    if (expected === undefined) return;
    if (expected instanceof RegExp) {
        if (expected.exec(String(error)) === null) fail({ message: message ?? `The error did not match ${expected}: ${inspect(String(error))}`, actual: error, expected, operator });
        return;
    }
    if (typeof expected === 'function') {
        if (expected.prototype !== undefined && error instanceof (expected as new () => unknown)) return;
        if (Error.isPrototypeOf(expected) || expected === Error) {
            fail({ message: message ?? `The error is expected to be an instance of "${expected.name}". Received ${inspect(error)}`, actual: error, expected, operator });
        }
        if ((expected as (value: unknown) => unknown).call({}, error) === true) return;
        fail({ message: message ?? 'The validation function did not return true', actual: error, expected, operator });
    }
    if (typeof error !== 'object' || error === null) fail({ message, actual: error, expected, operator });
    // Like Node: an Error instance also matches on its name and message, and
    // every listed key must be present on the thrown value.
    const keys = Object.keys(expected);
    if (expected instanceof Error) keys.push('name', 'message');
    for (const key of keys) {
        const want = (expected as Record<string, unknown>)[key], have = (error as Record<string, unknown>)[key];
        if (typeof have === 'string' && want instanceof RegExp && want.exec(have) !== null) continue;
        if (!(key in (error as object)) || !isDeepStrictEqual(have, want)) {
            fail({ message: message ?? `${key}: expected ${inspect(want)}, received ${inspect(have)}`, actual: error, expected, operator });
        }
    }
}

const splitMatcher = (expected?: ErrorMatcher | string, message?: string | Error) =>
    typeof expected === 'string' ? { matcher: undefined, note: expected } : { matcher: expected, note: message };

export function throws(fn: () => unknown, expected?: ErrorMatcher | string, message?: string | Error): void {
    const { matcher, note } = splitMatcher(expected, message);
    try { fn(); } catch (error) { checkError(error, matcher, note, 'throws'); return; }
    fail({ message: note ?? 'Missing expected exception.', operator: 'throws' });
}

export function doesNotThrow(fn: () => unknown, message?: string | Error): void {
    try { fn(); } catch (error) { fail({ message: message ?? `Got unwanted exception: ${inspect(error)}`, actual: error, operator: 'doesNotThrow' }); }
}

export async function rejects(work: Promise<unknown> | (() => Promise<unknown>), expected?: ErrorMatcher | string, message?: string | Error): Promise<void> {
    const { matcher, note } = splitMatcher(expected, message);
    try { await (typeof work === 'function' ? work() : work); } catch (error) { checkError(error, matcher, note, 'rejects'); return; }
    fail({ message: note ?? 'Missing expected rejection.', operator: 'rejects' });
}

export async function doesNotReject(work: Promise<unknown> | (() => Promise<unknown>), message?: string | Error): Promise<void> {
    try { await (typeof work === 'function' ? work() : work); } catch (error) { fail({ message: message ?? `Got unwanted rejection: ${inspect(error)}`, actual: error, operator: 'doesNotReject' }); }
}

function failAssertion(message?: string | Error): never {
    return fail({ message: message ?? 'Failed', operator: 'fail' });
}

export { equal as strictEqual, notEqual as notStrictEqual, deepEqual as deepStrictEqual, notDeepEqual as notDeepStrictEqual, failAssertion as fail };

const assert = Object.assign((value: unknown, message?: string | Error) => ok(value, message), {
    AssertionError, ok, equal, notEqual, deepEqual, notDeepEqual, match, doesNotMatch, throws, doesNotThrow, rejects, doesNotReject,
    fail: failAssertion, strictEqual: equal, notStrictEqual: notEqual, deepStrictEqual: deepEqual, notDeepStrictEqual: notDeepEqual,
    strict: undefined as unknown,
});
assert.strict = assert;
export default assert;
