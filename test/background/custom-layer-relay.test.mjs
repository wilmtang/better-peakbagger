// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { createCustomPrivateStore } from '../../src/background/custom-private-store.js';
import { createCustomOverlayStore } from '../../src/background/custom-overlay-store.js';
import { createCustomLayerRelay } from '../../src/background/custom-layer-relay.js';
import { publicPrivateSource, privateRequestUrl, readPrivateParameters, readRelayResource, PRIVATE_LIMITS } from '../../src/maps/custom-overlay-private.js';
import { customLayerBackup } from '../../src/maps/custom-overlay-transfer.js';
const id = 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1';
const source = { id, revision: 1, name: 'Private topo', kind: 'raster',
    source: { tiles: ['https://tiles.example.com/tiles/{z}/{x}/{y}.png'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
const secret = [{ key: 'api_key', value: 'private+key/DO_NOT_LEAK' }];
const page = { id: 'extension', frameId: 0, documentId: 'doc', url: 'https://www.peakbagger.com/Peak.aspx?pid=1', tab: { id: 7, url: 'https://www.peakbagger.com/Peak.aspx?pid=1' } };
const access = { id: 'extension', frameId: 0, url: 'chrome-extension://extension/custom-overlay/access.html', tab: { id: 99 } };
function harness() {
    let time = 1000000, allowed = true, active = true, currentUrl = page.tab.url, issued, calls = 0, fetcher;
    const records = new Map(), requestUrls = [], storage = { get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(records.get(key))])),set: async patch => { for (const [key, value] of Object.entries(patch)) records.set(key, structuredClone(value)); } };
    const privateRecords = new Map(), privateStore = { get: async key => structuredClone(privateRecords.get(key)),put: async (key, value) => { if (value == null) privateRecords.delete(key);else privateRecords.set(key, structuredClone(value)); },
        mutate: async (key, fn) => { const next = fn(structuredClone(privateRecords.get(key)));privateRecords.set(key, next);return next; } };
    const editor = { id: 'extension', frameId: 0, url: 'chrome-extension://extension/options/options.html', tab: { id: 8 } };
    const catalog = createCustomOverlayStore({ storage, privateStore, canRead: () => true, canEdit: sender => sender === editor, canReadPrivate: sender => sender === editor });
    const ext = { runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}` }, permissions: { contains: async () => allowed }, tabs: {
        get: async () => ({ url: currentUrl, active }),create: async value => { issued = value.url.split('#')[1];return { id: 99 }; }, update: async () => { active = true; } } };
    const create = () => createCustomLayerRelay({ ext, privateStore, catalog, isPage: sender => sender?.id === 'extension' && sender.url?.startsWith('https://www.peakbagger.com/'),isTerrain: () => false,
        isEditor: sender => sender === editor,isAccess: sender => sender === access, trustedActions: { consumeCapability: message => message.activationToken === 'trusted' },action: 'custom-layer-access',now: () => time,
        fetchImpl: async (url, options) => { calls++;requestUrls.push([url, options]);return fetcher ? fetcher(url, options) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }); } });
    let relay = create();
    const save = (params = secret, body = source, revision = 0) => catalog.handle({ type: 'CUSTOM_OVERLAYS_SAVE', id, expectedRevision: revision, source: body, requestParameters: params }, editor);
    const grant = async (selectedId = id, sender = page) => { assert((await relay.handle({ type: 'CUSTOM_PRIVATE_OPEN', id: selectedId, revision: 1, activationToken: 'trusted' }, sender)).ok);
        assert((await relay.handle({ type: 'CUSTOM_PRIVATE_REVIEW', token: issued }, access)).ok);assert((await relay.handle({ type: 'CUSTOM_PRIVATE_APPROVE', token: issued }, access)).ok); };
    const get = (patch = {}, sender = page) => relay.handle({ type: 'CUSTOM_PRIVATE_GET', id, revision: 1, resource: 'tile', coordinates: { z: 2, x: 1, y: 1 },requestId: crypto.randomUUID(), ...patch }, sender);
    return { records, privateRecords, privateStore, editor, catalog, save, grant, get, relay: () => relay, restart: () => { relay = create(); },calls: () => calls,urls: requestUrls,
        time: next => { time = next; },permission: value => { allowed = value; },active: value => { active = value; },navigate: value => { currentUrl = value; },fetch: fn => { fetcher = fn; },token: () => issued };
}
test('private fields are validated, projected and excluded from public reads and backups; only Settings edits can read them', async () => {
    assert.throws(() => readPrivateParameters([{ key: 'a', value: 'x' }, { key: 'A', value: 'y' }]));
    assert.throws(() => readPrivateParameters([{ key: 'a', value: '' }]));
    const h = harness();assert((await h.save()).ok);
    const plain = await h.catalog.handle({ type: 'CUSTOM_OVERLAYS_GET' }, page);
    assert(plain.registry.sources[0].privateRequests);assert(!JSON.stringify(plain).includes('private+key'));assert(!JSON.stringify(plain).includes('tiles.example.com'));
    const trusted = await h.catalog.handle({ type: 'CUSTOM_OVERLAYS_GET' }, h.editor);assert.deepEqual(trusted.registry.sources[0].requestParameters, secret);
    assert(!JSON.stringify(customLayerBackup(await h.catalog.snapshot())).includes('private+key'));
    assert(!JSON.stringify([...h.records.values()]).includes('private+key'));
    const projected = publicPrivateSource(source);assert(readRelayResource(projected.source.tiles[0].replaceAll('{z}', '2').replaceAll('{x}', '1').replaceAll('{y}', '1')));
    assert.equal(readRelayResource('https://evil.example/tile/2/1/1'), null);
    const other = { ...source, source: { ...source.source, metadataUrl: 'https://meta.example.com/source.json' }, approvedOrigins: [...source.approvedOrigins, 'https://meta.example.com'] };
    assert(!privateRequestUrl(other, secret, { resource: 'tile', coordinates: { z: 2, x: 1, y: 1 } }).includes('api_key'));
});
test('no request before explicit extension approval; reject synthetic activation, replay, wrong owners and arbitrary resources', async () => {
    const h = harness();await h.save();assert.equal((await h.get()).code, 'approval');assert.equal(h.calls(), 0);
    assert.equal((await h.relay().handle({ type: 'CUSTOM_PRIVATE_OPEN', id, revision: 1 }, page)).ok, false);
    await h.grant();assert.equal((await h.relay().handle({ type: 'CUSTOM_PRIVATE_APPROVE', token: h.token() }, access)).ok, false);
    assert.equal((await h.get({}, { ...page, tab: { id: 9 } })).ok, false);
    assert.equal((await h.get({}, { ...page, documentId: 'other' })).ok, false);
    for (const patch of [{ revision: 2 }, { resource: 'fetch', url: 'https://evil.example' }, { coordinates: { z: 99, x: 1, y: 1 } }, { coordinates: { z: 2, x: -1, y: 0 } }]) assert.equal((await h.get(patch)).ok, false);
    assert.equal(h.calls(), 0);
    assert((await h.get()).ok);assert.equal(h.calls(), 1);assert(h.urls[0][0].includes('api_key=private%2Bkey%2FDO_NOT_LEAK'));
    assert.equal(h.urls[0][1].credentials, 'omit');assert.equal(h.urls[0][1].redirect, 'error');assert.equal(h.urls[0][1].referrerPolicy, 'no-referrer');
    assert((await h.get()).ok);assert.equal(h.calls(), 1, 'cached tile does not spend more quota');
    h.active(false);assert.equal((await h.get()).ok, false);h.active(true);
    h.navigate(page.tab.url + '&changed=1');assert.equal((await h.get()).ok, false);
});
test('grants expire, permission/source changes fail closed, worker restart loses authority without resetting shared budgets', async () => {
    const h = harness();await h.save();await h.grant();h.permission(false);assert.equal((await h.get()).ok, false);assert.equal(h.calls(), 0);h.permission(true);
    h.time(1000000 + PRIVATE_LIMITS.grantMs);assert.equal((await h.get()).ok, false);h.time(1000000);
    await h.grant();h.restart();assert.equal((await h.get()).ok, false);
    await h.grant();h.privateRecords.set('budget:tiles.example.com', { start: 1000000, hour: 1000000, daily: 0, hourly: 1024, last: 1000000 });
    assert.equal((await h.get()).ok, false);assert.equal(h.calls(), 0);
    h.restart();await h.grant();assert.equal((await h.get()).ok, false);
    h.privateRecords.set('budget:tiles.example.com', { start: 1000000, hour: 1000000, daily: 0, hourly: 0, last: 1000001 });assert.equal((await h.get()).ok, false, 'clock rollback cannot refresh budgets');
});
test('request budget caps attempts, rejects redirects/oversize/secret errors and obeys shared 429 cooldown', async () => {
    const h = harness();await h.save();await h.grant();
    h.fetch(async () => { throw new Error('secret echoed private+key'); });
    for (let i = 0; i < 256; i++) { const reply = await h.get();assert(!JSON.stringify(reply).includes('private+key')); }
    assert.equal(h.calls(), 256);assert.equal((await h.get()).ok, false);assert.equal(h.calls(), 256);
    const o = harness();await o.save();await o.grant();o.fetch(async () => new Response('oops', { headers: { 'content-type': 'image/png', 'content-length': String(10 ** 8) } }));assert.equal((await o.get()).ok, false);
    o.fetch(async () => { const response = new Response('redirect', { headers: { 'content-type': 'image/png' } });Object.defineProperty(response, 'redirected', { value: true });return response; });assert.equal((await o.get()).ok, false);
    o.fetch(async () => new Response(new Uint8Array(4194305), { headers: { 'content-type': 'image/png' } }));assert.equal((await o.get()).ok, false, 'chunked responses retain their byte cap without Content-Length');
    o.fetch(async () => new Response('rate', { status: 429, headers: { 'retry-after': '120' } }));assert.equal((await o.get()).ok, false);const count = o.calls();assert.equal((await o.get()).ok, false);assert.equal(o.calls(), count);
});
test('concurrency, duplicate suppression, cancel and navigation terminate owned transports', async () => {
    const h = harness();await h.save();await h.grant();let finish;
    h.fetch((_url, { signal }) => new Promise((resolve, reject) => { finish = () => resolve(new Response('png', { headers: { 'content-type': 'image/png' } }));signal.addEventListener('abort', () => reject(new Error('abort'))); }));
    const first = h.get(), duplicate = h.get();await new Promise(resolve => setImmediate(resolve));assert.equal(h.calls(), 1);finish();assert((await first).ok);assert((await duplicate).ok);
    let aborted = false;h.fetch((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true;reject(new Error()); })));
    const active = h.get({ coordinates: { z: 2, x: 0, y: 0 } });await new Promise(resolve => setImmediate(resolve));h.relay().forgetTab(7);assert.equal((await active).ok, false);assert(aborted);
});
test('private IndexedDB keeps secrets out of extension storage and serializes durable budget updates', async () => {
    const store = createCustomPrivateStore(indexedDB);try { await store.put('fixture', { secret: 'test' });assert.deepEqual(await store.get('fixture'), { secret: 'test' });
        await Promise.all(Array.from({ length: 8 }, () => store.mutate('counter', value => (value || 0) + 1)));assert.equal(await store.get('counter'), 8);
        await store.put('fixture', null);assert.equal(await store.get('fixture'), undefined);
    }finally { await store.close(); }
});

test('TileJSON endpoint tokens stay private and newly discovered hosts cannot receive a credential or be fetched silently', async () => {
    const h = harness(), metadataSource = { ...source, source: { ...source.source, tiles: [], metadataUrl: 'https://tiles.example.com/meta.json' } };
    await h.save(secret, metadataSource);await h.grant();
    h.fetch(async () => new Response(JSON.stringify({ tilejson: '3.0.0', minzoom: 1, maxzoom: 14, tiles: ['https://tiles.example.com/{z}/{x}/{y}.png?signed=SECRET_METADATA'], extra: secret[0].value }), { headers: { 'content-type': 'application/json' } }));
    const result = await h.get({ resource: 'metadata' });assert(result.ok);const visible = atob(result.bytes);
    assert(!visible.includes('SECRET_METADATA'));assert(!visible.includes(secret[0].value));assert(visible.includes('relay.bpb.example'));
    h.fetch(async () => new Response('png', { headers: { 'content-type': 'image/png' } }));assert((await h.get()).ok);assert(h.urls.at(-1)[0].includes('signed=SECRET_METADATA'));
    const foreign = harness();await foreign.save(secret, metadataSource);await foreign.grant();
    foreign.fetch(async () => new Response(JSON.stringify({ tilejson: '3.0.0', tiles: ['https://other.example.com/{z}/{x}/{y}.png?key=OTHER_SECRET'] }), { headers: { 'content-type': 'application/json' } }));
    assert.equal((await foreign.get({ resource: 'metadata' })).ok, false);assert.equal(foreign.calls(), 1);
});

test('failed configuration writes preserve the previous private revision and restored descriptors cannot resurrect credentials', async () => {
    const h = harness();await h.save();const original = await h.catalog.snapshot();
    // Simulate a private next revision written before a failed public commit.
    const previous = await h.privateStore.get(id);await h.privateStore.put(id, { versions: { ...previous.versions, 2: { source: { ...source, revision: 2 },parameters: [{ key: 'api_key',value: 'next' }], public: publicPrivateSource({ ...source,revision: 2 }) } } });
    const restored = await h.catalog.handle({ type: 'CUSTOM_OVERLAYS_GET' }, h.editor);assert.deepEqual(restored.registry.sources[0].requestParameters, secret);
    const backup = customLayerBackup(original);assert((await h.catalog.replaceIfCurrent(original, backup)).replaced);
    const disconnected = await h.catalog.handle({ type: 'CUSTOM_OVERLAYS_GET' }, h.editor);assert.equal(disconnected.registry.sources[0].reconnect, true);
    assert.equal((await h.get()).ok, false);
});

test('opening an approval tab does not invalidate its own pending review, but closing it does', async () => {
    const h = harness();await h.save();assert((await h.relay().handle({ type: 'CUSTOM_PRIVATE_OPEN', id, revision: 1, activationToken: 'trusted' }, page)).ok);
    h.relay().forgetTab(99, false);assert((await h.relay().handle({ type: 'CUSTOM_PRIVATE_REVIEW', token: h.token() }, access)).ok);
    h.relay().forgetTab(99);assert.equal((await h.relay().handle({ type: 'CUSTOM_PRIVATE_APPROVE', token: h.token() }, access)).ok, false);
});

test('a cancelled duplicate leaves its sibling alive, all cancellations abort; only four transports can run', async () => {
    const h = harness();await h.save();await h.grant();const active = [];
    h.fetch((_url, { signal }) => new Promise((resolve, reject) => { active.push({ done: () => resolve(new Response('png', { headers: { 'content-type': 'image/png' } })), signal });signal.addEventListener('abort', () => reject(new Error())); }));
    const a = h.get({ requestId: 'cancel-first' }), b = h.get({ requestId: 'sibling' });await new Promise(resolve => setImmediate(resolve));
    await h.relay().handle({ type: 'CUSTOM_PRIVATE_CANCEL', requestId: 'cancel-first' }, page);assert.equal((await a).ok, false);assert.equal(active[0].signal.aborted, false);
    active[0].done();assert((await b).ok);
    const rest = Array.from({ length: 4 }, (_, x) => h.get({ coordinates: { z: 3, x, y: 0 } }));await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.get({ coordinates: { z: 3, x: 5, y: 0 } })).code, 'busy');
    h.relay().revoke();assert((await Promise.all(rest)).every(reply => !reply.ok));assert(active.slice(1).every(item => item.signal.aborted));
});

test('untrusted readers cannot label arbitrary URLs as private; removing parameters never silently declassifies signed URLs', async () => {
    const h = harness();await h.save();
    const schema = await import('../../src/maps/custom-overlay-schema.js');
    assert.equal(schema.readCustomSource({ ...source, privateRequests: true }), null);
    const projected = publicPrivateSource(source);projected.source.tiles[0] += '?api_key=LEAK';assert.equal(schema.readCustomSource(projected), null);
    assert((await h.save([], source, 1)).ok);const retained = await h.privateStore.get(id);assert.deepEqual(retained.versions[2].parameters, []);assert.equal(retained.versions[1], undefined, 'committed removal erases the previous key');assert((await h.catalog.snapshot()).registry.sources[0].privateRequests);
    assert((await h.save(secret, source, 2)).ok);assert((await h.catalog.handle({ type: 'CUSTOM_OVERLAYS_REMOVE', id, expectedRevision: 3 }, h.editor)).ok);
    assert.equal(await h.privateStore.get(id), undefined);
});


test('two explicitly approved tabs and separate layers share one durable provider budget', async () => {
    const h = harness();await h.save();await h.grant();
    const otherId = 'custom:1537a032-271c-4d11-9b8c-0edc566b47c1', otherPage = { ...page, documentId: 'doc-other', tab: { ...page.tab, id: 9 } };
    assert((await h.catalog.handle({ type: 'CUSTOM_OVERLAYS_SAVE',id: otherId,source: { ...source,id: otherId },expectedRevision: 0,requestParameters: secret }, h.editor)).ok);
    await h.grant(otherId, otherPage);
    h.privateRecords.set('budget:tiles.example.com', { start: 1000000,hour: 1000000,last: 1000000,daily: 0,hourly: 1023 });
    assert((await h.get()).ok);assert.equal((await h.get({ id: otherId }, otherPage)).code, 'budget');assert.equal(h.calls(), 1);
});

test('a corrupt durable ledger fails closed instead of turning counters into NaN', async () => {
    const h = harness();await h.save();await h.grant();h.privateRecords.set('budget:tiles.example.com', {});
    assert.equal((await h.get()).code, 'budget');assert.equal(h.calls(), 0);
});
