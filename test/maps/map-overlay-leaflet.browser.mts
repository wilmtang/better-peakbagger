// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createLeafletOverlays, type LeafletOverlayMap, type LeafletOverlayWindow } from '../../src/maps/map-overlay-leaflet.ts';
import type { OverlayActivityState, OverlayTileError } from '../../src/maps/map-overlay-tiles.ts';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { waitFor } from '../helpers/fixture-page.mts';

const waitUntil = (predicate: () => unknown) => waitFor({ window }, predicate);
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

type FakeCanvas = { painted: string | number; getContext(): { clearRect(): void; drawImage(image: { painted?: string }): void } };
type TileUnload = (event: { tile: FakeCanvas }) => void;
type Coordinates = { z: number; x: number; y: number };
// The overlay owner's createTile, which extend() mixes into each fake grid.
type CreateTile = (coordinates: Coordinates, done: (error?: Error) => void) => FakeCanvas;
const gridLayer = (Grid: { prototype: object }) => ({
    extend(methods: object) {
        const Subclass = function (this: unknown, ...args: unknown[]) {
            return Reflect.construct(Grid as new (...params: unknown[]) => object, args, new.target);
        };
        Subclass.prototype = Object.create(Grid.prototype);
        Object.assign(Subclass.prototype, methods);
        return Subclass;
    },
});
// The fakes implement only the window and map members the overlay owner uses.
const overlayWindow = (win: object) => win as unknown as LeafletOverlayWindow;
const overlayMap = (map: object) => map as unknown as LeafletOverlayMap;
const stubImageBitmap = (t: TestContext, bitmap: (source: Blob) => Promise<object>) => {
    const scope = globalThis as { createImageBitmap?: unknown };
    const previous = scope.createImageBitmap;
    scope.createImageBitmap = bitmap;
    t.after(() => { if (previous === undefined) delete scope.createImageBitmap; else scope.createImageBitmap = previous; });
};

test('scene refresh retains native canvases and stale or failed replacements cannot erase painted imagery', async t => {
    stubImageBitmap(t, async blob => ({ width: 256, height: 256, painted: await blob.text(), close() {} }));
    const held: { signal: AbortSignal; image: () => Response; resolve: (response: Response) => void }[] = [];
    const mounted = new Set<Grid>(); let hold = false;
    const document = { createElement: () => {
        const canvas: FakeCanvas = { painted: '', getContext: () => ({ clearRect() { canvas.painted = ''; }, drawImage(image) { canvas.painted = image.painted ?? ''; } }) };
        return canvas;
    } };
    class Grid {
        declare createTile: CreateTile;
        events: Record<string, TileUnload> = {}; ready = 0; canvas?: FakeCanvas;
        options: Record<string, unknown>;
        constructor(options: Record<string, unknown>) { this.options = options; }
        on(name: string, callback: TileUnload) { this.events[name] = callback; }
        setOpacity(value: number) { this.options.opacity = value; return this; }
        addTo() { mounted.add(this); this.canvas = this.createTile({ z: 14, x: 2666, y: 5796 }, () => this.ready++); }
    }
    const map = { getPane: () => ({}), removeLayer(layer: Grid) { mounted.delete(layer); layer.events.tileunload!({ tile: layer.canvas! }); } };
    const win = { document, addEventListener() {}, removeEventListener() {}, fetch: (url: string, { signal }: { signal: AbortSignal }) => {
        const image = () => new Response(new URL(url).searchParams.get('item') || 'other', { headers: { 'content-type': 'image/png' } });
        if (!hold) return Promise.resolve(image());
        return new Promise<Response>(resolve => held.push({ signal, image, resolve }));
    }, L: { GridLayer: gridLayer(Grid) } };
    const activity = new Map<string, OverlayActivityState>();
    const owner = createLeafletOverlays({ win: overlayWindow(win), map: overlayMap(map),
        onActivity: (id, state) => { activity.set(id, state); } });
    const scene = (id: string) => [{ id, bounds: [-122, 46, -121, 47] }];
    try {
        for (const id of ['land', 'slope']) owner.set(id, { enabled: true, opacity: 37 });
        owner.scenes(scene('original'), 60);
        await waitUntil(() => ['land', 'slope', 'sentinel'].every(id => activity.get(id)?.complete)
            && [...mounted].every(item => item.ready === 1));
        const layers = [...mounted], layer = layers.find(item => item.options.pane === 'bpb-overlay-sentinel')!, canvas = layer.canvas!;
        assert.equal(canvas.painted, 'original'); assert.equal(layer.ready, 1);
        hold = true; owner.scenes(scene('stale'), 60);
        await waitUntil(() => held.length === 1 && activity.get('sentinel')?.pending);
        assert.deepEqual([...mounted], layers, 'catalog changes preserve every layer');
        assert.equal(canvas.painted, 'original');
        owner.scenes(scene('current'), 60);
        await waitUntil(() => held.length === 2);
        assert.equal(held[0]!.signal.aborted, true);
        held[0]!.resolve(held[0]!.image()); await nextTurn(); assert.equal(canvas.painted, 'original');
        held[1]!.resolve(new Response('', { status: 404 }));
        await waitUntil(() => !activity.get('sentinel')?.pending && activity.get('sentinel')?.error);
        assert.equal(canvas.painted, 'original', 'a failed replacement preserves last good pixels');
        hold = false; owner.retry('sentinel');
        await waitUntil(() => activity.get('sentinel')?.complete);
        assert.equal(layer.canvas, canvas); assert.equal(canvas.painted, 'current');
        assert.equal(layer.ready, 1, 'repainting a ready canvas never restarts Leaflet tile fading');
        for (const id of ['land', 'slope']) owner.retry(id);
        await waitUntil(() => ['land', 'slope'].every(id => activity.get(id)?.complete));
        assert.ok(layers.every(item => item.ready === 1), 'successful land/slope reloads also avoid another ready/fade callback');
        assert.deepEqual([...mounted], layers);
        owner.clearSentinel(); assert.equal(mounted.has(layer), false, 'explicit clearing still removes stale imagery');
    } finally { owner.dispose(); }
});

