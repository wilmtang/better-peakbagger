// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await fs.readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');

test('popup explains both match class and confidence percentage', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'ready',
        provider: 'garmin',
        selectedIds: [1],
        trackSummary: {
            originalPointCount: 6200,
            retainedPointCount: 3000,
            maxDeviationM: 2.4
        },
        matches: [
            {
                id: 1,
                name: 'Strong Peak',
                classification: 'strong',
                confidence: 96,
                evidence: { distanceM: 8, elevationDeltaM: 4, trackQuality: 0.98 }
            },
            {
                id: 2,
                name: 'Probable Peak',
                classification: 'probable',
                confidence: 72,
                evidence: { distanceM: 36, elevationDeltaM: 15, trackQuality: 0.91 }
            }
        ]
    };
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job;
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.deepEqual(
        [...dom.window.document.querySelectorAll('.confidence')].map(element => element.textContent),
        ['Strong match · 96% confidence', 'Probable match · 72% confidence']
    );
    dom.window.close();
});
