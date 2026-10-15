// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { peakPopupSnapshot, waitForPeakPopupSnapshot } from '../../scripts/verify-terrain-popup.mjs';

test('terrain popup verification captures marker identity, name and URL before reconciliation', async t => {
    const dom = new JSDOM('<iframe id="bpb-terrain-frame"></iframe>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const win = dom.window.document.querySelector('iframe').contentWindow;
    win.document.body.innerHTML = '<button id="marker"></button><div class="bpb-peak-popup"><a href="/peak.aspx?pid=2829">Mount Shuksan</a></div>';
    win.__bpbPeakNameMarker = win.document.getElementById('marker');
    const reconcile = () => {
        win.__bpbPeakNameMarker.remove();
        win.document.querySelector('.bpb-peak-popup')?.remove();
    };
    let disposed = false;
    const page = {
        waitForFunction: async fn => {
            const state = dom.window.eval(`(${fn.toString()})()`);
            assert.ok(state);
            const snapshot = JSON.parse(JSON.stringify(state));
            return { jsonValue: async () => { reconcile(); return snapshot; }, dispose: async () => { disposed = true; } };
        },
        frameLocator: () => ({ locator: selector => ({
            evaluate: async fn => {
                assert.equal(selector, 'body');
                const state = win.eval(`(${fn.toString()})()`);
                reconcile();
                return state;
            },
            textContent: async () => { throw new Error('popup removed between marker and link reads'); },
        }) }),
    };
    assert.deepEqual(await waitForPeakPopupSnapshot(page), {
        replaced: false, name: 'Mount Shuksan', href: '/peak.aspx?pid=2829',
    });
    assert.equal(win.__bpbPeakNameMarker.isConnected, false);
    assert.equal(disposed, true);
});

test('terrain popup readiness waits for a connected marker and exposes only actual replacements', t => {
    const dom = new JSDOM('<iframe id="bpb-terrain-frame"></iframe>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const win = dom.window.document.querySelector('iframe').contentWindow;
    win.document.body.innerHTML = '<button id="marker"></button>';
    win.__bpbPeakNameMarker = win.document.getElementById('marker');
    const read = () => dom.window.eval(`(${peakPopupSnapshot.toString()})()`);
    assert.equal(read(), false, 'a missing popup on a connected marker must not pass readiness');
    win.document.body.insertAdjacentHTML('beforeend', '<div class="bpb-peak-popup"><a href="/wrong">Wrong summit</a></div>');
    assert.deepEqual(JSON.parse(JSON.stringify(read())), { replaced: false, name: 'Wrong summit', href: '/wrong' },
        'keep incorrect popup contents available to the exact-name and URL assertions');
    win.__bpbPeakNameMarker.remove();
    win.document.querySelector('.bpb-peak-popup').remove();
    assert.deepEqual(JSON.parse(JSON.stringify(read())), { replaced: true, name: null, href: null });
});
