// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, el, waitFor, registerCleanup } from '../helpers/options-helpers.mjs';

registerCleanup();

for (const scenario of ['external update', 'local save', 'first save failure']) {
    test(`Settings startup does not supersede ${scenario}`, async () => {
        let release;
        const dom = await loadOptions({ theme: 'light', retainWaypoints: true }, {
            prepareChrome: chrome => {
                let reads = 0;
                const get = chrome.storage.sync.get;
                chrome.storage.sync.get = async key => {
                    const snapshot = await get(key);
                    // Two panel-theme bundle copies read before the Settings controller.
                    if (++reads === 3) await new Promise(resolve => { release = resolve; });
                    return snapshot;
                };
                if (scenario === 'first save failure') {
                    chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
                }
            },
        });
        await waitFor(dom, () => !!release);
        const units = el(dom, 'units');
        units.focus();
        if (scenario === 'external update') {
            await dom.chrome.storage.sync.set({ bpbSettings: { theme: 'dark', retainWaypoints: false } });
            await waitFor(dom, () => el(dom, 'theme').value === 'dark');
        } else {
            el(dom, 'theme').value = 'dark';
            el(dom, 'theme').dispatchEvent(new dom.window.Event('change'));
            if (scenario === 'local save') await waitFor(dom, () => dom.chrome._store.bpbSettings.theme === 'dark');
        }
        release();
        // A subsequent rejected save is a visible completion barrier and also
        // proves which confirmed snapshot the controller retained for rollback.
        if (scenario !== 'first save failure') {
            await waitFor(dom, () => el(dom, 'theme').value === 'dark');
            dom.chrome.storage.sync.set = async () => { throw new Error('sync write failed'); };
            units.value = 'metric';
            units.dispatchEvent(new dom.window.Event('change'));
        }
        await waitFor(dom, () => /couldn’t be saved/.test(el(dom, 'status-error-text').textContent));
        const expected = scenario === 'first save failure' ? 'light' : 'dark';
        assert.equal(el(dom, 'theme').value, expected);
        assert.equal(dom.chrome._store.bpbSettings.theme, expected);
        assert.equal(el(dom, 'retain-waypoints').checked, scenario !== 'external update');
        assert.equal(dom.window.document.activeElement, units);
    });
}
