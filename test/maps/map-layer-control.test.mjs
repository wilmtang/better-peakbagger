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

test('compact Overlays control separates collapse, enablement and one detail selection', () => {
    const dom = new JSDOM('<body></body>'), document = dom.window.document;
    const changes = [], opacity = [];
    const control = createMapLayerControl({ document, onToggle: (...args) => changes.push(args), onOpacity: (...args) => opacity.push(args) });
    document.body.append(control.element);
    const state = Schema.mapOverlayState({ slope: { enabled: true, opacity: 60 } });
    const model = { state };
    control.render(model);
    assert.equal(control.trigger.textContent, 'Overlays');
    assert.equal(control.trigger.getAttribute('aria-label'), 'Overlays, 1 active');
    const panel = document.querySelector('.bpb-layers-panel'), well = document.querySelector('.bpb-layers-details');
    assert.equal(panel.hidden, true);
    control.trigger.click(); assert.equal(panel.hidden, false); assert.equal(well.hidden, true);
    const row = id => document.querySelector(`[data-layer='${id}']`);
    row('land').querySelector('input').click(); assert.deepEqual(changes, [['land', true]]); assert.equal(well.hidden, false);
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
    assert.equal(panel.querySelector('[aria-label="Base map"]'), null, 'basemap stays outside the overlay menu');
    control.trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(panel.hidden, false, 'Escape does not collapse the disclosure');
    control.dispose(); assert.equal(document.querySelector('.bpb-map-layers'), null); dom.window.close();
});

test('toggling a layer selects its matching details without changing other layers or following async updates', () => {
    const dom = new JSDOM('<body></body>'), doc = dom.window.document;
    const state = Schema.mapOverlayState({ slope: { enabled: true } }); let statuses = {};
    const control = createMapLayerControl({ document: doc, onToggle(id, enabled) { state[id].enabled = enabled; control.render({ state, statuses }); } });
    doc.body.append(control.element); control.render({ state, statuses }); control.trigger.click();
    doc.querySelector('[data-layer="slope"] button').click();
    const selected = name => {
        const detail = doc.querySelector('.bpb-layers-detail:not([hidden])');
        assert.equal(detail?.getAttribute('aria-label'), `${name} settings`, 'visible settings must match the layer the user just toggled');
    };
    doc.querySelector('[data-layer="land"] input').click(); selected('Public lands');
    assert.equal(state.slope.enabled, true, 'multiple overlays stay enabled independently');
    const land = doc.querySelector('[data-layer="land"]');
    assert.equal(land.dataset.selected, 'true'); assert.equal(land.querySelector('button').getAttribute('aria-expanded'), 'true');
    const slider = doc.querySelector('[aria-label="Public lands opacity"]'); slider.focus();
    statuses = { slope: { pending: true, message: 'Loading slope…' } }; control.render({ state, statuses }); selected('Public lands');
    assert.equal(doc.activeElement, slider, 'an unrelated provider reply cannot steal the selected detail or focus');
    land.querySelector('input').click(); selected('Public lands'); assert.equal(slider.disabled, true, 'turning a layer off keeps its own disabled settings visible');
    doc.querySelector('[data-layer="snotel"] input').click(); selected('SNOTEL stations');
    assert.equal(land.dataset.selected, 'false');
    control.trigger.click(); control.trigger.click(); assert.equal(doc.querySelector('.bpb-layers-details').hidden, true, 'reopening still starts compact');
    control.dispose(); dom.window.close();
});

test('opacity summaries name the property and sliders explain their direction', () => {
    const dom = new JSDOM('<body></body>'), doc = dom.window.document;
    const control = createMapLayerControl({ document: doc }); doc.body.append(control.element);
    control.render({ state: Schema.mapOverlayState({ land: { opacity: 35 } }) }); control.trigger.click();
    for (const id of ['sentinel', 'slope', 'land']) assert.equal(doc.querySelector(`[data-layer="${id}"] .bpb-layers-value-label`)?.textContent, 'Opacity');
    assert.equal(doc.querySelector('[data-layer="snotel"] .bpb-layers-value-label'), null, 'station counts are not called opacity');
    doc.querySelector('[data-layer="land"] button').click();
    assert.deepEqual([...doc.querySelector('.bpb-layers-detail:not([hidden]) .bpb-layers-opacity-ends').children].map(element => element.textContent), ['Clear', 'Solid']);
    assert.equal(doc.querySelector('[aria-label="Public lands opacity"]').getAttribute('aria-valuetext'), '35 percent opacity');
    control.dispose(); dom.window.close();
});

