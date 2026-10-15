// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { climberCardPlacementReady, prepareClimberCardViewport } from '../../scripts/verify-climber-hover-card.mjs';

test('viewport captures close before repositioning and reopen with keyboard focus after the anchor settles', async t => {
    const dom = new JSDOM('<a id="hover-climber"></a><button class="bpb-climber-actions-trigger"></button><div id="bpb-climber-card"><button class="bpb-climber-card-close">Close</button></div>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const { window } = dom;
    const card = window.document.getElementById('bpb-climber-card');
    const anchor = window.document.getElementById('hover-climber');
    const events = [];
    anchor.scrollIntoView = () => events.push('scroll');
    anchor.getBoundingClientRect = () => ({ top: 100, bottom: 120 });
    Object.assign(window, { innerWidth: 1000, innerHeight: 760 });
    await prepareClimberCardViewport({
        evaluate: fn => window.eval(`(${fn.toString()})()`),
        resize: async () => {
            assert.equal(card.hidden, true, 'do not race an open card against viewport and scroll repositioning');
            events.push('resize');
        },
        key: async (selector, value) => {
            events.push(value);
            card.hidden = value === 'Escape';
            if (!card.hidden) card.querySelector('button').focus();
        },
        wait: async fn => assert.ok(window.eval(`(${fn.toString()})()`)),
        click: async () => assert.fail('reopening must use the already verified keyboard action'),
    }, 1000, 760);
    assert.deepEqual(events, ['Escape', 'resize', 'scroll', 'Enter']);
    assert.equal(card.contains(window.document.activeElement), true);
});

test('hover-card placement tolerates Firefox layout rounding while rejecting visible overlap and unfinished paint', t => {
    const dom = new JSDOM('<a id="hover-climber"></a><div id="bpb-climber-card" style="opacity:1"></div>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const { window } = dom;
    const card = window.document.getElementById('bpb-climber-card');
    const bounds = { width: 312, left: 24, right: 336, top: 257.9666748046875, bottom: 627.0666809082031 };
    const anchor = { top: 627.066650390625, bottom: 644.066650390625 };
    Object.assign(window, { innerWidth: 360, innerHeight: 760 });
    card.getBoundingClientRect = () => bounds;
    window.document.getElementById('hover-climber').getBoundingClientRect = () => anchor;
    let animations = [];
    card.getAnimations = () => animations;
    const ready = () => window.eval(`(${climberCardPlacementReady.toString()})()`);

    assert.equal(ready(), true, 'captured Firefox 152 rectangles differ by only 0.00003 CSS pixels');
    bounds.bottom = anchor.top + 1.01;
    assert.equal(ready(), false, 'more than one CSS pixel of overlap must remain a failure');
    bounds.bottom = anchor.top;
    bounds.right = 361;
    assert.equal(ready(), false, 'offscreen content must remain a failure');
    bounds.right = 336;
    animations = [{ playState: 'running' }];
    assert.equal(ready(), false);
    animations = [];
    card.style.opacity = '0.5';
    assert.equal(ready(), false);
});

test('failed keyboard reopening reports the live state without retrying or replacing its cause', async t => {
    const dom = new JSDOM('<a id="hover-climber"></a><button class="bpb-climber-actions-trigger" aria-expanded="false"></button><div id="bpb-climber-card" hidden></div>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const { window } = dom;
    window.document.getElementById('hover-climber').scrollIntoView = () => {};
    window.document.getElementById('bpb-climber-card').matches = () => false;
    for (const node of window.document.body.children) node.getBoundingClientRect = () => ({ toJSON: () => ({ top: 0, bottom: 0 }) });
    const primary = new Error('keyboard opening timed out');
    let waits = 0, keys = 0;
    await assert.rejects(prepareClimberCardViewport({
        evaluate: fn => window.eval(`(${fn.toString()})()`), resize: async () => {},
        key: async () => { keys++; },
        wait: async () => { if (++waits === 2) throw primary; },
    }, 320, 760), error => {
        assert.equal(error.cause, primary);
        assert.match(error.message, /did not reopen at 320x760/);
        assert.match(error.message, /"hidden":true/);
        assert.match(error.message, /"expanded":"false"/);
        return true;
    });
    assert.equal(keys, 1);
    assert.equal(waits, 2);
    assert.equal(window.__bpbClimberViewportTrace, undefined, 'remove diagnostic listeners after a failed sample');
});

test('viewport diagnostics survive Firefox creating a fresh script global for each command', async t => {
    const dom = new JSDOM('<a id="hover-climber"></a><button class="bpb-climber-actions-trigger" aria-expanded="false"></button><div id="bpb-climber-card" hidden></div>');
    t.after(() => dom.window.close());
    const { window } = dom;
    window.document.getElementById('hover-climber').scrollIntoView = () => {};
    window.document.getElementById('bpb-climber-card').matches = () => false;
    for (const node of window.document.body.children) node.getBoundingClientRect = () => ({ toJSON: () => ({ top: 0, bottom: 0 }) });
    let waits = 0;
    await assert.rejects(prepareClimberCardViewport({
        evaluate: fn => runInNewContext(`(${fn.toString()})()`, { window, document: window.document,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
            MutationObserver: window.MutationObserver, performance: window.performance }),
        resize: async () => {},
        key: async () => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
        wait: async () => { if (++waits === 2) throw new Error('opening timed out'); },
    }, 320, 760), error => {
        assert.match(error.message, /"key":"Enter"/, 'event history must remain on the page Window between commands');
        return true;
    });
    assert.equal(window.__bpbClimberViewportTrace, undefined, 'cleanup must reach the same page-owned trace');
});
