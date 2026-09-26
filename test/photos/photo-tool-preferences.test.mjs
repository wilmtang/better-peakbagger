// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { photoToolPreferences as Preferences } from '../../src/photos/photo-tool-preferences.js';

test('stored tool preferences reject corrupt fields and ignore annotation content', () => {
    assert.deepEqual(Preferences.clean('route', {
        style: { color: '#ffffff', width: Infinity, opacity: 0, end: 'arrow', smooth: true },
        text: 'private', geometry: { x: 20 }, rotation: NaN,
    }), {
        style: { color: '#ffffff', width: 12, opacity: 1, stroke: 'solid', end: 'arrow', smooth: true },
        rotation: 0,
    });
    assert.equal(Preferences.clean('unknown'), null);
    assert.equal(Preferences.clean('text', { style: { align: 'right', background: false } }).style.background, false);
});

test('text width preferences distinguish Auto from an unset or invalid width', () => {
    assert.equal(Preferences.clean('text', { width: 275 }).width, 275);
    assert.equal(Preferences.clean('text', { width: null }).width, null);
    for (const width of [undefined, 0, -1, Infinity, '275', 999999]) {
        assert.equal(Object.hasOwn(Preferences.clean('text', { width }), 'width'), false);
    }
    assert.equal(Object.hasOwn(Preferences.clean('route', { width: 275 }), 'width'), false);
});
