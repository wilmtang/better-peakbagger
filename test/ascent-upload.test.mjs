// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ascent-editor upload processing, exercised against the captured ascentedit
// fixture through the built content bundle: date autofill, the native-Preview
// → ✦ Process swap (user-initiated file picks only), busy states, and the
// GPX_PROCESS_START/APPLY messaging. The worker side of the pipeline lives in
// background-gpx-process.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, waitFor, fireTrustedEvent, PAGE_FIXTURES } from './helpers/load-page.mjs';

const FIXTURE = 'climber-ascentedit.html';
const URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=900001';
const BUNDLES = ['vendor/marked.umd.js', 'content/ascent-editor.js'];

const GPX = `<?xml version="1.0"?><gpx creator="SourceApp" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Corridor walk</name><trkseg>
    <trkpt lat="49.5" lon="-123.1"><ele>100</ele><time>2026-07-01T15:00:00Z</time></trkpt>
    <trkpt lat="49.5" lon="-123.099"><ele>130</ele><time>2026-07-01T16:00:00Z</time></trkpt>
  </trkseg></trk></gpx>`;

const loadEditor = ({ prepare = null, url = URL, respond = null, settings = {} } = {}) => loadPage(FIXTURE, {
    url,
    settings,
    bundles: BUNDLES,
    fixtures: PAGE_FIXTURES,
    prepare: d => {
        d.window.tzlookup = () => 'America/Vancouver';
        if (respond) {
            d.messages = [];
            d.chrome.runtime.sendMessage = async message => {
                d.messages.push(message);
                return respond(message);
            };
        }
        if (prepare) prepare(d);
    }
});