for (const id of ['slope', 'land', 'snow']) for (const toggled of [false, true]) test(`${id} retry mounts a cooldown-blocked layer${toggled ? ' after off/on' : ' from a handoff'} at its saved opacity`, async t => {
    let now = Date.now(), requests = 0;
    t.mock.method(Date, 'now', () => now);
    stubImageBitmap(t, async () => ({ width: 256, height: 256, close() {} }));
    const opacities: number[] = [], activity: { complete?: boolean }[] = [];
    const document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }) }) };
    const map = { getPane: () => ({}), removeLayer() {} };
    const win = { document, addEventListener() {}, removeEventListener() {}, fetch: async () => {
        requests++; return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    }, L: { GridLayer: gridLayer(class {
        declare createTile: CreateTile;
        on() {} setOpacity(value: number) { opacities.push(value); }
        addTo() { this.createTile({ z: 14, x: 2666, y: 5796 }, () => {}); }
    }) } };
    const owner = createLeafletOverlays({ win: overlayWindow(win), map: overlayMap(map), onActivity: (_id, value) => { activity.push(value); } });
    const state = { enabled: true, opacity: 37, retryAt: now + 120000 };
    try {
        owner.set(id, state);
        if (toggled) { owner.set(id, { ...state, enabled: false }); owner.set(id, state); }
        owner.retry(id); await nextTurn(); assert.equal(requests, 0, 'retry respects the active handoff cooldown');
        now = state.retryAt + 1; owner.retry(id);
        await waitUntil(() => activity.at(-1)?.complete === true);
        assert.equal(requests, 1, 'retry requests tiles even when no layer was mounted');
        assert.deepEqual(opacities, [.37]);
        assert.equal(activity.at(-1)?.complete, true, 'loading settles after the requested tile paints');
        owner.set(id, { ...state, enabled: false }); owner.retry(id); await nextTurn();
        assert.equal(requests, 1, 'retry cannot restore a disabled layer');
        owner.set(id, { ...state, opacity: 0 }); owner.retry(id); await nextTurn();
        assert.equal(requests, 1, 'retry cannot restore a fully transparent layer');
    } finally { owner.dispose(); }
});

