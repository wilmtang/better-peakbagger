// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await fs.readFile(new URL('../../popup/popup.html', import.meta.url), 'utf8');
const headSource = await fs.readFile(new URL('../../dist/popup/popup-head.js', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../../dist/popup/popup.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../../popup/popup.css', import.meta.url), 'utf8');
const waitFor = async condition => {
    for (let attempt = 0; attempt < 50 && !condition(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

test('popup stops spinner motion when the user requests reduced motion', () => {
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.spinner\s*{[^}]*animation:\s*none/s);
});

test('popup theme bootstrap loads before the stylesheet', () => {
    const dom = new JSDOM(html);
    const resources = Array.from(dom.window.document.head.querySelectorAll('script[src], link[rel="stylesheet"]'))
        .map(node => node.getAttribute('src') || node.getAttribute('href'));
    assert.deepEqual(resources, ['popup-head.js', 'popup.css']);
});

test('popup paints from the cached theme and reconciles the synced preference', async () => {
    const dom = new JSDOM(html, {
        url: 'https://popup.better-peakbagger.test/popup/popup.html',
        runScripts: 'outside-only'
    });
    dom.window.localStorage.setItem('bpbThemePref', 'dark');
    dom.window.matchMedia = query => ({ matches: query === '(prefers-color-scheme: dark)' });
    dom.window.chrome = {
        storage: {
            sync: { get: async () => ({ bpbSettings: { theme: 'light' } }) },
            onChanged: { addListener() {}, removeListener() {} }
        }
    };

    dom.window.eval(headSource);
    assert.equal(dom.window.document.documentElement.getAttribute('data-bpb-theme'), 'dark',
        'the synchronous cache owns the first paint');
    await waitFor(() => dom.window.document.documentElement.getAttribute('data-bpb-theme') === 'light');
    assert.equal(dom.window.localStorage.getItem('bpbThemePref'), 'light');
    dom.window.close();
});

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
    await waitFor(() => /Captured track data deleted/.test(dom.window.document.getElementById('state').textContent));

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

test('popup lets a no-match capture bypass the cached terminal job and check again', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        id: 'no-matches-job',
        phase: 'no-matches',
        provider: 'garmin',
        hasCachedGpx: true
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
    await waitFor(() => /No confident summit matches/.test(dom.window.document.getElementById('state').textContent));

    const card = dom.window.document.querySelector('.state-card');
    assert.match(card.textContent, /Only Strong and Probable matches are shown/);
    assert.doesNotMatch(card.textContent, /Possible|weak/);
    const checkAgain = [...card.querySelectorAll('button')].find(element => element.textContent === 'Check again');
    assert.ok(checkAgain);
    assert.equal(checkAgain.classList.contains('primary'), true);
    checkAgain.click();
    await waitFor(() => captureStarts.length === 2);
    assert.equal(captureStarts[1].force, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    dom.window.close();
});

test('popup locks the selection in the same turn the drafts open', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const matches = [
        {
            id: 1, name: 'First Peak', classification: 'strong', confidence: 95,
            evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
        },
        {
            id: 2, name: 'Second Peak', classification: 'probable', confidence: 75,
            evidence: { distanceM: 30, elevationDeltaM: 10, trackQuality: 0.9 }
        }
    ];
    // The worker hands back a fresh object per message, the way publicJob() does.
    const job = phase => ({
        phase, provider: 'garmin', hasCachedGpx: true, selectedIds: [1, 2],
        trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
        matches: matches.map(match => ({ ...match }))
    });
    let phase = 'ready';
    const messages = [];
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                messages.push(message);
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job(phase);
                if (message.type === 'CAPTURE_OPEN_DRAFTS') {
                    phase = 'opened';
                    return { tabIds: [20, 21], reused: false, job: job(phase) };
                }
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const openButton = dom.window.document.getElementById('open-drafts');
    const lockHint = dom.window.document.getElementById('selection-lock-hint');
    await waitFor(() => openButton.textContent === 'Open 2 drafts');
    assert.equal(lockHint.hidden, true);

    openButton.click();
    await waitFor(() => openButton.textContent === 'Show opened drafts');

    // Without a reopen: the lock affordances engage and the deselect is refused.
    const checkboxes = [...dom.window.document.querySelectorAll('#peak-list input')];
    assert.ok(checkboxes.every(checkbox => checkbox.disabled), 'checkboxes lock on open');
    assert.equal(lockHint.hidden, false, 'the lock hint explains why');
    assert.equal(openButton.disabled, false);

    const selectionsBefore = messages.filter(message => message.type === 'CAPTURE_SELECTION').length;
    checkboxes[1].checked = false;
    checkboxes[1].dispatchEvent(new dom.window.Event('change'));
    assert.equal(openButton.textContent, 'Show opened drafts', 'no "Open 1 draft" promise after opening');
    assert.equal(
        messages.filter(message => message.type === 'CAPTURE_SELECTION').length,
        selectionsBefore,
        'no selection write is sent once the drafts exist'
    );
    dom.window.close();
});

test('popup reports a grouping failure in the status line, not on the primary button', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = phase => ({
        phase, provider: 'garmin', hasCachedGpx: true, selectedIds: [1],
        trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
        matches: [{
            id: 1, name: 'One Peak', classification: 'strong', confidence: 95,
            evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
        }]
    });
    let phase = 'ready';
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job(phase);
                if (message.type === 'CAPTURE_OPEN_DRAFTS') {
                    phase = 'opened';
                    return { tabIds: [20], reused: false, groupWarning: true, job: job(phase) };
                }
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const openButton = dom.window.document.getElementById('open-drafts');
    const openNote = dom.window.document.getElementById('open-note');
    await waitFor(() => openButton.textContent === 'Open 1 draft');
    openButton.click();
    await waitFor(() => openNote.hidden === false);

    assert.match(openNote.textContent, /didn’t group the tabs/);
    assert.equal(openNote.getAttribute('role'), 'status');
    assert.equal(openButton.textContent, 'Show opened drafts',
        'the primary action keeps a label, not a status message');
    assert.equal(openButton.disabled, false);
    dom.window.close();
});

test('popup locks an opened selection and keeps its existing drafts discoverable', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'opened', provider: 'strava', hasCachedGpx: true, selectedIds: [1],
        trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
        matches: [
            {
                id: 1, name: 'Opened Peak', classification: 'strong', confidence: 95,
                evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
            },
            {
                id: 2, name: 'Other Peak', classification: 'probable', confidence: 75,
                evidence: { distanceM: 30, elevationDeltaM: 10, trackQuality: 0.9 }
            }
        ]
    };
    const messages = [];
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                messages.push(message);
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') return { tabIds: [20], reused: true };
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const openButton = dom.window.document.getElementById('open-drafts');
    await waitFor(() => openButton.textContent === 'Show opened drafts');
    assert.equal(openButton.disabled, false);
    const checkboxes = [...dom.window.document.querySelectorAll('#peak-list input')];
    assert.ok(checkboxes.every(checkbox => checkbox.disabled));
    assert.equal(dom.window.document.getElementById('selection-lock-hint').hidden, false);
    checkboxes[1].checked = true;
    checkboxes[1].dispatchEvent(new dom.window.Event('change'));
    assert.equal(openButton.textContent, 'Show opened drafts');
    assert.equal(messages.some(message => message.type === 'CAPTURE_SELECTION'), false);
    openButton.click();
    await waitFor(() => messages.some(message => message.type === 'CAPTURE_OPEN_DRAFTS'));
    await waitFor(() => openButton.textContent === 'Show opened drafts');
    assert.equal(openButton.textContent, 'Show opened drafts');
    assert.equal(openButton.disabled, false);
    dom.window.close();
});