const chooseGpx = (dom, { name = 'walk.gpx', content = GPX } = {}) => {
    const input = dom.window.document.getElementById('GPXUpload');
    const file = new dom.window.File([content], name, { type: 'application/gpx+xml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    fireTrustedEvent(input, 'change', { bubbles: true });
    return input;
};

const processButton = dom => dom.window.document.querySelector('.bpb-process-button');
const uploadStatus = dom => dom.window.document.querySelector('.bpb-upload-status');

const localToday = () => {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

test('an empty Ascent Date on a fresh form is filled with the local today', async () => {
    const events = [];
    const dom = await loadEditor({
        prepare: d => {
            const field = d.window.document.getElementById('DateText');
            field.addEventListener('input', () => events.push('input'));
            field.addEventListener('change', () => events.push('change'));
        }
    });
    assert.equal(dom.window.document.getElementById('DateText').value, localToday());
    assert.deepEqual(events, ['input', 'change'],
        'the fill must announce itself the way setTextField does');
});

test('a populated date — an existing ascent being edited — is never touched', async () => {
    const dom = await loadEditor({
        prepare: d => { d.window.document.getElementById('DateText').value = '2019-08-14'; }
    });
    assert.equal(dom.window.document.getElementById('DateText').value, '2019-08-14');
});

test('whitespace-only counts as empty; a page without the field is left alone', async () => {
    const dom = await loadEditor({
        prepare: d => { d.window.document.getElementById('DateText').value = '   '; }
    });
    assert.equal(dom.window.document.getElementById('DateText').value, localToday());

    const bare = await loadEditor({
        prepare: d => { d.window.document.getElementById('DateText').remove(); }
    });
    assert.equal(bare.window.document.getElementById('DateText'), null);
});

test('a user-picked .gpx swaps native Preview for an accessible Process button', async () => {
    const dom = await loadEditor();
    chooseGpx(dom);

    const button = processButton(dom);
    assert.ok(button, 'the Process button should appear');
    assert.equal(button.getAttribute('aria-label'), 'Process the chosen GPX and fill this form');
    assert.equal(button.textContent.includes('Process'), true);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-busy'), null);
    const native = dom.window.document.getElementById('GPXPreview');
    assert.equal(native.classList.contains('bpb-native-preview-hidden'), true,
        'the native button stays in the DOM (the form post needs it) but is hidden');

    // Clearing the selection restores Peakbagger's plain upload path.
    const input = dom.window.document.getElementById('GPXUpload');
    Object.defineProperty(input, 'files', { value: [], configurable: true, writable: true });
    fireTrustedEvent(input, 'change', { bubbles: true });
    assert.equal(processButton(dom), null);
    assert.equal(native.classList.contains('bpb-native-preview-hidden'), false);
});

test('a non-gpx selection and Peakbagger’s Remove both restore the native button', async () => {
    const dom = await loadEditor();
    chooseGpx(dom, { name: 'photo.jpeg', content: 'not gpx' });
    assert.equal(processButton(dom), null, 'only a .gpx candidate earns the swap');

    chooseGpx(dom);
    assert.ok(processButton(dom));
    dom.window.document.getElementById('GPXRemove').dispatchEvent(
        new dom.window.Event('click', { bubbles: true }));
    assert.equal(processButton(dom), null);
    assert.equal(dom.window.document.getElementById('GPXPreview')
        .classList.contains('bpb-native-preview-hidden'), false);
});

test('the capture draft flow’s programmatic change never triggers the swap', async () => {
    const dom = await loadEditor();
    const input = dom.window.document.getElementById('GPXUpload');
    const file = new dom.window.File([GPX], 'track.gpx', { type: 'application/gpx+xml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(processButton(dom), null, 'a synthetic (untrusted) change must not swap the buttons');
});

test('Process parses on the page, resolves the timezone offline, and auto-applies a single bound match', async () => {
    const labels = [];
    const dom = await loadEditor({
        settings: { fillTripInfo: false },
        respond: message => {
            if (message.type === 'DRAFT_READY') return { action: 'ignore' };
            if (message.type === 'GPX_PROCESS_START') {
                return {
                    phase: 'ready',
                    jobId: 'job-1',
                    boundPid: 7,
                    matches: [{ id: 7, name: 'Test Peak', confidence: 91, classification: 'strong', selected: true, date: '2026-07-01', time: '08:00', upDistanceM: 70 }]
                };
            }
            if (message.type === 'GPX_PROCESS_APPLY') return { ok: true, tabIds: [5] };
            return undefined;
        }
    });
    chooseGpx(dom);
    const button = processButton(dom);
    const observer = new dom.window.MutationObserver(() => {
        const label = button.querySelector('.bpb-process-label').textContent;
        if (labels[labels.length - 1] !== label) labels.push(label);
    });
    observer.observe(button, { subtree: true, childList: true, characterData: true, attributes: true });

    button.click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));

    const start = dom.messages.find(message => message.type === 'GPX_PROCESS_START');
    assert.equal(start.segments.length, 1);
    assert.equal(start.segments[0].length, 2);
    assert.equal(start.segments[0][0].lat, 49.5);
    assert.equal(start.utcOffsetMinutes, -420, 'July in America/Vancouver is UTC-7, resolved offline');
    assert.deepEqual([...start.waypoints], []);
    assert.equal(start.trackName, '', 'with Trip Info filling off, the track name never leaves the page');
    assert.doesNotMatch(JSON.stringify(start), /SourceApp|topografix/,
        'no source-XML marker may cross to the worker');

    const apply = dom.messages.find(message => message.type === 'GPX_PROCESS_APPLY');
    assert.deepEqual(JSON.parse(JSON.stringify(apply)),
        { type: 'GPX_PROCESS_APPLY', jobId: 'job-1', selectedIds: [7], primaryId: 7 });

    assert.ok(labels.includes('Reading track…') || labels.includes('Finding summits…'),
        'the busy label cycles through real states');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.disabled, true);
    assert.equal(button.querySelector('.bpb-process-label').textContent, 'Filling form…',
        'the button stays busy until Peakbagger’s postback reloads the page');
    observer.disconnect();
});

test('the trip name is sent only when Trip Info filling is enabled', async () => {
    const dom = await loadEditor({
        settings: { fillTripInfo: true },
        respond: message => message.type === 'GPX_PROCESS_START'
            ? { phase: 'no-matches' }
            : { action: 'ignore' }
    });
    chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_START'));
    assert.equal(dom.messages.find(message => message.type === 'GPX_PROCESS_START').trackName, 'Corridor walk');
});

test('processing failures name the problem and restore the native Preview', async () => {
    const dom = await loadEditor({
        respond: message => message.type === 'GPX_PROCESS_START'
            ? { phase: 'error', error: { code: 'peakbagger-signed-out', message: 'Your Peakbagger login could not be verified. Confirm you’re signed in, then try again.' } }
            : { action: 'ignore' }
    });
    chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));

    const status = uploadStatus(dom);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.match(status.textContent, /login could not be verified/);
    assert.equal(processButton(dom), null, 'failure restores the native path');
    assert.equal(dom.window.document.getElementById('GPXPreview')
        .classList.contains('bpb-native-preview-hidden'), false);
});

