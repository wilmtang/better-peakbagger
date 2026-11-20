// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureDom, browserWindow } from '../helpers/fixture-dom.mts';
import { assertMapToggleAnchor } from '../../scripts/page-probes.mts';
import { readTerrainToggleReadiness } from '../../scripts/terrain-toggle-readiness.mts';

// The native map frame keeps its MasterMap src, which the probe finds it by,
// while srcdoc supplies its document without a network load. Its border is
// zero here; the border case sets clientTop itself.
async function fixture() {
    const dom = new FixtureDom('<button id="bpb-terrain-toggle" aria-pressed="false">3D</button>'
        + '<iframe src="/map/MasterMap.aspx" style="border:0"'
        + ' srcdoc="<!doctype html><html><body><div class=&quot;leaflet-control-zoom&quot;></div></body></html>"></iframe>',
    { url: 'https://www.peakbagger.com/peak.aspx' });
    const win = browserWindow(dom.window), toggle = win.document.querySelector<HTMLButtonElement>('button')!;
    const frame = win.document.querySelector('iframe')!;
    await new Promise(resolve => {
        if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.querySelector('.leaflet-control-zoom')) resolve(null);
        else frame.addEventListener('load', resolve, { once: true });
    });
    const nativeWindow = frame.contentWindow as (Window & typeof globalThis & { mapsPlaceholder?: object });
    Object.defineProperty(nativeWindow, 'mapsPlaceholder', { value: {}, configurable: true });
    const zoom = nativeWindow.document.querySelector<HTMLElement>('.leaflet-control-zoom')!;
    const rect = (node: Element, top: number, width = 44, height = 32) => {
        node.getBoundingClientRect = () => new win.DOMRect(729, top, width, height);
    };
    rect(frame, 100, 760, 425);
    rect(zoom, 318, 32, 63);
    const position = (top: number) => rect(toggle, top);
    position(390); // CSS fallback: toggle bottom422, native zoom top418 → -4px.
    const read = () => win.eval(`(${readTerrainToggleReadiness.toString()})()`) as ReturnType<typeof readTerrainToggleReadiness>;
    return { dom, toggle, frame, zoom, nativeWindow, position, rect, read };
}

test('settled baseline rejects the CSS fallback overlap and accepts the public eight-pixel gap', async () => {
    const env = await fixture();
    try {
        const fallback = env.read();
        assert.equal(fallback.nativeReady, true);
        assert.equal(fallback.gap, -4);
        assert.equal(fallback.ready, false);
        env.position(378);
        const positioned = env.read();
        assert.equal(positioned.gap, 8);
        assert.equal(positioned.ready, true);
        env.position(379);
        assert.equal(env.read().ready, true, 'one-pixel rounding is allowed');
        env.position(380);
        assert.equal(env.read().ready, false);
    } finally { env.dom.window.close(); }
});

test('missing, zero-sized, unavailable or hidden public controls cannot establish readiness', async () => {
    for (const change of [
        (env: Awaited<ReturnType<typeof fixture>>) => { Reflect.deleteProperty(env.nativeWindow, 'mapsPlaceholder'); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.zoom.remove(); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.rect(env.zoom, 318, 0, 63); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.rect(env.frame, 100, 760, 0); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.rect(env.toggle, 378, 0, 32); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.disabled = true; },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.setAttribute('aria-busy', 'true'); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.setAttribute('aria-pressed', 'true'); env.toggle.textContent = '2D'; },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.removeAttribute('aria-pressed'); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.hidden = true; },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.style.visibility = 'hidden'; },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.zoom.style.display = 'none'; },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.frame.style.visibility = 'hidden'; },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.rect(env.toggle, 378, Infinity, 32); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.frame.remove(); },
        (env: Awaited<ReturnType<typeof fixture>>) => { env.toggle.remove(); },
    ]) {
        const env = await fixture();
        try { env.position(378); change(env); assert.equal(env.read().ready, false); }
        finally { env.dom.window.close(); }
    }
});

test('initial asynchronous positioning may settle, while later mode-switch movement still fails the original assertion', async () => {
    const env = await fixture();
    try {
        assert.equal(env.read().ready, false);
        await new Promise<void>(resolve => queueMicrotask(() => { env.position(378); resolve(); }));
        const before = env.read();
        assert.equal(before.ready, true);
        assert.doesNotThrow(() => assertMapToggleAnchor(before, env.read()));
        env.position(366);
        await assert.rejects(Promise.resolve().then(() => assertMapToggleAnchor(before, env.read())), /moved or resized/);
    } finally { env.dom.window.close(); }
});


test('native zoom coordinates include the iframe content border in the parent viewport', async () => {
    const env = await fixture();
    try {
        Object.defineProperty(env.frame, 'clientTop', { value: 2 });
        env.frame.id = 'Gmap';
        env.position(380); // 100px iframe + 2px border + 318px zoom - 412px button bottom.
        const state = env.read();
        assert.equal(state.gap, 8);
        assert.equal(state.ready, true);
        assert.equal(state.nativeFrameId, 'Gmap');
        assert.equal(state.nativeFrameConnected, true);
        assert.ok(['loading', 'interactive', 'complete'].includes(state.nativeDocumentReadyState));
        env.position(382);
        assert.equal(env.read().gap, 6);
        assert.equal(env.read().ready, false);
    } finally { env.dom.window.close(); }
});
