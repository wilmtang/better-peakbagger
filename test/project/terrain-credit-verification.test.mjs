// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStableTerrainGeometry, assertTerrainCreditLayout } from '../../scripts/verify-terrain-provider-ui.mjs';

const state = lines => ({
    frameWidth: 798, frameHeight: 450, lines,
    nav: { x: 756, y: 358.5, right: 788, bottom: 421.5 },
    scale: { x: 10, y: 399.5, right: 101, bottom: 421.5 },
    picker: { x: 593, y: 10, right: 788, bottom: 39 },
    hint: { x: 10, y: 367.5, right: 225, bottom: 393.5 }, hintVisible: true,
});

test('credits can use the full width below the anchored zoom controls', () => {
    assert.doesNotThrow(() => assertTerrainCreditLayout(state([
        { x: 179.6, y: 431.5, right: 793, bottom: 448 },
    ]), 'captured desktop layout'));
});

test('wrapped credits flow beside and below controls without reserving an empty column', () => {
    assert.doesNotThrow(() => assertTerrainCreditLayout(state([
        { x: 300, y: 400, right: 750, bottom: 416 },
        { x: 179, y: 431, right: 793, bottom: 448 },
    ]), 'wrapped layout'));
});

test('actual text collisions, clipping, and missing text still fail', () => {
    for (const key of ['nav', 'scale', 'picker', 'hint']) {
        const layout = state([]);
        layout.lines = [layout[key]];
        assert.throws(() => assertTerrainCreditLayout(layout, key), new RegExp(`overlaps ${key}`));
    }
    assert.throws(() => assertTerrainCreditLayout(state([
        { x: 180, y: 431, right: 801, bottom: 448 },
    ]), 'clipped'), /leaves the map/);
    assert.throws(() => assertTerrainCreditLayout(state([]), 'empty'), /no painted credit text/);
});

test('attribution can displace the informational scale while actions and page content stay anchored', () => {
    const before = state([{ x: 180, y: 431, right: 793, bottom: 448 }]);
    for (const key of ['toggle', 'heading', 'following', 'mount', 'scroll']) before[key] = { x: 0, y: 0 };
    const after = structuredClone(before);
    after.scale.y -= 16;
    after.scale.bottom -= 16;
    assert.doesNotThrow(() => assertStableTerrainGeometry(before, after, 'scale follows credits'));
    for (const key of ['nav', 'picker', 'toggle', 'heading', 'following', 'mount', 'scroll']) {
        const moved = structuredClone(after);
        moved[key].x += 2;
        assert.throws(() => assertStableTerrainGeometry(before, moved, key), /moved/);
    }
});
