// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mapFrameLifecycle as MapFrameLifecycle } from '../../src/gpx/map-frame-lifecycle.js';
import { waitFor } from '../helpers/load-page.mjs';

test('one frame lifecycle publishes insertion, load, replacement, and removal', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const events = [];
    const lifecycle = MapFrameLifecycle.create({
        selector: 'iframe[src*="MasterMap.aspx"]',
        document: window.document,
        MutationObserver: window.MutationObserver,
    });
    lifecycle.subscribe(event => events.push(event));
    lifecycle.start();
    assert.equal(lifecycle.current(), null);

    const first = window.document.createElement('iframe');
    first.src = 'https://www.peakbagger.com/map/MasterMap.aspx?pid=1';
    window.document.body.append(first);
    await waitFor(dom, () => events.some(event => event.frame === first && event.reason === 'identity'));
    assert.equal(lifecycle.current(), first);

    first.dispatchEvent(new window.Event('load'));
    assert.equal(events.at(-1).reason, 'load');

    const replacement = window.document.createElement('iframe');
    replacement.src = 'https://www.peakbagger.com/map/MasterMap.aspx?pid=2';
    first.replaceWith(replacement);
    await waitFor(dom, () => lifecycle.current() === replacement);
    const countAfterReplacement = events.length;
    first.dispatchEvent(new window.Event('load'));
    assert.equal(events.length, countAfterReplacement,
        'the discarded frame must no longer own a load listener');

    replacement.remove();
    await waitFor(dom, () => lifecycle.current() === null);
    assert.equal(events.at(-1).previous, replacement);
    assert.equal(events.at(-1).frame, null);

    lifecycle.dispose();
    dom.window.close();
});