test('an unparseable file fails inline without leaving the page broken', async () => {
    const dom = await loadEditor({
        respond: () => ({ action: 'ignore' })
    });
    chooseGpx(dom, { content: '<gpx><trk><trkseg></gpx' });
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));
    assert.match(uploadStatus(dom).textContent, /invalid GPX XML/);
    assert.equal(processButton(dom), null);
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_START'), false,
        'nothing crosses to the worker when the file cannot be parsed');
});

test('a waypoint-only file points the user back at Peakbagger’s own path', async () => {
    const dom = await loadEditor({ respond: () => ({ action: 'ignore' }) });
    chooseGpx(dom, { content: '<gpx><wpt lat="1" lon="2"/></gpx>' });
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));
    assert.match(uploadStatus(dom).textContent, /no track points.*Preview may still accept/i);
    assert.equal(processButton(dom), null);
});

const MULTI_MATCHES = [
    { id: 7, name: 'First Peak', confidence: 91, classification: 'strong', selected: true, date: '2026-07-01', time: '08:12', upDistanceM: 3400 },
    { id: 8, name: 'Second Peak', confidence: 72, classification: 'probable', selected: false, date: '2026-07-01', time: '10:40', upDistanceM: 7800 }
];

const loadCard = async ({ boundPid = 7, matches = MULTI_MATCHES, boundFallback = null, applyResult = { ok: true, tabIds: [5, 100] } } = {}) => {
    const dom = await loadEditor({
        respond: message => {
            if (message.type === 'DRAFT_READY') return { action: 'ignore' };
            if (message.type === 'GPX_PROCESS_START') {
                return { phase: 'ready', jobId: 'job-2', boundPid, matches, boundFallback };
            }
            if (message.type === 'GPX_PROCESS_APPLY') return applyResult;
            return undefined;
        }
    });
    chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => dom.window.document.querySelector('.bpb-summit-card'));
    return dom;
};

const cardParts = dom => {
    const cardElement = dom.window.document.querySelector('.bpb-summit-card');
    return {
        card: cardElement,
        checkboxes: [...cardElement.querySelectorAll('.bpb-summit-check')],
        apply: cardElement.querySelector('.bpb-summit-apply'),
        cancel: cardElement.querySelector('.bpb-summit-cancel')
    };
};

test('several summits earn the picker card with strong and bound peaks preselected', async () => {
    const dom = await loadCard();
    const { card, checkboxes, apply } = cardParts(dom);
    assert.match(card.querySelector('.bpb-summit-card-title').textContent, /2 summits detected/);
    assert.deepEqual(checkboxes.map(checkbox => checkbox.checked), [true, false],
        'strong matches (and the bound peak) preselect; probable ones await the user');
    assert.deepEqual(
        [...card.querySelectorAll('.bpb-summit-chip')].map(chip => chip.textContent),
        ['Strong', 'Probable']);
    assert.match(card.querySelector('.bpb-summit-meta').textContent, /at 08:12 · 3\.4 km/);
    assert.equal(apply.textContent, 'Fill this ascent');

    checkboxes[1].click();
    assert.equal(apply.textContent, 'Fill + open 1 draft');

    apply.click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));
    const message = dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY');
    assert.deepEqual(JSON.parse(JSON.stringify(message)),
        { type: 'GPX_PROCESS_APPLY', jobId: 'job-2', selectedIds: [7, 8], primaryId: 7 });
    await waitFor(dom, () => !dom.window.document.querySelector('.bpb-summit-card'));
    const button = processButton(dom);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.querySelector('.bpb-process-label').textContent, 'Filling form…');
});

