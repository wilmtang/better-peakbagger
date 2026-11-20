/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The subset of `node:test` that in-page browser tests use. The DOM tier
// bundles a `*.browser.mts` file with this module standing in for
// `node:test`, then calls `__bpbRunBrowserTests()` in the page. Tests run one
// at a time in registration order, as `node --test` runs a file, and every
// `t.after` and `afterEach` hook runs even when the test fails.

import { fixtureWindows } from './fixture-registry.mts';

type Hook = () => unknown;
type TestFn = (t: TestContext) => unknown;
interface TestOptions { skip?: boolean | string; todo?: boolean | string; timeout?: number }

interface Registered {
    name: string;
    fn?: TestFn;
    options: TestOptions;
}

export interface BrowserTestResult {
    name: string;
    result: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    error?: string;
}

const registered: Registered[] = [];
const afterEachHooks: Hook[] = [];
const beforeEachHooks: Hook[] = [];
const afterHooks: Hook[] = [];
const beforeHooks: Hook[] = [];

const DEFAULT_TIMEOUT_MS = 30_000;

const describeError = (error: unknown): string => {
    if (error instanceof Object && 'stack' in error && typeof error.stack === 'string' && 'message' in error) {
        const message = String(error.message);
        return error.stack.includes(message) ? error.stack : `${message}\n${error.stack}`;
    }
    return String(error);
};

function normalize(nameOrFn: string | TestFn, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn): Registered {
    if (typeof nameOrFn === 'function') return { name: nameOrFn.name || '<anonymous>', fn: nameOrFn, options: {} };
    if (typeof optionsOrFn === 'function') return { name: nameOrFn, fn: optionsOrFn, options: {} };
    return { name: nameOrFn, fn: maybeFn, options: optionsOrFn ?? {} };
}

// --- Timer mocking ---------------------------------------------------------
// Like node:test's MockTimers for `setTimeout`/`setInterval`/`Date`, applied
// to the page and to every fixture window, including ones created later.

type TimerApi = 'setTimeout' | 'setInterval' | 'Date';
interface PendingTimer { id: number; at: number; callback: () => void; interval: number | null }

interface TimerTarget {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    Date: DateConstructor;
}

class MockTimers {
    #enabled = false;
    #apis = new Set<TimerApi>();
    #now = 0;
    // Far from native timer ids, so clearing a native timer cannot cancel a mock.
    #nextId = 2 ** 30;
    #pending = new Map<number, PendingTimer>();
    #restore: (() => void)[] = [];
    #unsubscribe: (() => void) | null = null;

