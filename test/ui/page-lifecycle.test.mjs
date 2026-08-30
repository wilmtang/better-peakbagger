// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { pageLifecycle as PageLifecycle } from '../../src/ui/page-lifecycle.js';

const transition = (window, type, persisted) => window.dispatchEvent(
    new window.PageTransitionEvent(type, { persisted }),
);

test('persisted history traversal suspends and resumes without disposing', () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://www.peakbagger.com/peak.aspx?pid=1' });
    const calls = [];
    const lifecycle = PageLifecycle.create({
        ownerWindow: dom.window,
        onSuspend: () => calls.push('suspend'),
        onResume: () => calls.push('resume'),
        onDispose: () => calls.push('dispose'),
    });

    transition(dom.window, 'pagehide', true);
    transition(dom.window, 'pagehide', true);
    assert.equal(lifecycle.state, 'suspended');
    transition(dom.window, 'pageshow', true);
    transition(dom.window, 'pageshow', true);
    assert.equal(lifecycle.state, 'active');
    transition(dom.window, 'pagehide', true);
    transition(dom.window, 'pageshow', true);

    assert.deepEqual(calls, ['suspend', 'resume', 'suspend', 'resume']);
    dom.window.close();
});

test('ordinary teardown disposes exactly once and cannot resume', () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://www.peakbagger.com/map/BigMap.aspx?t=A' });
    const calls = [];
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
