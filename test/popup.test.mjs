// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await fs.readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../dist/popup/popup.js', import.meta.url), 'utf8');
const waitFor = async condition => {
    for (let attempt = 0; attempt < 50 && !condition(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

test('popup explains both match class and confidence percentage', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'ready',
        provider: 'garmin',
        hasCachedGpx: true,
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
    assert.equal(dom.window.document.getElementById('clear-capture').hidden, false);
    assert.match(dom.window.document.querySelector('.privacy-note').textContent, /coordinates, elevation, and time/);
    dom.window.close();
});

test('popup discards the cached GPX before offering a fresh capture', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'ready', provider: 'garmin', hasCachedGpx: true, selectedIds: [1],
        trackSummary: { originalPointCount: 6200, retainedPointCount: 3000, maxDeviationM: 2.4 },
        matches: [{
            id: 1, name: 'Strong Peak', classification: 'strong', confidence: 96,
            evidence: { distanceM: 8, elevationDeltaM: 4, trackQuality: 0.98 }
        }]
    };
    const messages = [];
    let captureStarts = 0;
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                messages.push(message);
                if (message.type === 'CAPTURE_START') {
                    captureStarts++;
                    return job;
                }
                if (message.type === 'CAPTURE_STATUS') return job;
                if (message.type === 'CAPTURE_CLEAR') return { ok: true, removedGpx: true, removedDraftCount: 1 };
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    await waitFor(() => !dom.window.document.getElementById('clear-capture').hidden);
    dom.window.document.getElementById('clear-capture').click();
    await waitFor(() => /Cached capture removed/.test(dom.window.document.getElementById('state').textContent));

    assert.ok(messages.some(message => message.type === 'CAPTURE_CLEAR' && message.tabId === 9));
    assert.equal(dom.window.document.getElementById('results').hidden, true);
    const captureAgain = [...dom.window.document.querySelectorAll('#state button')]
        .find(element => element.textContent === 'Capture again');
    assert.ok(captureAgain);
    captureAgain.click();
    await waitFor(() => captureStarts === 2 && !dom.window.document.getElementById('results').hidden);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(captureStarts, 2);
    dom.window.close();
});

test('popup presents a trackless manual activity as a neutral retryable state', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        id: 'no-gps-job',
        phase: 'no-gps',
        provider: 'strava',
        hasCachedGpx: false,
        message: 'This activity has no recorded route to capture. Manually created activities need recorded track data before a GPX can be generated.'
    };
    const captureStarts = [];
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_START') captureStarts.push(message);
                return job;
            }
        }
    };

    dom.window.eval(source);
    await waitFor(() => /No GPS track on this activity/.test(dom.window.document.getElementById('state').textContent));

    const card = dom.window.document.querySelector('.state-card');
    assert.equal(card.classList.contains('error'), false);
    assert.equal(dom.window.document.getElementById('results').hidden, true);
    assert.match(card.textContent, /Manually created activities/);
    const checkAgain = [...card.querySelectorAll('button')].find(element => element.textContent === 'Check again');
    assert.ok(checkAgain);
    assert.equal(checkAgain.classList.contains('primary'), true);
    checkAgain.click();
    await waitFor(() => captureStarts.length === 2);
    assert.equal(captureStarts[1].force, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    dom.window.close();
});