    enable({ apis = ['setTimeout', 'setInterval', 'Date'], now = 0 }: { apis?: TimerApi[]; now?: number | Date } = {}) {
        if (this.#enabled) throw new Error('MockTimers is already enabled.');
        this.#enabled = true;
        this.#apis = new Set(apis);
        this.#now = typeof now === 'number' ? now : now.getTime();
        this.#patch(globalThis as unknown as TimerTarget);
        this.#unsubscribe = fixtureWindows.subscribe(target => this.#patch(target as unknown as TimerTarget));
    }

    #patch(target: TimerTarget) {
        const schedule = (interval: boolean) => (handler: TimerHandler, delay = 0, ...args: unknown[]) => {
            const id = this.#nextId++;
            const wait = Math.max(0, Number(delay) || 0);
            if (typeof handler !== 'function') throw new TypeError('Mocked timers accept function handlers only.');
            const callback = () => { handler(...args); };
            this.#pending.set(id, { id, at: this.#now + wait, callback, interval: interval ? Math.max(1, wait) : null });
            return id;
        };
        const clear = (id?: number) => { if (id !== undefined) this.#pending.delete(Number(id)); };
        const originals: Partial<TimerTarget> = {
            setTimeout: target.setTimeout, clearTimeout: target.clearTimeout,
            setInterval: target.setInterval, clearInterval: target.clearInterval, Date: target.Date,
        };
        if (this.#apis.has('setTimeout')) {
            target.setTimeout = schedule(false) as unknown as typeof setTimeout;
            target.clearTimeout = clear as typeof clearTimeout;
        }
        if (this.#apis.has('setInterval')) {
            target.setInterval = schedule(true) as unknown as typeof setInterval;
            target.clearInterval = clear as typeof clearInterval;
        }
        if (this.#apis.has('Date')) {
            const NativeDate = originals.Date!;
            const now = () => this.#now;
            const MockDate = function (...args: unknown[]) {
                if (!new.target) return new NativeDate(now()).toString();
                return Reflect.construct(NativeDate, args.length ? args : [now()], new.target);
            } as unknown as DateConstructor;
            Object.setPrototypeOf(MockDate, NativeDate);
            Object.defineProperty(MockDate, 'prototype', { value: NativeDate.prototype });
            MockDate.now = now;
            target.Date = MockDate;
        }
        this.#restore.push(() => Object.assign(target, originals));
    }

    tick(milliseconds = 1) {
        if (!this.#enabled) throw new Error('MockTimers is not enabled.');
        const end = this.#now + milliseconds;
        for (;;) {
            const next = [...this.#pending.values()].filter(timer => timer.at <= end)
                .sort((left, right) => left.at - right.at || left.id - right.id)[0];
            if (!next) break;
            this.#now = Math.max(this.#now, next.at);
            if (next.interval === null) this.#pending.delete(next.id);
            else next.at += next.interval;
            next.callback();
        }
        this.#now = end;
    }

    runAll() {
        const latest = Math.max(this.#now, ...[...this.#pending.values()].filter(timer => timer.interval === null).map(timer => timer.at));
        this.tick(latest - this.#now);
    }

    setTime(time: number) { this.#now = time; }

    reset() {
        if (!this.#enabled) return;
        for (const restore of this.#restore.reverse()) restore();
        this.#restore = [];
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#pending.clear();
        this.#enabled = false;
    }

    [Symbol.dispose]() { this.reset(); }
}

// --- Function and method mocks ---------------------------------------------

interface MockCall { arguments: unknown[]; result?: unknown; error?: unknown; this: unknown }
export interface MockFunction<F extends (...args: never[]) => unknown = (...args: never[]) => unknown> {
    (...args: Parameters<F>): ReturnType<F>;
    mock: {
        calls: MockCall[];
        callCount(): number;
        mockImplementation(implementation: F): void;
        mockImplementationOnce(implementation: F, onCall?: number): void;
        restore(): void;
        resetCalls(): void;
    };
}

class MockTracker {
    readonly timers = new MockTimers();
    #restores: (() => void)[] = [];

    fn<F extends (...args: never[]) => unknown>(original?: F, implementation?: F): MockFunction<F> {
        let current = implementation ?? original ?? ((() => undefined) as unknown as F);
        const once = new Map<number, F>();
        const calls: MockCall[] = [];
        const mocked = function (this: unknown, ...args: Parameters<F>) {
            const call: MockCall = { arguments: args, this: this };
            calls.push(call);
            const target = once.get(calls.length - 1) ?? current;
            once.delete(calls.length - 1);
            try {
                call.result = (target as unknown as (...values: unknown[]) => unknown).apply(this, args);
                return call.result;
            } catch (error) {
                call.error = error;
                throw error;
            }
        } as MockFunction<F>;
        mocked.mock = {
            calls,
            callCount: () => calls.length,
            mockImplementation(next) { current = next; },
            mockImplementationOnce(next, onCall = calls.length) { once.set(onCall, next); },
            restore() { current = original ?? current; },
            resetCalls() { calls.length = 0; },
        };
        return mocked;
    }

    method<T extends object, K extends keyof T>(object: T, name: K, implementation?: T[K]): MockFunction {
        const original = object[name] as unknown as (...args: never[]) => unknown;
        if (typeof original !== 'function') throw new TypeError(`${String(name)} is not a method.`);
        const mocked = this.fn(original, (implementation ?? original) as unknown as typeof original);
        const descriptor = Object.getOwnPropertyDescriptor(object, name);
        Object.defineProperty(object, name, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? true, value: mocked });
        const restore = () => {
            if (descriptor) Object.defineProperty(object, name, descriptor);
            else delete object[name];
        };
        mocked.mock.restore = restore;
        this.#restores.push(restore);
        return mocked;
    }

    restoreAll() {
        for (const restore of this.#restores.reverse()) restore();
        this.#restores = [];
    }

    reset() {
        this.restoreAll();
        this.timers.reset();
    }
}

export const mock = new MockTracker();

// --- Test contexts ---------------------------------------------------------

class SkipSignal {
    readonly reason: string | undefined;
    constructor(reason?: string) { this.reason = reason; }
}

export class TestContext {
    readonly mock = new MockTracker();
    readonly #after: Hook[] = [];
    readonly name: string;
    readonly fullName: string;
    readonly timeout: number;
    skipped = false;
    constructor(name: string, fullName: string, timeout = DEFAULT_TIMEOUT_MS) { this.name = name; this.fullName = fullName; this.timeout = timeout; }

    after(hook: Hook) { this.#after.push(hook); }
    // Like node:test, skipping marks the test and lets its body continue.
    skip(_reason?: string) { this.skipped = true; }
    todo(_reason?: string) { this.skipped = true; }
    diagnostic(message: string) { console.log(`# ${this.fullName}: ${message}`); }

    async test(nameOrFn: string | TestFn, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn): Promise<void> {
        const item = normalize(nameOrFn, optionsOrFn, maybeFn);
        const outcome = await runOne(item, `${this.fullName} > ${item.name}`, false);
        if (outcome.result === 'failed') throw new Error(`Subtest failed: ${item.name}\n${outcome.error}`);
    }

    // node:test runs a test's after hooks in registration order.
    async finish() {
        let failure: unknown = null;
        for (const hook of this.#after) {
            try { await withTimeout(Promise.resolve().then(hook), this.timeout, `${this.fullName} after hook`); }
            catch (error) { failure ??= error; }
        }
        this.mock.reset();
        if (failure) throw failure;
    }
}

const NATIVE_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis);
const NATIVE_CLEAR_TIMEOUT = globalThis.clearTimeout.bind(globalThis);
// Bounds a test body or hook with the page's own timer, captured before any
// test can mock timers.
async function withTimeout<T>(work: Promise<T>, timeout: number, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
            timer = NATIVE_SET_TIMEOUT(() => reject(new Error(`${name} timed out after ${timeout} ms`)), timeout);
        })]);
    } finally { NATIVE_CLEAR_TIMEOUT(timer); }
}
const runHook = (hook: Hook, name: string) => withTimeout(Promise.resolve().then(hook), DEFAULT_TIMEOUT_MS, name);

// Uncaught errors and unhandled rejections in the page or any fixture window
// fail the running test, as an uncaught error fails a node:test file.
const uncaught: unknown[] = [];
const recordError = (event: ErrorEvent) => { uncaught.push(event.error ?? new Error(event.message)); };
const recordRejection = (event: PromiseRejectionEvent) => { uncaught.push(event.reason); };
// Code the fixture CSP refused (inline scripts a page or bundle inserts,
// blob: workers), which the runner reports with the file's results.
const cspViolations: string[] = [];
(globalThis as { __bpbCspViolations?: string[] }).__bpbCspViolations = cspViolations;
const recordViolation = (event: SecurityPolicyViolationEvent) => {
    cspViolations.push(`${event.effectiveDirective} ${event.blockedURI || 'inline'}${event.sourceFile ? ` from ${event.sourceFile}` : ''}`);
};
const watchWindow = (target: Window) => {
    target.addEventListener('error', recordError);
    target.addEventListener('unhandledrejection', recordRejection);
    target.document.addEventListener('securitypolicyviolation', recordViolation);
};
watchWindow(window);
fixtureWindows.subscribe(watchWindow);

async function runOne(item: Registered, fullName: string, topLevel: boolean): Promise<BrowserTestResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (item.options.skip || item.options.todo || !item.fn) return { name: fullName, result: 'skipped', durationMs: 0 };
    const context = new TestContext(item.name, fullName, item.options.timeout);
    let failure: unknown = null;
    if (topLevel) uncaught.length = 0;
    try {
        if (topLevel) {
            // Each jsdom page had private web storage; fixture frames share
            // their origin's, so every test starts with it empty.
            localStorage.clear();
            sessionStorage.clear();
            for (const hook of beforeEachHooks) await runHook(hook, `${fullName} beforeEach hook`);
        }
        await withTimeout(Promise.resolve().then(() => item.fn!(context)), item.options.timeout ?? DEFAULT_TIMEOUT_MS, fullName);
    } catch (error) {
        failure = error instanceof SkipSignal ? null : error;
    }
    if (topLevel) {
        // node:test order: afterEach hooks, then the test's after hooks, each
        // in registration order.
        for (const hook of afterEachHooks) {
            try { await runHook(hook, `${fullName} afterEach hook`); } catch (error) { failure ??= error; }
        }
    }
    try { await context.finish(); } catch (error) { failure ??= error; }
    if (topLevel) {
        // node:test restores the module-level tracker only on request; reset
        // timers between tests so one test's clock cannot leak into the next.
        mock.timers.reset();
        // Like jsdom pages, a test's fixture windows end with it: no listener,
        // timer or storage write from one test reaches the next.
        fixtureWindows.closeAll();
        // Let errors from the closing turn surface before judging the test.
        await new Promise(resolve => NATIVE_SET_TIMEOUT(resolve, 0));
        failure ??= uncaught[0] ?? null;
    }
    if (failure) return { name: fullName, result: 'failed', durationMs: elapsed(), error: describeError(failure) };
    return { name: fullName, result: context.skipped ? 'skipped' : 'passed', durationMs: elapsed() };
}

type TestFunction = {
    (nameOrFn: string | TestFn, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn): void;
    skip(name: string, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn): void;
    todo(name: string, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn): void;
    only(name: string, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn): void;
};

const register = (item: Registered) => { registered.push(item); };

export const test = Object.assign(
    (nameOrFn: string | TestFn, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn) => register(normalize(nameOrFn, optionsOrFn, maybeFn)),
    {
        skip: (name: string, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn) => {
            const item = normalize(name, optionsOrFn, maybeFn); register({ ...item, options: { ...item.options, skip: true } });
        },
        todo: (name: string, optionsOrFn?: TestOptions | TestFn, maybeFn?: TestFn) => {
            const item = normalize(name, optionsOrFn, maybeFn); register({ ...item, options: { ...item.options, todo: true } });
        },
        only: () => { throw new Error('test.only is not allowed in committed browser tests.'); },
    },
) as TestFunction;
export const it = test;
export const describe = () => { throw new Error('describe() is not supported by the browser test runtime; use flat tests.'); };
export const before = (hook: Hook) => { beforeHooks.push(hook); };
export const after = (hook: Hook) => { afterHooks.push(hook); };
export const beforeEach = (hook: Hook) => { beforeEachHooks.push(hook); };
export const afterEach = (hook: Hook) => { afterEachHooks.push(hook); };
export default test;

export async function runRegisteredTests(filter: string | null): Promise<BrowserTestResult[]> {
    const results: BrowserTestResult[] = [];
    const selected = registered.filter(item => !filter || item.name.includes(filter));
    try {
        for (const hook of beforeHooks) await runHook(hook, 'before hook');
        for (const item of selected) results.push(await runOne(item, item.name, true));
    } finally {
        for (const hook of afterHooks) {
            try { await runHook(hook, 'after hook'); }
            catch (error) { results.push({ name: '<after hook>', result: 'failed', durationMs: 0, error: describeError(error) }); }
        }
    }
    return results;
}