test('layer rows explain loading, failure and access without hiding controls or stale off-state warnings', () => {
    const dom = new JSDOM('<body></body>'), doc = dom.window.document, retries = [];
    const control = createMapLayerControl({ document: doc, onRetry: id => retries.push(id) }); doc.body.append(control.element);
    const state = Schema.mapOverlayState({ land: { enabled: true } });
    const render = status => control.render({ state, statuses: { land: status } });
    render({ pending: true, message: 'Loading public lands' }); control.trigger.click(); doc.querySelector('[data-layer="land"] button').click();
    const row = doc.querySelector('[data-layer="land"]'), button = row.querySelector('button');
    assert.equal(row.querySelector('.bpb-layers-row-status')?.textContent, 'Loading');
    assert.equal(button.getAttribute('aria-busy'), 'true'); assert.equal(button.disabled, false, 'settings remain available during loading');
    render({ error: true, retry: true, message: 'Some tiles could not load.' });
    assert.equal(row.querySelector('.bpb-layers-row-status').textContent, 'Couldn’t load');
    const retry = doc.querySelector('.bpb-layers-detail:not([hidden]) .bpb-layers-retry'); retry.focus(); retry.click(); assert.deepEqual(retries, ['land']);
    render({ pending: true, retry: true, message: 'Loading public lands' }); retry.click(); assert.deepEqual(retries, ['land']);
    assert.equal(doc.activeElement, retry, 'retry retains focus while its request is pending');
    render({ permission: true, error: true, retry: true, message: 'Allow BC parcel maps.' });
    assert.equal(row.querySelector('.bpb-layers-row-status').textContent, 'Needs access');
    state.land.enabled = false; render({ error: true, retry: true, message: 'Previous failure' });
    assert.equal(row.dataset.status, ''); assert.equal(row.querySelector('.bpb-layers-row-status').hidden, true);
    assert.equal(doc.querySelector('.bpb-layers-detail:not([hidden]) .bpb-layers-feedback').textContent.includes('Previous failure'), false);
    state.land.enabled = true; render({}); assert.equal(row.querySelector('.bpb-layers-value').hidden, false);
    assert.equal(row.querySelector('.bpb-layers-value').textContent, 'Opacity25%');
    control.dispose(); dom.window.close();
});
test('successful recovery keeps a focused action anchored as Reload until the user leaves it', () => {
    const dom = new JSDOM('<body></body>'), doc = dom.window.document, requests = [];
    const control = createMapLayerControl({ document: doc, onRetry: id => requests.push(id) }); doc.body.append(control.element);
    const state = Schema.mapOverlayState({ slope: { enabled: true } });
    const render = status => control.render({ state, statuses: { slope: status } });
    render({ error: true, retry: true }); control.trigger.click(); doc.querySelector('[data-layer="slope"] button').click();
    const action = doc.querySelector('.bpb-layers-detail:not([hidden]) .bpb-layers-retry'); action.focus(); action.click();
    render({ pending: true, retry: true }); action.click(); assert.equal(requests.length, 1);
    render({}); assert.equal(action.hidden, false); assert.equal(action.textContent, 'Reload'); assert.equal(doc.activeElement, action);
    assert.equal(doc.querySelector('.bpb-layers-feedback[data-kind="success"] span').textContent, 'Overlay refreshed.');
    action.click(); assert.equal(requests.length, 2, 'Reload is an actual refresh action rather than a clickable-looking success label');
    render({ pending: true, retry: true }); assert.equal(action.textContent, 'Reload');
    render({}); doc.querySelector('[aria-label="Slope angle opacity"]').focus(); assert.equal(action.hidden, true);
    control.dispose(); dom.window.close();
});

