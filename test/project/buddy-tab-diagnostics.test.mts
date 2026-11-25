// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { installBuddyTabDiagnostics } from '../../scripts/buddy-tab-diagnostics.mts';

// The slice of chrome.tabs the diagnostics wrap, as each case stubs it.
type Listener = (...args: unknown[]) => void;
interface StubTabs {
    create?(details: { url?: string; active?: boolean }, callback?: (tab: unknown) => void): unknown;
    query?(info: object): unknown;
    update?(id: number, properties: object): unknown;
}
interface TraceEvent { id?: number; value?: { id?: number }; error?: string; tab?: { id?: number } }
interface Trace { events: TraceEvent[]; restore(): void }

const setup = (methods: StubTabs) => {
    const listeners = new Set<Listener>();
    const chrome: { runtime: { lastError?: { message: string } }; tabs: StubTabs & { onUpdated: unknown } } = { runtime: {}, tabs: { ...methods, onUpdated: {
        addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn),
    } } };
    const window: { __bpbBuddyTabDiagnostics?: Trace } = {};
    vm.runInNewContext(`(${installBuddyTabDiagnostics.toString()})()`, { chrome, window });
    return { chrome, trace: window.__bpbBuddyTabDiagnostics!, listeners };
};

test('Buddy tab tracing preserves native receiver, callback data, errors and return values', () => {
    const created = { id: 77, status: 'loading', pendingUrl: 'about:blank' };
    const nativeResult = {};
    let receiver: unknown;
    const { chrome, trace } = setup({ create(details, callback) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- records the receiver the wrapper calls with
        receiver = this;
        assert.equal(details.active, false);
        chrome.runtime.lastError = { message: 'fixture navigation failure' };
        callback?.(created);
        delete chrome.runtime.lastError;
        return nativeResult;
    } });
    let callbackValue: unknown, callbackError: string | undefined;
    assert.equal(chrome.tabs.create!({ url: 'about:blank', active: false }, value => {
        callbackValue = value;
        callbackError = chrome.runtime.lastError?.message;
    }), nativeResult);
    assert.equal(receiver, chrome.tabs);
    assert.equal(callbackValue, created);
    assert.equal(callbackError, 'fixture navigation failure');
    assert.equal(trace.events[1]?.value?.id, 77);
    assert.equal(trace.events[1]?.error, callbackError);
});

test('Buddy tab tracing preserves promises and thrown errors without retrying calls', async () => {
    const failure = new Error('fixture update refused');
    let calls = 0;
    const promise = Promise.resolve([]);
    const { chrome, trace } = setup({ query: () => promise, update() { calls++; throw failure; } });
    assert.equal(chrome.tabs.query!({}), promise);
    assert.throws(() => chrome.tabs.update!(77, { active: false }), error => error === failure);
    assert.equal(calls, 1);
    assert.equal(trace.events.at(-1)?.error, failure.message);
    await promise;
});

test('Buddy tab tracing bounds event history and restores native methods and listeners', () => {
    const create = () => {};
    const { chrome, trace, listeners } = setup({ create });
    const updated = [...listeners][0]!;
    for (let id = 0; id < 120; id++) updated(id, { status: 'complete' }, { id, url: 'about:blank' });
    assert.equal(trace.events.length, 100);
    assert.equal(trace.events[0]?.id, 20);
    assert.equal(trace.events.at(-1)?.tab?.id, 119);
    trace.restore();
    assert.equal(chrome.tabs.create, create);
    assert.equal(listeners.size, 0);
});
