// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeafletOverlays } from '../../src/maps/map-overlay-leaflet.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('slope retry fills rate-limit-aborted holes while leaving successful native canvases in place', async t => {
    const oldBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    t.after(() => { if (oldBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = oldBitmap; });
    let now = Date.now(), calls = 0, limited; const held = [], canvases = [], done = new Map();
    t.mock.method(Date, 'now', () => now);
    const document = { createElement: () => {
        const canvas = { painted: 0 }; canvas.getContext = () => ({ clearRect() {}, drawImage() { canvas.painted++; } }); return canvas;
    } };
    const image = () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    const map = { getPane: () => ({}), removeLayer(current) { for (const canvas of canvases) current.events.tileunload({ tile: canvas }); } };
    const win = { document, addEventListener() {}, removeEventListener() {}, fetch: (_url, { signal }) => {
        calls++; if (calls === 2 || calls > 3) return Promise.resolve(image());
        return new Promise((resolve, reject) => {
            held.push(resolve); signal.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true });
        });
    }, L: { GridLayer: { extend(methods) {
        class Grid {
            constructor() { this.events = {}; }
            on(name, callback) { this.events[name] = callback; }
            setOpacity() { return this; }
            redraw() { for (const canvas of canvases) canvas.painted = 0; this.addTo(); }
            addTo() {
                for (let x = 2666; x < 2669; x++) {
                    const canvas = this.createTile({ z: 14, x, y: 5796 }, error => done.set(canvas, error?.name || 'loaded')); canvases.push(canvas);
                }
            }
        }
        Object.assign(Grid.prototype, methods); return Grid;
    } } } };
    const owner = createLeafletOverlays({ win, map, onError: (_id, error) => { limited = error.retryAt; } });
    try {
        owner.set('slope', { enabled: true, opacity: 60 }); await tick();
        const painted = canvases[1].painted; assert.ok(painted > 0);
        held[1](new Response('', { status: 429, headers: { 'retry-after': '120' } })); await tick();
        assert.equal(done.get(canvases[0]), 'AbortError'); assert.equal(done.get(canvases[2]), 'RateLimitError');
        owner.retry('slope'); assert.equal(calls, 3, 'the provider cooldown cannot be bypassed');
        now = limited + 1; owner.retry('slope'); await tick();
        assert.equal(canvases[1].painted, painted, 'successful shading is untouched');
        assert.equal(calls, 5, 'both the rejected tile and its aborted neighbor are retried');
        assert.ok(canvases.every(canvas => done.get(canvas) === 'loaded'));
    } finally { owner.dispose(); }
});