test('Overlays stays expanded through outside interaction and only its button collapses it', () => {
    const dom = new JSDOM('<body><button id="outside">Map action</button></body>'), document = dom.window.document;
    const control = createMapLayerControl({ document }); document.body.append(control.element);
    control.trigger.click(); document.querySelector('[data-layer="slope"] button').click();
    const outside = document.getElementById('outside'); outside.focus();
    outside.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); outside.click();
    assert.equal(control.isOpen(), true, 'outside clicks preserve the open menu');
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    outside.dispatchEvent(escape); assert.equal(escape.defaultPrevented, false);
    assert.equal(control.isOpen(), true); assert.equal(document.activeElement, outside, 'focus stays with the external action');
    control.render({ state: Schema.mapOverlayState() });
    assert.equal(document.querySelector('.bpb-layers-details').hidden, false, 'the selected detail remains open');
    control.trigger.click(); assert.equal(control.isOpen(), false);
    control.trigger.click(); assert.equal(control.isOpen(), true);
    control.dispose(); dom.window.close();
});

test('Overlays includes a decorative caret beside its accessible disclosure state', () => {
    const dom = new JSDOM('<body></body>'), control = createMapLayerControl({ document: dom.window.document });
    const caret = control.trigger.querySelector('.bpb-layers-caret');
    assert.ok(caret, 'a visible caret indicates that Overlays is collapsible');
    assert.equal(caret.getAttribute('aria-hidden'), 'true');
    assert.equal(control.trigger.getAttribute('aria-expanded'), 'false');
    control.trigger.click(); assert.equal(control.trigger.getAttribute('aria-expanded'), 'true');
    control.trigger.click(); assert.equal(control.trigger.getAttribute('aria-expanded'), 'false');
    control.dispose(); dom.window.close();
});

test('Sentinel capture choices retain cloud labels and full selected metadata', () => {
    const dom = new JSDOM('<body></body>'), selections = [];
    const control = createMapLayerControl({ document: dom.window.document, onCapture: value => selections.push(value) });
    dom.window.document.body.append(control.element);
    const captures = [
        { id: 'latest', label: 'Latest · 10-07 18:27 · ☁ 3%', title: 'Latest · 2026-10-07 18:27 PDT · Clouds 3%' },
        { id: 'older', label: '2026-10-06 18:27 · ☁ 100%', title: '2026-10-06 18:27 PDT · Clouds 100%' },
        { id: 'unknown', label: '2026-10-05 18:27 · ☁ ?', title: '2026-10-05 18:27 PDT · Clouds unknown' },
    ];
    const model = { state: Schema.mapOverlayState({ sentinel: { enabled: true } }), statuses: { sentinel: { capture: 'latest', captures } } };
    control.render(model); control.trigger.click(); dom.window.document.querySelector('[data-layer="sentinel"] button').click();
    const picker = dom.window.document.querySelector('[aria-label="Sentinel-2 capture"]');
    assert.deepEqual(Array.from(picker.options, option => option.textContent), captures.map(choice => choice.label));
    assert.equal(picker.title, captures[0].title, 'the compact closed picker exposes the full date and clouds');
    for (const choice of captures) {
        picker.value = choice.id; picker.dispatchEvent(new dom.window.Event('change'));
        assert.equal(selections.at(-1), choice.id);
        assert.equal(picker.title, choice.title, 'metadata updates immediately, before an asynchronous renderer reply');
        assert.equal(picker.selectedOptions[0].getAttribute('aria-label'), choice.title);
    }
    control.render({ ...model, statuses: { sentinel: { ...model.statuses.sentinel, capture: 'older' } } });
    assert.equal(picker.title, captures[1].title, 'renderer updates retain the same full metadata');
    control.dispose(); dom.window.close();
});