test('popup keeps previewed drafts reachable for manual review and Save', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'previewed', provider: 'garmin', hasCachedGpx: false, selectedIds: [1],
        trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
        matches: [{
            id: 1, name: 'Previewed Peak', classification: 'strong', confidence: 95,
            evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
        }]
    };
    const messages = [];
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                messages.push(message);
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') return { tabIds: [20], reused: true };
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const openButton = dom.window.document.getElementById('open-drafts');
    await waitFor(() => openButton.textContent === 'Show opened drafts');
    assert.equal(openButton.disabled, false);
    assert.equal(dom.window.document.querySelector('#peak-list input').disabled, true);
    openButton.click();
    await waitFor(() => messages.some(message => message.type === 'CAPTURE_OPEN_DRAFTS'));
    await waitFor(() => openButton.textContent === 'Show opened drafts' && !openButton.disabled);
    assert.equal(openButton.textContent, 'Show opened drafts');
    assert.equal(openButton.disabled, false);
    dom.window.close();
});

test('popup explains when every previewed draft tab is gone and offers recovery', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'previewed', provider: 'strava', hasCachedGpx: false, selectedIds: [1],
        trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
        matches: [{
            id: 1, name: 'Closed Peak', classification: 'strong', confidence: 95,
            evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
        }]
    };
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') {
                    throw new Error('Capture results are no longer available. Capture the activity again.');
                }
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const openButton = dom.window.document.getElementById('open-drafts');
    await waitFor(() => openButton.textContent === 'Show opened drafts');
    openButton.click();
    await waitFor(() => /Draft opening stopped/.test(dom.window.document.getElementById('state').textContent));
    assert.match(dom.window.document.getElementById('state').textContent, /Capture the activity again/);
    const back = [...dom.window.document.querySelectorAll('#state button')]
        .find(element => element.textContent === 'Back to results');
    assert.ok(back);
    back.click();
    assert.equal(openButton.textContent, 'Show opened drafts');
    assert.equal(openButton.disabled, false);
    dom.window.close();
});

