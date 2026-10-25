// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCustomOverlayControl } from '../../src/maps/custom-overlay-control.js';

test('custom menu links to Settings and reuses ordered source rows without changing selection', () => {
    const dom = new JSDOM('<main></main>', { url: 'https://www.peakbagger.com/map/MasterMap.aspx', pretendToBeVisual: true });
    const win = dom.window, panel = win.document.querySelector('main');
    const owner = createCustomOverlayControl({ win, panel, readView: () => ({ zoom: 12 }) });
    const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Topo', kind: 'raster',
        source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
        approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };
    const second = { ...source, id: 'custom:1537a032-271c-4d11-9b8c-0edc566b47c1', name: 'Contours' };
    const announce = sources => win.dispatchEvent(new win.MessageEvent('message', { source: win, origin: win.location.origin, data: { __bpbCustomOverlays: true,
        dir: 'toPage', type: 'registry', settingsUrl: 'chrome-extension://test-extension/options/options.html#custom-map-layers', registry: { schemaVersion: 1, revision: 1, sources }, preferences: {} } }));
    try {
        announce([source, second]);
        const link = panel.querySelector('.bpb-custom-header a'); assert.equal(link.textContent, 'Add custom layer…'); assert.match(link.href, /options\/options.html#custom-map-layers$/);
        assert.equal(panel.querySelector('[data-bpb-custom-editor]'), null, 'menu has no inline editor trigger');
        const check = panel.querySelector('input[aria-label="Topo"]'); check.click(); check.focus();
        const row = check.closest('details'); announce([second, source]);
        assert.strictEqual(panel.querySelectorAll('.bpb-custom-source')[1], row); assert.equal(check.checked, true); assert.strictEqual(win.document.activeElement, check);
        assert.equal(owner.snapshot().custom[0].id, source.id);
    } finally { owner.dispose(); win.close(); }
});