test('Public lands details offer official camping guidance without enlarging the overview', () => {
    const dom = new JSDOM('<body></body>'), doc = dom.window.document;
    const control = createMapLayerControl({ document: doc }); doc.body.append(control.element);
    control.trigger.click();
    const guidance = doc.querySelector('a[href="https://www.blm.gov/programs/recreation/camping"]');
    assert.ok(guidance, 'BLM ownership is not a camping-permission map');
    assert.equal(guidance.textContent, 'BLM camping rules');
    assert.equal(guidance.closest('section').hidden, true, 'guidance stays in the collapsed detail');
    doc.querySelector('[data-layer="land"] button').click();
    assert.equal(guidance.closest('section').hidden, false);
    assert.equal(guidance.target, '_blank');
    assert.equal(guidance.rel, 'noopener noreferrer');
    doc.querySelector('[data-layer="slope"] button').click();
    assert.equal(guidance.closest('section').hidden, true);
    control.dispose(); dom.window.close();
});

test('partly loaded slope shading is described separately from an unavailable layer', () => {
    const dom = new JSDOM('<body></body>'), document = dom.window.document;
    const control = createMapLayerControl({ document }); document.body.append(control.element);
    control.render({ state: Schema.mapOverlayState({ slope: { enabled: true } }), statuses: { slope: {
        error: true, partial: true, retry: true, message: 'Some slope tiles couldn’t load. Available shading is still shown.',
    } } });
    control.trigger.click(); document.querySelector('[data-layer="slope"] button').click();
    assert.equal(document.querySelector('[data-layer="slope"] .bpb-layers-row-status').textContent, 'Partly loaded');
    assert.match(document.querySelector('.bpb-layers-detail:not([hidden])').textContent, /Available shading is still shown/);
    control.dispose(); dom.window.close();
});
test('a failed tile does not hide progress while neighboring tiles are still recovering', () => {
    const dom = new JSDOM('<body></body>'), document = dom.window.document;
    const control = createMapLayerControl({ document }); document.body.append(control.element);
    control.render({ state: Schema.mapOverlayState({ land: { enabled: true } }), statuses: { land: { pending: true, error: true, partial: true, retry: true } } });
    control.trigger.click(); document.querySelector('[data-layer="land"] button').click();
    assert.equal(document.querySelector('[data-layer="land"] .bpb-layers-row-status').textContent, 'Loading');
    assert.equal(document.querySelector('[data-layer="land"] button').getAttribute('aria-busy'), 'true');
    control.dispose(); dom.window.close();
});

test('Canadian land guidance keeps focus through permission states and Allow cannot replay a tile retry', () => {
    const dom = new JSDOM('<body></body>'), doc = dom.window.document, retries = [];
    const control = createMapLayerControl({ document: doc, onRetry: id => retries.push(id) }); doc.body.append(control.element);
    const state = Schema.mapOverlayState({ land: { enabled: true } });
    const statuses = { land: { guidanceKeys: ['bc', 'ab', 'https://evil.example/'], permission: true, retry: true, message: 'Allow BC parcel maps.' } };
    control.render({ state, statuses }); control.trigger.click(); doc.querySelector('[data-layer="land"] button').click();
    const links = [...doc.querySelectorAll('.bpb-layers-guidance')];
    assert.deepEqual(links.map(link => link.textContent), ['BC Crown land rules', 'Alberta camping rules']);
    links[0].focus(); control.render({ state, statuses: { land: { ...statuses.land, pending: true } } });
    assert.equal(doc.activeElement, links[0], 'status updates preserve the focused official guidance link');
    const action = doc.querySelector('[data-bpb-bc-permission="true"]');
    assert.equal(action.textContent, 'Allow'); assert.equal(action.getAttribute('aria-label'), 'Allow BC land maps');
    action.click(); assert.deepEqual(retries, [], 'the trusted isolated click owns permission requests');
    assert.equal(action.getAttribute('aria-disabled'), 'true');
    control.render({ state, statuses: { land: { ...statuses.land, permission: false, error: true } } });
    assert.equal(action.textContent, 'Retry'); action.click(); assert.deepEqual(retries, ['land']);
    control.dispose(); dom.window.close();
});
