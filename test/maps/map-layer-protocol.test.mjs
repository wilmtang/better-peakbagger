// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readLayerSnapshot, readLayerStatus } from '../../src/maps/map-layer-protocol.js';

test('provider cooldowns crossing the frame or handoff boundary are named, finite and short-lived', () => {
    const future = Date.now() + 120000;
    const raw = { bc: future, us: 'later', ab: Date.now() - 1, url: 'https://example.com', arbitrary: future };
    assert.deepEqual(readLayerSnapshot({ revision: 1, landCooldowns: raw }).landCooldowns, { bc: future });
    assert.deepEqual(readLayerStatus({ id: 'land', providerCooldowns: raw }).providerCooldowns, { bc: future });
    assert.deepEqual(readLayerStatus({ id: 'land', providerCooldowns: { bc: Date.now() + 172800000, us: Infinity } }).providerCooldowns, {});
    assert.deepEqual(readLayerStatus({ id: 'sentinel', providerCooldowns: { bc: future } }).providerCooldowns, {});
    assert.equal(readLayerStatus({ id: 'land', captureError: true }).captureError, false);
    assert.equal(readLayerStatus({ id: 'sentinel', partial: true }).partial, true);
    assert.equal(readLayerStatus({ id: 'snotel', partial: true }).partial, false);
});
