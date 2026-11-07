// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error jsdom ships no declarations.
import { JSDOM } from 'jsdom';
import {
    createPageLifecycle,
    pageLifecycle as PageLifecycle,
    type PageLifecycleState,
    type PageLifecycleWindow,
    type PageTransitionEventLike,
} from '../../src/ui/page-lifecycle.ts';

interface TestWindow extends PageLifecycleWindow {
    PageTransitionEvent: new (type: 'pagehide' | 'pageshow', init: { persisted: boolean }) => unknown;
    dispatchEvent(event: unknown): boolean;
    close(): void;
}

const transition = (window: TestWindow, type: 'pagehide' | 'pageshow', persisted: boolean) => window.dispatchEvent(
    new window.PageTransitionEvent(type, { persisted }),
);

test('persisted history traversal suspends and resumes without disposing', () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://www.peakbagger.com/peak.aspx?pid=1' });
    const calls: string[] = [];
    const lifecycle = PageLifecycle.create({
        ownerWindow: dom.window,
        onSuspend: event => calls.push(`suspend:${String(event.persisted)}`),
        onResume: event => calls.push(`resume:${String(event.persisted)}`),
        onDispose: event => calls.push(`dispose:${String(event.persisted)}`),
    });

    transition(dom.window, 'pagehide', true);
    transition(dom.window, 'pagehide', true);
    assert.equal(lifecycle.state, 'suspended');
    transition(dom.window, 'pageshow', true);
    transition(dom.window, 'pageshow', true);
    assert.equal(lifecycle.state, 'active');
    transition(dom.window, 'pagehide', true);
    transition(dom.window, 'pageshow', true);

    assert.deepEqual(calls, ['suspend:true', 'resume:true', 'suspend:true', 'resume:true']);
    dom.window.close();
});

test('ordinary teardown disposes exactly once and cannot resume', () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://www.peakbagger.com/map/BigMap.aspx?t=A' });
    const calls: string[] = [];
    const lifecycle = PageLifecycle.create({
        ownerWindow: dom.window,
        onSuspend: () => calls.push('suspend'),
        onResume: () => calls.push('resume'),
        onDispose: () => calls.push('dispose'),
    });

    transition(dom.window, 'pagehide', true);
    transition(dom.window, 'pagehide', false);
    transition(dom.window, 'pageshow', true);
    lifecycle.dispose();

    assert.equal(lifecycle.state, 'disposed');
    assert.deepEqual(calls, ['suspend', 'dispose']);
    dom.window.close();
});

test('default window binding and callback error isolation preserve the state machine', () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://www.peakbagger.com/peak.aspx?pid=2' });
    const globalScope = globalThis as { window?: TestWindow };
    const previousWindow = globalScope.window;
    const seen: { phase: PageLifecycleState; persisted: boolean | undefined }[] = [];
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };

    try {
        globalScope.window = dom.window;
        const lifecycle = createPageLifecycle({
            onSuspend(event: PageTransitionEventLike) {
                seen.push({ phase: 'suspended', persisted: event.persisted });
                throw new Error('SUSPEND_FAILED');
            },
            onResume(event: PageTransitionEventLike) {
                seen.push({ phase: 'active', persisted: event.persisted });
            },
            onDispose(event: PageTransitionEventLike) {
                seen.push({ phase: 'disposed', persisted: event.persisted });
            },
        });

        transition(dom.window, 'pagehide', true);
        assert.equal(lifecycle.state, 'suspended');
        assert.equal(errors.length, 1);
        transition(dom.window, 'pageshow', true);
        assert.equal(lifecycle.state, 'active');
        lifecycle.dispose();
        assert.equal(lifecycle.state, 'disposed');
        assert.deepEqual(seen, [
            { phase: 'suspended', persisted: true },
            { phase: 'active', persisted: true },
            { phase: 'disposed', persisted: false },
        ]);
    } finally {
        console.error = originalError;
        if (previousWindow === undefined) delete globalScope.window;
        else globalScope.window = previousWindow;
        dom.window.close();
    }
});
