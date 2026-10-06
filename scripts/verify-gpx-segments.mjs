// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global document, innerWidth */

import assert from 'node:assert/strict';

// Same observable contract for real Chrome and Firefox; caller owns a hidden
// test profile, HTTPS fixture transport, settings, and reliable teardown.
export async function verifyGpxSegments({ navigate, evaluate, resize, click, press, wait, screenshot }) {
    await navigate();
    await wait(() => document.querySelector('.bpb-gpx-segment-disclosure'));
    assert.match(await evaluate(() => document.querySelector('.bpb-gpx-stats').textContent), /Time: 12h 32m/);
    for (const width of [1000, 430, 1600]) {
        await resize(width, 760);
        const geometry = await evaluate(() => {
            const note = document.querySelector('.bpb-gpx-metric-note');
            const count = note.querySelector('.bpb-gpx-point-count');
            const button = note.querySelector('button');
            const header = note.closest('.bpb-gpx-header');
            const rect = note.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            const height = header.getBoundingClientRect().height;
            button.style.display = 'none';
            const withoutHeight = header.getBoundingClientRect().height;
            button.style.display = '';
            return { height, withoutHeight, noteHeight: rect.height, buttonHeight: buttonRect.height,
                fits: buttonRect.right <= rect.right + 1 && rect.right <= innerWidth,
                count: count.textContent };
        });
        assert.equal(geometry.height, geometry.withoutHeight, `header grew at ${width}: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.fits && geometry.buttonHeight <= geometry.noteHeight + 1,
            `disclosure clipped/wrapped at ${width}: ${JSON.stringify(geometry)}`);
        assert.match(geometry.count, /113 points/);
        await screenshot?.(`closed-${width}`);
    }
    await press('.bpb-gpx-segment-disclosure', 'Enter');
    await wait(() => !document.querySelector('#bpb-gpx-segment-details').hidden);
    await screenshot?.('open');
    await press('.bpb-gpx-segment-view', 'Enter');
    await wait(() => /Time: 68h 28m/.test(document.querySelector('.bpb-gpx-stats').textContent));
    assert.equal(await evaluate(() => document.activeElement.className), 'bpb-gpx-segment-view');
    await press('#bpb-gpx-analysis canvas', 'ArrowRight');
    await wait(() => !document.querySelector('.bpb-gpx-coordinate-controls button').disabled);
    await click('.bpb-gpx-segment-view');
    await wait(() => /Time: 12h 32m/.test(document.querySelector('.bpb-gpx-stats').textContent));
    assert.ok(await evaluate(() => document.querySelector('.bpb-gpx-coordinate-controls button').disabled));
    assert.match(await evaluate(() => document.querySelector('.bpb-gpx-hint').textContent), /excluded/);
    await screenshot?.('excluded-selection');
    for (let i = 0; i < 4; i++) await click('.bpb-gpx-segment-view');
    assert.match(await evaluate(() => document.querySelector('#bpb-gpx-segment-details').textContent), /56 points used; 57 points excluded/);
    await click('.bpb-gpx-segment-disclosure');
    assert.ok(await evaluate(() => document.querySelector('#bpb-gpx-segment-details').hidden));
}
