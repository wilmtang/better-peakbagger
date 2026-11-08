// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleDeadline } from '../../src/ui/visible-deadline.ts';

const page = (visibilityState: string) => {
    const listeners = new Set<() => void>();
    return {
        visibilityState, listeners,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        set(value: string) { this.visibilityState = value; for (const listener of [...listeners]) listener(); },
    };
};
const owner = (value: ReturnType<typeof page>) => value as unknown as Document;

test('a hidden tab cannot expire a boot deadline, and returning restarts it in full', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const doc = page('hidden'); let expired = 0;
    createVisibleDeadline(owner(doc), 1000, () => expired++);
    t.mock.timers.tick(60000); assert.equal(expired, 0, 'Nothing can render while hidden');
    doc.set('visible'); t.mock.timers.tick(999); assert.equal(expired, 0, 'The whole duration restarts');
    doc.set('hidden'); t.mock.timers.tick(60000); assert.equal(expired, 0, 'Leaving again pauses it');
    doc.set('visible'); t.mock.timers.tick(1000); assert.equal(expired, 1);
    assert.equal(doc.listeners.size, 0, 'An expired deadline stops listening');
});
test('a visible deadline expires once and clear cancels it', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const doc = page('visible'); let expired = 0;
    createVisibleDeadline(owner(doc), 1000, () => expired++);
    t.mock.timers.tick(1000); assert.equal(expired, 1);
    const cancelled = createVisibleDeadline(owner(doc), 1000, () => expired++);
    cancelled.clear(); doc.set('visible'); t.mock.timers.tick(5000);
    assert.equal(expired, 1); assert.equal(doc.listeners.size, 0);
});
