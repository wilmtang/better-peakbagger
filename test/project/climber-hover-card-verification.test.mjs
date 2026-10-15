// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { climberCardPlacementReady } from '../../scripts/verify-climber-hover-card.mjs';

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
