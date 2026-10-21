// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { createMapLayerControl } from '../../src/maps/map-layer-control.js';

test('overlay schema bounds device-local alpha and fails closed on enablement', () => {
    const state = Schema.mapOverlayState({ sentinel: { enabled: 'true', opacity: NaN }, slope: { enabled: true, opacity: 112 }, land: { opacity: -3 }, snotel: { enabled: true, opacity: 0 } });
    assert.deepEqual(state, { sentinel: { enabled: false, opacity: 100 }, slope: { enabled: true, opacity: 100 }, land: { enabled: false, opacity: 0 }, snotel: { enabled: true, opacity: 100 } });
    assert.deepEqual(Schema.mapOverlayState(state), state);
    assert.equal(Object.hasOwn(Schema.DEFAULTS, 'mapOverlays'), false, 'overlay enablement is not a synced preference');
});

test('compact Layers control separates collapse, enablement and one detail selection', () => {
    const dom = new JSDOM('<body></body>'), document = dom.window.document;
    const changes = [], opacity = [], bases = [];
    const control = createMapLayerControl({ document, onToggle: (...args) => changes.push(args), onOpacity: (...args) => opacity.push(args), onBasemap: id => bases.push(id) });
    document.body.append(control.element);
    const state = Schema.mapOverlayState({ slope: { enabled: true, opacity: 60 } });
    const model = { state, basemaps: [{ id: 'topo', label: 'Topographic' }, { id: 'image', label: 'Imagery' }], basemap: 'topo' };
    control.render(model);
    const panel = document.querySelector('.bpb-layers-panel'), well = document.querySelector('.bpb-layers-details');
    assert.equal(panel.hidden, true);
    control.trigger.click(); assert.equal(panel.hidden, false); assert.equal(well.hidden, true);
    const row = id => document.querySelector(`[data-layer='${id}']`);
    row('land').querySelector('input').click(); assert.deepEqual(changes, [['land', true]]); assert.equal(well.hidden, true);
    row('slope').querySelector('button').click(); assert.equal(well.hidden, false);
    assert.equal(document.querySelectorAll('.bpb-layers-detail:not([hidden])').length, 1);
    const slider = document.querySelector('input[aria-label="Slope angle opacity"]');
    slider.value = '43'; slider.dispatchEvent(new dom.window.Event('input')); assert.deepEqual(opacity, [['slope', 43]]);
    slider.focus(); control.render({ ...model, statuses: { slope: { pending: true, message: 'Loading slope…' } } });
    assert.equal(document.activeElement, slider, 'async status preserves the active slider');
    row('sentinel').querySelector('button').click(); assert.equal(document.querySelectorAll('.bpb-layers-detail:not([hidden])').length, 1);
    assert.equal(slider.closest('section').hidden, true);
    control.trigger.click(); assert.equal(panel.hidden, true); assert.equal(state.slope.enabled, true);
    control.trigger.click(); assert.equal(well.hidden, true, 'reopen is the compact overview');
    const base = document.querySelector('select[aria-label="Base map"]'); base.value = 'image'; base.dispatchEvent(new dom.window.Event('change')); assert.deepEqual(bases, ['image']);
    control.trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(panel.hidden, true); assert.equal(document.activeElement, control.trigger);
    control.dispose(); assert.equal(document.querySelector('.bpb-map-layers'), null); dom.window.close();
});
