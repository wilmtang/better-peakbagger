// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, el, waitFor, registerCleanup } from '../helpers/options-helpers.mjs';

registerCleanup();
const change = (dom, id, value) => {
    const control = el(dom, id);
    control.value = value;
    control.dispatchEvent(new dom.window.Event('change'));
};

test('existing defaults stay intact and customization opens for saved mixed units', async () => {
    const legacy = await loadOptions({ units: 'metric' });
    assert.equal(el(legacy, 'units').value, 'metric');
    assert.equal(el(legacy, 'unit-customize').open, false);
    assert.equal(el(legacy, 'temperature-units').value, 'default');
    assert.equal(el(legacy, 'temperature-units').options[0].textContent, 'Default (°C)');
    const mixed = await loadOptions({ units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric' });
    assert.equal(el(mixed, 'unit-customize').open, true);
    assert.equal(mixed.window.document.querySelector('.unit-custom-count').textContent, '2 custom units');
    assert.match(el(mixed, 'unit-example-gpx').textContent, /12\.4 mi.*2625 ft/);
    assert.equal(el(mixed, 'unit-example-weather').textContent, '9°C · 4.2 mm · 10 mph');
});

test('changing the default preserves explicit choices; reset affects only measurement overrides', async () => {
    const dom = await loadOptions({ units: 'imperial', temperatureUnits: 'metric', precipitationUnits: 'metric', elevationUnits: 'imperial', theme: 'dark' });
    change(dom, 'units', 'metric');
    await waitFor(dom, () => dom.chrome._store.bpbSettings.units === 'metric');
    assert.equal(dom.chrome._store.bpbSettings.temperatureUnits, 'metric');
    assert.equal(dom.chrome._store.bpbSettings.elevationUnits, 'imperial');
    assert.match(el(dom, 'unit-example-gpx').textContent, /20\.0 km.*2625 ft/);
    assert.equal(el(dom, 'unit-example-weather').textContent, '9°C · 4.2 mm · 16 km/h');
    el(dom, 'unit-customize').open = false;
    change(dom, 'theme', 'light');
    await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'light');
    assert.equal(el(dom, 'unit-customize').open, false, 'unrelated saves preserve the disclosure choice');
    el(dom, 'unit-reset').click();
    await waitFor(dom, () => dom.chrome._store.bpbSettings.temperatureUnits === 'default');
    assert.equal(dom.chrome._store.bpbSettings.units, 'metric');
    assert.equal(dom.chrome._store.bpbSettings.elevationUnits, 'default');
    assert.equal(dom.chrome._store.bpbSettings.theme, 'light');
    assert.equal(el(dom, 'unit-reset').disabled, true);
    change(dom, 'units', 'auto');
    await waitFor(dom, () => dom.chrome._store.bpbSettings.units === 'auto');
    assert.equal(el(dom, 'wind-units').options[0].textContent, 'Default (Peakbagger)');
    assert.match(dom.window.document.querySelector('.unit-example-heading').textContent, /Imperial Peakbagger page/);
});

test('a failed override save restores its confirmed value and example readings', async () => {
    const dom = await loadOptions({ units: 'imperial' }, { prepareChrome: chrome => {
        chrome.storage.sync.set = async () => { throw new Error('fixture storage failure'); };
    } });
    change(dom, 'temperature-units', 'metric');
    assert.match(el(dom, 'unit-example-weather').textContent, /9°C/);
    await waitFor(dom, () => !el(dom, 'status-error').hidden);
    assert.equal(el(dom, 'temperature-units').value, 'default');
    assert.match(el(dom, 'unit-example-weather').textContent, /48°F/);
    assert.equal(dom.chrome._store.bpbSettings.temperatureUnits, undefined);
});
