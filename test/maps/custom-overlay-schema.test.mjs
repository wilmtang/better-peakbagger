// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCustomSource, customUrl, readCustomRegistry, readCustomSelection, CUSTOM_REGISTRY_KEY } from '../../src/maps/custom-overlay-schema.js';
import { createCustomOverlayStore } from '../../src/background/custom-overlay-store.js';
export const source = () => ({ id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Trails', kind: 'raster',
    source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png?key=a%2Fb'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: 'Data' }, appearance: { opacity: 60, rules: [] } });
test('custom source validation preserves templates/query encoding and rejects privilege/format changes', () => {
    const valid = source(); assert.equal(readCustomSource(valid).source.tiles[0], valid.source.tiles[0]);
    for (const url of ['http://tiles.example.com/{z}/{x}/{y}', 'https://localhost/{z}/{x}/{y}', 'https://127.0.0.1/{z}/{x}/{y}', 'https://a:b@tiles.example.com/{z}/{x}/{y}', 'https://tiles.example.com/{quadkey}']) assert.equal(customUrl(url, true), null);
    assert.equal(readCustomSource({ ...valid, approvedOrigins: [] }), null);
    assert.equal(readCustomSource({ ...valid, kind: 'style' }), null);
    assert.equal(readCustomSource({ ...valid, source: { ...valid.source, minNativeZoom: 19 } }), null);
    assert.equal(readCustomRegistry({ schemaVersion: 1, revision: 1, sources: [valid, valid] }), null);
    assert.deepEqual(readCustomSelection([{ id: valid.id, sourceRevision: 1, enabled: true }]), [{ id: valid.id, sourceRevision: 1, enabled: true }]);
});
test('registry serializes stale editors, rejects page writes and preserves corrupt/unavailable storage', async () => {
    const values = {}, storage = { get: async () => structuredClone(values), set: async patch => Object.assign(values, structuredClone(patch)) };
    const store = createCustomOverlayStore({ storage, canRead: () => true, canEdit: sender => sender.editor });
    const valid = source(), save = { type: 'CUSTOM_OVERLAYS_SAVE', id: valid.id, source: valid, expectedRevision: 0 };
    assert.equal((await store.handle(save, {})).ok, false);
    const replies = await Promise.all([store.handle(save, { editor: true }), store.handle(save, { editor: true })]);
    assert.deepEqual(replies.map(reply => reply.ok), [true, false]);
    assert.equal((await store.handle({ type: 'CUSTOM_OVERLAYS_OPACITY', id: valid.id, opacity: 20 }, {})).ok, true);
    assert.equal(values[CUSTOM_REGISTRY_KEY].sources[0].revision, 1);
    values[CUSTOM_REGISTRY_KEY] = { corrupt: true };
    assert.equal((await store.handle(save, { editor: true })).ok, false);
    assert.deepEqual(values[CUSTOM_REGISTRY_KEY], { corrupt: true });
});
