// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCustomSource, customUrl, readCustomRegistry, readCustomSelection, CUSTOM_REGISTRY_KEY } from '../../src/maps/custom-overlay-schema.js';
import { createCustomOverlayStore } from '../../src/background/custom-overlay-store.js';
import { customLayerBackup } from '../../src/maps/custom-overlay-transfer.js';
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
test('restores reject intervening source/opacity changes and invalidate old revisions and previews', async () => {
    const values = {}, storage = { get: async () => structuredClone(values), set: async patch => Object.assign(values, structuredClone(patch)) };
    const store = createCustomOverlayStore({ storage, canRead: () => true, canEdit: () => true }), sender = { tab: { id: 4 } }, valid = source();
    await store.handle({ type: 'CUSTOM_OVERLAYS_SAVE', id: valid.id, source: valid, expectedRevision: 0 }, sender);
    const snapshot = await store.snapshot(), backup = customLayerBackup(snapshot);
    await store.handle({ type: 'CUSTOM_OVERLAYS_OPACITY', id: valid.id, opacity: 20 }, sender);
    assert.equal((await store.replaceIfCurrent(snapshot, backup)).replaced, false, 'opacity participates in the compare-and-swap');
    await store.handle({ type: 'CUSTOM_OVERLAYS_PREVIEW', mapId: 'map-one', source: { ...valid, name: 'Temporary' } }, sender);
    const current = await store.snapshot(), result = await store.replaceIfCurrent(current, backup);
    assert.equal(result.replaced, true); assert.equal(result.current.registry.generation, 1);
    assert.equal(result.current.registry.sources[0].revision, 2);
    const reply = await store.handle({ type: 'CUSTOM_OVERLAYS_GET', mapId: 'map-one' }, sender);
    assert.equal(reply.registry.sources[0].name, valid.name, 'restore drops temporary drafts');
    assert.equal((await store.handle({ type: 'CUSTOM_OVERLAYS_SAVE', id: valid.id, source: valid, expectedRevision: 1 }, sender)).ok, false);
});
test('saved order is an authorized, revision-checked permutation without changing definitions or opacity', async () => {
    const values = {}, storage = { get: async () => structuredClone(values), set: async patch => Object.assign(values, structuredClone(patch)) };
    const store = createCustomOverlayStore({ storage, canRead: () => true, canEdit: sender => sender.editor });
    const first = source(), second = { ...source(), id: 'custom:1537a032-271c-4d11-9b8c-0edc566b47c1', name: 'Second' };
    for (const item of [first, second]) await store.handle({ type: 'CUSTOM_OVERLAYS_SAVE', id: item.id, source: item, expectedRevision: 0 }, { editor: true });
    const snapshot = await store.snapshot(), message = { type: 'CUSTOM_OVERLAYS_REORDER', ids: [second.id, first.id], expectedRevision: snapshot.registry.revision };
    assert.equal((await store.handle(message, {})).ok, false);
    assert.equal((await store.handle({ ...message, ids: [first.id, first.id] }, { editor: true })).ok, false);
    const result = await store.handle(message, { editor: true }); assert.equal(result.ok, true);
    assert.deepEqual(result.registry.sources.map(item => item.id), message.ids); assert.deepEqual(result.registry.sources.map(item => item.revision), [1, 1]);
    assert.deepEqual(result.preferences, snapshot.preferences); assert.equal(result.registry.generation, undefined);
    assert.equal((await store.handle(message, { editor: true })).ok, false, 'stale reorder cannot overwrite a concurrent edit');
    assert.notDeepEqual(customLayerBackup(snapshot).sources, customLayerBackup(result).sources, 'backup preserves the saved order');
});