test('popup restores the singular draft label after opening fails', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const job = {
        phase: 'ready', provider: 'garmin', hasCachedGpx: true, selectedIds: [1],
        trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
        matches: [{
            id: 1, name: 'One Peak', classification: 'strong', confidence: 95,
            evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
        }]
    };
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_START' || message.type === 'CAPTURE_STATUS') return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') throw new Error('Opening failed.');
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const openButton = dom.window.document.getElementById('open-drafts');
    await waitFor(() => openButton.textContent === 'Open 1 draft');
    openButton.click();
    await waitFor(() => /Draft opening stopped/.test(dom.window.document.getElementById('state').textContent));
    assert.equal(openButton.textContent, 'Open 1 draft');
    assert.equal(openButton.disabled, false);
    dom.window.close();
});

test('popup rides out a transient poll failure instead of declaring the capture dead', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay, ...args) =>
        nativeSetTimeout(callback, delay === 450 ? 3 : delay, ...args);
    const warnings = [];
    dom.window.console = { ...dom.window.console, warn: (...args) => warnings.push(args.join(' ')) };
    // Two torn-down-worker ticks in the middle of an in-progress capture.
    let statusCalls = 0;
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_STATUS') {
                    statusCalls++;
                    if (statusCalls === 2 || statusCalls === 3) {
                        throw new Error('Could not establish connection. Receiving end does not exist.');
                    }
                    return statusCalls > 4
                        ? {
                            phase: 'ready', provider: 'garmin', hasCachedGpx: true, selectedIds: [1],
                            trackSummary: { originalPointCount: 2, retainedPointCount: 2, maxDeviationM: 0 },
                            matches: [{
                                id: 1, name: 'Late Peak', classification: 'strong', confidence: 95,
                                evidence: { distanceM: 5, elevationDeltaM: 2, trackQuality: 1 }
                            }]
                        }
                        : { phase: 'finding-peaks', provider: 'garmin' };
                }
                if (message.type === 'CAPTURE_START') {
                    await new Promise(resolve => nativeSetTimeout(resolve, 200));
                    return { phase: 'finding-peaks', provider: 'garmin' };
                }
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const state = dom.window.document.getElementById('state');
    await waitFor(() => statusCalls >= 3);
    assert.doesNotMatch(state.textContent, /Capture stopped/,
        'a failed tick is not evidence the capture died');
    assert.doesNotMatch(state.textContent, /Receiving end does not exist/,
        'runtime-messaging internals are never shown as an explanation');
    assert.ok(warnings.some(line => /Receiving end does not exist/.test(line)),
        'the cause is logged for diagnosis instead');

    // The popup recovers on its own once the worker answers again.
    const openButton = dom.window.document.getElementById('open-drafts');
    await waitFor(() => openButton.textContent === 'Open 1 draft');
    assert.equal(openButton.textContent, 'Open 1 draft');
    dom.window.close();
});

