import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createCardReadGate } from '../../src/ui/card-read-gate.js';

test('read eligibility combines settings, lifecycle, visibility and optional collapse without mutation churn', async () => {
    const dom = new JSDOM('<section hidden></section>', { pretendToBeVisual: true });
    const doc = dom.window.document, card = doc.querySelector('section'), changes = [];
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

test('one viewport wait is cancellable and stale observer callbacks cannot start reads', () => {
    const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
    const card = dom.window.document.querySelector('section'), observers = []; let reads = 0;
    dom.window.IntersectionObserver = class {
        constructor(callback, options) { this.callback = callback; observers.push(this); assert.equal(options.rootMargin, '200px'); }
        observe(node) { assert.equal(node, card); } disconnect() { this.disconnected = true; }
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