test('native station membership updates preserve the open popup, marker and focused NRCS link', () => {
    const dom = new FixtureDom('<body></body>'), win = dom.window;
    const markers: { content?: HTMLElement }[] = [], groups: unknown[] = [], removed: unknown[] = [];
    const station = { id: '679:WA:SNTL', name: 'Paradise', latitude: 46.78, longitude: -121.74, elevation: 1570 };
    win.fetch = async () => { throw new Error('Unexpected fetch'); };
    (win as unknown as { L: unknown }).L = { layerGroup: () => { const group = { addTo() { groups.push(this); }, removeLayer() {} }; return group; },
        marker: () => {
            const marker: { content?: HTMLElement; bindPopup(content: HTMLElement): typeof marker; addTo(): typeof marker } = {
                bindPopup(content) { this.content = content; return this; }, addTo() { markers.push(this); return this; } };
            return marker;
        },
        divIcon: () => ({}) };
    const owner = createLeafletOverlays({ win: overlayWindow(win), map: overlayMap({ removeLayer: (layer: unknown) => removed.push(layer) }) });
    try {
        owner.stations([station]); win.document.body.append(markers[0]!.content!);
        const link = markers[0]!.content!.querySelector('a')!; link.focus();
        owner.stations([station], { selectable: new Set([station.id]), onSelect() {} });
        assert.equal(markers.length, 1, 'membership changes must not replace an open marker');
        assert.equal(removed.length, 0, 'the existing popup remains on the map');
        assert.equal(win.document.activeElement, link, 'the NRCS link keeps focus');
        const action = markers[0]!.content!.querySelector('button'); assert.ok(action); action.focus();
        owner.stations([station]);
        assert.equal(markers[0]!.content!.querySelector('button'), null);
        assert.equal(win.document.activeElement, link, 'revoking a focused action falls back to the same station link');
    } finally { owner.dispose(); win.close(); }
});

for (const id of ['slope', 'land', 'snow', 'sentinel']) test(`${id} retry fills missing tiles while leaving successful native canvases in place`, async t => {
    stubImageBitmap(t, async () => ({ width: 256, height: 256, close() {} }));
    let now = Date.now(), calls = 0, limited = 0;
    const held: (((response: Response) => void) | null)[] = [], canvases: FakeCanvas[] = [], done = new Map<FakeCanvas, string>();
    t.mock.method(Date, 'now', () => now);
    const document = { createElement: () => {
        const canvas: FakeCanvas & { painted: number } = { painted: 0, getContext: () => ({ clearRect() {}, drawImage() { canvas.painted++; } }) };
        return canvas;
    } };
    const image = () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    const map = { getPane: () => ({}), removeLayer(current: Grid) { for (const canvas of canvases) current.events.tileunload!({ tile: canvas }); } };
    class Grid {
        declare createTile: CreateTile;
        events: Record<string, TileUnload> = {};
        on(name: string, callback: TileUnload) { this.events[name] = callback; }
        setOpacity() { return this; }
        redraw() { for (const canvas of canvases) canvas.painted = 0; this.addTo(); }
        addTo() {
            for (let x = 2666; x < 2669; x++) {
                const canvas = this.createTile({ z: 14, x, y: 5796 }, error => done.set(canvas, error?.name || 'loaded')); canvases.push(canvas);
            }
        }
    }
    const win = { document, addEventListener() {}, removeEventListener() {}, fetch: (_url: string, { signal }: { signal: AbortSignal }) => {
        calls++; if (calls === 2 || calls > 3) return Promise.resolve(image());
        if (id === 'land' && calls === 1) { held.push(null); return Promise.resolve(new Response('', { status: 404 })); }
        return new Promise<Response>((resolve, reject) => {
            held.push(resolve); signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true });
        });
    }, L: { GridLayer: gridLayer(Grid) } };
    const owner = createLeafletOverlays({ win: overlayWindow(win), map: overlayMap(map),
        onError: (_id, error: OverlayTileError) => { limited = error.retryAt ?? 0; } });
    try {
        if (id === 'sentinel') owner.scenes([{ id: 'scene_new', bounds: [-122, 46, -121, 47] }], 60);
        else owner.set(id, { enabled: true, opacity: 60 });
        await waitUntil(() => canvases.length === 3 && done.get(canvases[1]!) === 'loaded' && held.length === 2);
        const painted = canvases[1]!.painted; assert.ok(Number(painted) > 0);
        held[1]!(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
        await waitUntil(() => done.has(canvases[0]!) && done.has(canvases[2]!) && limited > 0);
        assert.equal(done.get(canvases[0]!), id === 'land' ? 'Error' : 'AbortError'); assert.equal(done.get(canvases[2]!), 'RateLimitError');
        owner.retry(id); await nextTurn(); assert.equal(calls, 3, 'the provider cooldown cannot be bypassed');
        now = limited + 1; owner.retry(id);
        await waitUntil(() => canvases.every(canvas => done.get(canvas) === 'loaded'));
        assert.equal(canvases[1]!.painted, painted, 'successful shading is untouched');
        assert.equal(calls, 5, 'both the rejected tile and its aborted neighbor are retried');
        assert.ok(canvases.every(canvas => done.get(canvas) === 'loaded'));
    } finally { owner.dispose(); }
});