test('popup gives up on a sustained poll outage with recoverable, plain copy', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay, ...args) =>
        nativeSetTimeout(callback, delay === 450 ? 3 : delay, ...args);
    dom.window.console = { ...dom.window.console, warn: () => {} };
    const starts = [];
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_STATUS') {
                    throw new Error('Could not establish connection. Receiving end does not exist.');
                }
                if (message.type === 'CAPTURE_START') {
                    starts.push(message.force);
                    await new Promise(resolve => nativeSetTimeout(resolve, 500));
                    return { phase: 'finding-peaks', provider: 'garmin' };
                }
                return { ok: true };
            }
        }
    };

    dom.window.eval(source);
    const state = dom.window.document.getElementById('state');
    await waitFor(() => /Couldn’t reach the extension/.test(state.textContent));
    assert.match(state.textContent, /The capture may still be running/);
    assert.doesNotMatch(state.textContent, /Receiving end does not exist/);

    const checkAgain = [...state.querySelectorAll('button')]
        .find(element => element.textContent === 'Check again');
    assert.ok(checkAgain, 'the outage state offers a way back');
    checkAgain.click();
    await waitFor(() => starts.length === 2);
    assert.equal(starts[1], false,
        'checking again must not force-restart a capture that may be nearly done');
    dom.window.close();
});

test('popup stops status polling when capture finishes without storing a job', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay, ...args) =>
        nativeSetTimeout(callback, delay === 450 ? 5 : delay, ...args);
    let statusCalls = 0;
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: async message => {
                if (message.type === 'CAPTURE_STATUS') {
                    statusCalls++;
                    return null;
                }
                if (message.type === 'CAPTURE_START') {
                    await new Promise(resolve => nativeSetTimeout(resolve, 20));
                    return {
                        phase: 'error',
                        error: { code: 'unsupported', message: 'Open a supported activity first.' }
                    };
                }
                return null;
            }
        }
    };

    dom.window.eval(source);
    await waitFor(() => /Open a supported activity first/.test(dom.window.document.getElementById('state').textContent));
    await new Promise(resolve => setTimeout(resolve, 20));
    const stoppedAt = statusCalls;
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.ok(stoppedAt > 0, 'the popup should check for an initially persisted job');
    assert.equal(statusCalls, stoppedAt, 'null status responses must not keep rearming after capture ends');
    dom.window.close();
});

test('popup shows a neutral unsupported-page state with discoverable Settings', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    let settingsOpens = 0;
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            openOptionsPage: async () => { settingsOpens++; },
            sendMessage: async message => message.type === 'CAPTURE_STATUS' ? null : {
                phase: 'error',
                error: { code: 'unsupported', message: 'Open a supported activity first.' }
            }
        }
    };

    dom.window.eval(source);
    await waitFor(() => /Open an activity to begin/.test(dom.window.document.getElementById('state').textContent));

    const card = dom.window.document.querySelector('.state-card');
    assert.equal(card.classList.contains('empty'), true);
    assert.equal(card.classList.contains('error'), false);
    assert.equal(dom.window.document.getElementById('provider-label').textContent, 'Capture this activity');
    assert.match(card.textContent, /Garmin Connect or Strava activity/);

    const headerSettings = dom.window.document.getElementById('open-settings');
    assert.equal(headerSettings.getAttribute('aria-label'), 'Open Settings');
    headerSettings.click();
    Array.from(card.querySelectorAll('button')).find(button => button.textContent === 'Settings').click();
    await waitFor(() => settingsOpens === 2);
    dom.window.close();
});

test('popup can cancel an in-progress capture without retaining track data', async () => {
    const dom = new JSDOM(html, {
        url: 'chrome-extension://better-peakbagger/popup/popup.html',
        runScripts: 'outside-only'
    });
    const messages = [];
    let finishStart;
    dom.window.chrome = {
        tabs: { query: async () => [{ id: 9 }] },
        runtime: {
            sendMessage: message => {
                messages.push(message);
                if (message.type === 'CAPTURE_START') return new Promise(resolve => { finishStart = resolve; });
                if (message.type === 'CAPTURE_STATUS') return Promise.resolve({ phase: 'checking-peakbagger', provider: 'strava' });
                if (message.type === 'CAPTURE_CANCEL') return Promise.resolve({ ok: true, cancelled: true, job: null });
                return Promise.resolve(null);
            }
        }
    };

    dom.window.eval(source);
    await waitFor(() => Array.from(dom.window.document.querySelectorAll('#state button'))
        .some(button => button.textContent === 'Cancel'));
    Array.from(dom.window.document.querySelectorAll('#state button'))
        .find(button => button.textContent === 'Cancel').click();
    await waitFor(() => /No track data from this capture was kept/.test(dom.window.document.getElementById('state').textContent));

    assert.ok(messages.some(message => message.type === 'CAPTURE_CANCEL' && message.tabId === 9));
    assert.ok(Array.from(dom.window.document.querySelectorAll('#state button'))
        .some(button => button.textContent === 'Start again'));
    finishStart(null);
    dom.window.close();
});
