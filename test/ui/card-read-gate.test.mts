import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error jsdom ships no declarations.
import { JSDOM } from 'jsdom';
import { createCardReadGate } from '../../src/ui/card-read-gate.ts';

test('read eligibility combines settings, lifecycle, visibility and optional collapse without mutation churn', async () => {
    const dom = new JSDOM('<section hidden></section>', { pretendToBeVisual: true });
    const doc = dom.window.document, card = doc.querySelector('section'), changes: boolean[] = [];
    let enabled = false, active = true, collapsed = false;
    const gate = createCardReadGate({ card, enabled: () => enabled, active: () => active, collapsed: () => collapsed, onChange: value => changes.push(value) });
    try {
        card.hidden = false; await Promise.resolve(); assert.equal(gate.eligible(), false);
        enabled = true; gate.refresh(); assert.deepEqual(changes, [true]);
        gate.refresh(); card.hidden = false; await Promise.resolve(); assert.deepEqual(changes, [true]);
        collapsed = true; gate.refresh(); assert.equal(gate.eligible(), false);
        collapsed = false; card.dataset.bpbCardCollapsed = 'true'; gate.refresh(); assert.equal(gate.eligible(), false);
        delete card.dataset.bpbCardCollapsed; await Promise.resolve(); assert.equal(gate.eligible(), true);
        Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'hidden' });
        doc.dispatchEvent(new dom.window.Event('visibilitychange')); assert.equal(gate.eligible(), false);
        Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' });
        doc.dispatchEvent(new dom.window.Event('visibilitychange')); assert.equal(gate.eligible(), true);
        active = false; gate.refresh(); assert.equal(gate.eligible(), false);
        active = true; gate.refresh(); enabled = false; gate.refresh(); assert.equal(gate.eligible(), false);
        gate.dispose(); enabled = true; gate.refresh(); assert.equal(gate.eligible(), false);
    } finally { gate.dispose(); dom.window.close(); }
});

test('the applied card state wins while a saved collapse preference is still arriving', () => {
    const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
    const card = dom.window.document.querySelector('section');
    let collapsed = true;
    const gate = createCardReadGate({ card, enabled: () => true, active: () => true, collapsed: () => collapsed });
    try {
        assert.equal(gate.eligible(), false, 'the preference decides before the layout applies a state');
        card.dataset.bpbCardCollapsed = 'false';
        assert.equal(gate.eligible(), true, 'an expanded card is readable before settings echo back');
        collapsed = false; card.dataset.bpbCardCollapsed = 'true';
        assert.equal(gate.eligible(), false, 'a collapsed card stays unreadable before settings echo back');
    } finally { gate.dispose(); dom.window.close(); }
});

test('one viewport wait is cancellable and stale observer callbacks cannot start reads', () => {
    const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
    const card = dom.window.document.querySelector('section'), observers: { callback: (entries: { isIntersecting: boolean }[]) => void }[] = []; let reads = 0;
    dom.window.IntersectionObserver = class {
        callback: (entries: { isIntersecting: boolean }[]) => void;
        disconnected = false;
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void, options: { rootMargin: string }) { this.callback = callback; observers.push(this); assert.equal(options.rootMargin, '200px'); }
        observe(node: unknown) { assert.equal(node, card); } disconnect() { this.disconnected = true; }
    };
    const gate = createCardReadGate({ card, enabled: () => true, active: () => true });
    try {
        gate.waitForViewport(() => reads++); gate.waitForViewport(() => reads++); assert.equal(observers.length, 1);
        gate.cancelWait(); gate.waitForViewport(() => reads++);
        observers[0].callback([{ isIntersecting: true }]); assert.equal(reads, 0);
        observers[1].callback([{ isIntersecting: false }]); assert.equal(reads, 0);
        observers[1].callback([{ isIntersecting: true }]); assert.equal(reads, 1);
        observers[1].callback([{ isIntersecting: true }]); assert.equal(reads, 1);
        gate.waitForViewport(() => reads++); gate.dispose(); observers[2].callback([{ isIntersecting: true }]); assert.equal(reads, 1);
    } finally { gate.dispose(); dom.window.close(); }
});