test('Cancel dismisses the card and restores Peakbagger’s native path', async () => {
    const dom = await loadCard();
    cardParts(dom).cancel.click();
    assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null);
    assert.equal(processButton(dom), null);
    assert.equal(dom.window.document.getElementById('GPXPreview')
        .classList.contains('bpb-native-preview-hidden'), false);
});

test('a bound peak off the track offers an explicit closest-approach override', async () => {
    const dom = await loadCard({
        matches: [MULTI_MATCHES[1]],
        boundFallback: {
            id: 7, name: 'Bound Peak', confidence: 22, classification: 'weak', selected: false,
            date: '2026-07-01', time: '09:00', upDistanceM: 5000, closestApproachM: 240
        }
    });
    const { card, checkboxes, apply } = cardParts(dom);
    assert.match(card.querySelector('.bpb-summit-note').textContent,
        /closest approach to Bound Peak is 240 m from the summit/);
    assert.match(card.textContent, /Off track/);
    assert.equal(checkboxes[1].checked, false, 'using the bound peak anyway is an explicit choice');

    // The detected summit alone can only open a draft; adding the bound peak
    // fills this page too.
    checkboxes[0].click();
    assert.equal(apply.textContent, 'Open 1 draft');
    checkboxes[1].click();
    assert.equal(apply.textContent, 'Fill + open 1 draft');
    checkboxes[0].click();
    assert.equal(apply.textContent, 'Fill this ascent');

    apply.click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));
    assert.deepEqual(JSON.parse(JSON.stringify(dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY'))),
        { type: 'GPX_PROCESS_APPLY', jobId: 'job-2', selectedIds: [7], primaryId: 7 });
});

test('sibling-only drafts leave this page on its native path with a confirmation', async () => {
    const dom = await loadCard({
        boundPid: 99,
        matches: [MULTI_MATCHES[0]],
        applyResult: { ok: true, tabIds: [100] }
    });
    const { card, apply } = cardParts(dom);
    assert.match(card.querySelector('.bpb-summit-note').textContent,
        /never comes within range of this page’s peak/);
    assert.equal(apply.textContent, 'Open 1 draft');
    apply.click();
    await waitFor(dom, () => uploadStatus(dom));
    assert.match(uploadStatus(dom).textContent, /Opened 1 draft tab in the Peak Drafts group/);
    assert.equal(processButton(dom), null, 'the native upload path returns');
    assert.equal(dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY').primaryId, null);
});

test('on an unbound page the highest-confidence selection becomes this page’s peak', async () => {
    const dom = await loadCard({ boundPid: null });
    const { checkboxes, apply } = cardParts(dom);
    checkboxes[1].click();
    assert.equal(apply.textContent, 'Fill + open 1 draft');
    apply.click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));
    assert.equal(dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY').primaryId, 7,
        'the strongest selected match fills the page it navigates to');
});

test('a single summit on an unbound page fills immediately without a card', async () => {
    const dom = await loadEditor({
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx',
        respond: message => {
            if (message.type === 'GPX_PROCESS_START') {
                return { phase: 'ready', jobId: 'job-3', boundPid: null, matches: [MULTI_MATCHES[0]], boundFallback: null };
            }
            if (message.type === 'GPX_PROCESS_APPLY') return { ok: true, tabIds: [5] };
            return { action: 'ignore' };
        }
    });
    chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));
    assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null);
    assert.equal(dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY').primaryId, 7);
});

test('the stylesheet keeps its reduced-motion and dark-theme guards', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new globalThis.URL('../src/ascent-upload.css', import.meta.url), 'utf8');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /html\[data-bpb-theme='dark'\] \.bpb-process-button/);
    assert.match(css, /animation: none !important/);
});
