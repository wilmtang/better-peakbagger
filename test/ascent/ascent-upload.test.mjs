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
import { loadPage, waitFor, fireTrustedEvent, PAGE_FIXTURES } from '../helpers/load-page.mjs';
import { MAX_GPX_BYTES } from '../../src/capture/capture-resource-limits.js';

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
        if (respond) {
            d.messages = [];
            d.chrome.runtime.sendMessage = async message => {
                d.messages.push(message);
                if (message.type === 'GPX_PROCESS_INVALIDATE') return undefined;
                const response = await respond(message);
                return message.type === 'GPX_PROCESS_START' && response
                    ? {
                        ...response,
                        pageSessionId: message.pageSessionId,
                        selectionGeneration: message.selectionGeneration,
                        selectionNonce: message.selectionNonce,
                    }
                    : response;
            };
        }
        if (prepare) prepare(d);
    }
});

const chooseGpx = async (dom, {
    name = 'walk.gpx', content = GPX, size = null,
    type = 'application/gpx+xml', lastModified = undefined,
} = {}) => {
    const input = dom.window.document.getElementById('GPXUpload');
    const file = new dom.window.File([content], name, { type, lastModified });
    if (size !== null) Object.defineProperty(file, 'size', { value: size });
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    fireTrustedEvent(input, 'change', { bubbles: true });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    return input;
};

const installDropFileList = d => {
    class DataTransferMock {
        constructor() {
            this.files = [];
            this.items = { add: file => this.files.push(file) };
        }
    }
    d.window.DataTransfer = DataTransferMock;
    Object.defineProperty(d.window.document.getElementById('GPXUpload'), 'files', {
        value: [], configurable: true, writable: true,
    });
};

const transferEvent = (win, type, transfer) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    return event;
};

const fileTransfer = files => ({
    types: ['Files'],
    items: files.map(file => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
        webkitGetAsEntry: () => ({ isDirectory: false }),
    })),
    files,
    dropEffect: 'none',
});

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
    assert.equal(dom.window.document.getElementById('DateText').dataset.bpbAutofilled, 'date');
    assert.deepEqual(events, ['input', 'change'],
        'the fill must announce itself the way setTextField does');
});

test('editing the generated date protects it from later GPX processing', async () => {
    const dom = await loadEditor();
    const field = dom.window.document.getElementById('DateText');
    field.value = '2019-08-14';
    fireTrustedEvent(field, 'input', { bubbles: true });
    assert.equal(field.dataset.bpbAutofilled, undefined);
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
    await chooseGpx(dom);

    const button = processButton(dom);
    assert.ok(button, 'the Process button should appear');
    assert.equal(button.getAttribute('aria-label'), 'Process the chosen GPX and fill this form');
    assert.equal(button.textContent.includes('Process'), true);
    assert.equal(button.disabled, false);

    const hint = dom.window.document.getElementById('bpb-capture-hint');
    assert.equal(hint.parentElement, dom.window.document.getElementById('GPXUpload').closest('td'));
    assert.match(hint.textContent, /Garmin or Strava.*browser toolbar.*capture it directly/);
    assert.equal(dom.window.document.getElementById('bpb-gpx-drop-hint').textContent,
        'Or drag a GPX file here.');
    assert.match(dom.window.document.getElementById('GPXUpload').getAttribute('aria-describedby'),
        /\bbpb-gpx-drop-hint\b/);
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
    await chooseGpx(dom, { name: 'photo.jpeg', content: 'not gpx' });
    assert.equal(processButton(dom), null, 'only a .gpx candidate earns the swap');

    await chooseGpx(dom);
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

test('dragging one GPX cues the drop and attaches it through the normal selection binding', async () => {
    const dom = await loadEditor({
        prepare: installDropFileList,
        respond: () => ({ action: 'ignore' }),
    });
    const { document } = dom.window;
    const target = document.getElementById('GPXUpload').closest('td');
    const file = new dom.window.File([GPX], 'dragged-walk.gpx', { type: 'application/gpx+xml' });
    const transfer = fileTransfer([file]);

    const enter = transferEvent(dom.window, 'dragenter', transfer);
    target.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(target.classList.contains('is-gpx-drag-over'), true);
    assert.equal(document.getElementById('bpb-gpx-drop-hint').textContent,
        'Release to choose this GPX file.');

    const over = transferEvent(dom.window, 'dragover', transfer);
    target.dispatchEvent(over);
    assert.equal(over.defaultPrevented, true);
    assert.equal(transfer.dropEffect, 'copy');

    const drop = transferEvent(dom.window, 'drop', transfer);
    target.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(target.classList.contains('is-gpx-drag-over'), false);
    assert.equal(document.getElementById('bpb-gpx-drop-hint').textContent,
        'Or drag a GPX file here.');
    await waitFor(dom, () => processButton(dom));

    const input = document.getElementById('GPXUpload');
    assert.equal(input.files.length, 1);
    assert.equal(input.files[0], file, 'the exact dropped file becomes Peakbagger’s native upload');
    const invalidation = dom.messages.find(message => message.type === 'GPX_PROCESS_INVALIDATE');
    assert.equal(typeof invalidation.selectionNonce, 'string');
    assert.equal(Object.hasOwn(invalidation, 'fileIdentity'), false);
    assert.doesNotMatch(JSON.stringify(invalidation), /dragged-walk\.gpx/);
    assert.equal(processButton(dom).disabled, false);
});

test('multi-file and folder drops are explicit future cases and never choose the first file', async () => {
    const dom = await loadEditor({
        prepare: installDropFileList,
        respond: () => ({ action: 'ignore' }),
    });
    const { document } = dom.window;
    const target = document.getElementById('GPXUpload').closest('td');
    const first = new dom.window.File([GPX], 'first.gpx', { type: 'application/gpx+xml' });
    const second = new dom.window.File([GPX], 'second.gpx', { type: 'application/gpx+xml' });

    target.dispatchEvent(transferEvent(dom.window, 'drop', fileTransfer([first, second])));
    assert.match(uploadStatus(dom).textContent,
        /Drop one GPX file at a time.*Multiple files and folders aren’t supported yet/);
    assert.equal(document.getElementById('GPXUpload').files.length, 0);
    assert.equal(processButton(dom), null);

    const folderTransfer = {
        types: ['Files'],
        items: [{
            kind: 'file', type: '', getAsFile: () => null,
            webkitGetAsEntry: () => ({ isDirectory: true }),
        }],
        files: [],
        dropEffect: 'none',
    };
    target.dispatchEvent(transferEvent(dom.window, 'drop', folderTransfer));
    assert.match(uploadStatus(dom).textContent, /Multiple files and folders aren’t supported yet/);
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_INVALIDATE'), false,
        'rejected collections must not create or invalidate a file-selection generation');
});

test('non-GPX drops stay local, actionable, and do not disturb an existing selection', async () => {
    const dom = await loadEditor({ prepare: installDropFileList });
    await chooseGpx(dom, { name: 'kept.gpx' });
    const { document } = dom.window;
    const target = document.getElementById('GPXUpload').closest('td');
    const photo = new dom.window.File(['pixels'], 'summit.jpg', { type: 'image/jpeg' });

    const textDrop = transferEvent(dom.window, 'drop', {
        types: ['text/plain'], items: [], files: [], dropEffect: 'none',
    });
    target.dispatchEvent(textDrop);
    assert.equal(textDrop.defaultPrevented, false, 'ordinary page drags stay outside the file intake');

    target.dispatchEvent(transferEvent(dom.window, 'drop', fileTransfer([photo])));

    assert.equal(uploadStatus(dom).textContent, 'Drop a .gpx file to choose it.');
    assert.equal(document.getElementById('GPXUpload').files[0].name, 'kept.gpx');
    assert.ok(processButton(dom));
});

test('selecting file B invalidates file A while capture settings are still loading', async () => {
    let releaseSettings;
    let settingsBlocked = false;
    const dom = await loadEditor({
        respond: () => ({ action: 'ignore' }),
        prepare: d => {
            const nativeGet = d.chrome.storage.sync.get;
            d.chrome.storage.sync.get = async key => {
                if (settingsBlocked) await new Promise(resolve => { releaseSettings = resolve; });
                return nativeGet(key);
            };
        },
    });
    await chooseGpx(dom, { name: 'A.gpx' });
    settingsBlocked = true;
    processButton(dom).click();
    await waitFor(dom, () => releaseSettings);

    await chooseGpx(dom, { name: 'B.gpx' });
    releaseSettings();
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_START'), false);
    assert.equal(uploadStatus(dom), null);
    assert.equal(processButton(dom)?.querySelector('.bpb-process-label').textContent, 'Process');
});

test('selecting file B invalidates file A while its body is still being read', async () => {
    const dom = await loadEditor({ respond: () => ({ action: 'ignore' }) });
    const input = await chooseGpx(dom, { name: 'A.gpx' });
    let releaseRead;
    let readStarted = false;
    input.files[0].text = async () => {
        readStarted = true;
        await new Promise(resolve => { releaseRead = resolve; });
        return GPX;
    };
    processButton(dom).click();
    await waitFor(dom, () => readStarted && releaseRead);

    await chooseGpx(dom, { name: 'B.gpx' });
    releaseRead();
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_START'), false);
    assert.equal(uploadStatus(dom), null);
    assert.equal(processButton(dom)?.querySelector('.bpb-process-label').textContent, 'Process');
});

test('a delayed A worker result cannot apply after B is selected, while processed B can', async () => {
    let releaseA;
    let startCount = 0;
    const dom = await loadEditor({
        respond: async message => {
            if (message.type === 'GPX_PROCESS_START') {
                startCount++;
                if (startCount === 1) await new Promise(resolve => { releaseA = resolve; });
                return {
                    phase: 'ready',
                    jobId: startCount === 1 ? 'job-A' : 'job-B',
                    boundPid: 7,
                    matches: [{
                        id: 7, name: 'Test Peak', confidence: 91,
                        classification: 'strong', selected: true,
                    }],
                };
            }
            if (message.type === 'GPX_PROCESS_APPLY') return { ok: true, tabIds: [5] };
            return undefined;
        },
    });
    await chooseGpx(dom, { name: 'A.gpx' });
    processButton(dom).click();
    await waitFor(dom, () => releaseA);

    await chooseGpx(dom, { name: 'B.gpx' });
    releaseA();
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'), false);
    assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null);
    assert.equal(uploadStatus(dom), null);

    processButton(dom).click();
    await waitFor(dom, () => dom.messages.some(message =>
        message.type === 'GPX_PROCESS_APPLY' && message.jobId === 'job-B'));
    assert.equal(dom.messages.filter(message => message.type === 'GPX_PROCESS_APPLY').length, 1);
    const startB = dom.messages.filter(message => message.type === 'GPX_PROCESS_START')[1];
    const applyB = dom.messages.find(message => message.type === 'GPX_PROCESS_APPLY');
    assert.equal(applyB.selectionGeneration, startB.selectionGeneration);
    assert.equal(applyB.selectionNonce, startB.selectionNonce);
});

test('B selection supersedes an A Apply that settles late', async () => {
    let releaseApply;
    const dom = await loadEditor({
        respond: async message => {
            if (message.type === 'GPX_PROCESS_START') return {
                phase: 'ready', jobId: 'job-A', boundPid: 7,
                matches: [{ id: 7, name: 'Test Peak', confidence: 91, classification: 'strong', selected: true }],
            };
            if (message.type === 'GPX_PROCESS_APPLY') {
                await new Promise(resolve => { releaseApply = resolve; });
                return { ok: true, tabIds: [5] };
            }
            return undefined;
        },
    });
    await chooseGpx(dom, { name: 'A.gpx' });
    processButton(dom).click();
    await waitFor(dom, () => releaseApply);
    await chooseGpx(dom, { name: 'B.gpx' });
    releaseApply();
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));

    assert.equal(uploadStatus(dom), null);
    assert.equal(processButton(dom)?.querySelector('.bpb-process-label').textContent, 'Process');
    assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null);
});

test('clearing, replacing, removing, or navigating invalidates a delayed A result', async () => {
    const cases = [
        ['cleared selection', async dom => {
            const input = dom.window.document.getElementById('GPXUpload');
            Object.defineProperty(input, 'files', { value: [], configurable: true, writable: true });
            fireTrustedEvent(input, 'change', { bubbles: true });
        }],
        ['non-GPX replacement', dom => chooseGpx(dom, { name: 'photo.jpeg', content: 'not gpx' })],
        ['native Remove', async dom => {
            dom.window.document.getElementById('GPXRemove').dispatchEvent(
                new dom.window.Event('click', { bubbles: true }));
        }],
        ['tab navigation', async dom => {
            dom.window.dispatchEvent(new dom.window.Event('pagehide'));
        }],
    ];

    for (const [label, replace] of cases) {
        let releaseA;
        const dom = await loadEditor({
            respond: async message => {
                if (message.type === 'GPX_PROCESS_START') {
                    await new Promise(resolve => { releaseA = resolve; });
                    return {
                        phase: 'ready', jobId: `job-A-${label}`, boundPid: 7,
                        matches: [{
                            id: 7, name: 'Test Peak', confidence: 91,
                            classification: 'strong', selected: true,
                        }],
                    };
                }
                if (message.type === 'GPX_PROCESS_APPLY') return { ok: true, tabIds: [5] };
                return undefined;
            },
        });
        await chooseGpx(dom, { name: 'A.gpx' });
        processButton(dom).click();
        await waitFor(dom, () => releaseA);

        await replace(dom);
        releaseA();
        await new Promise(resolve => dom.window.setTimeout(resolve, 20));

        assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'), false, label);
        assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null, label);
        assert.equal(uploadStatus(dom), null, label);
        assert.equal(processButton(dom), null, label);
        assert.equal(dom.window.document.getElementById('GPXPreview')
            .classList.contains('bpb-native-preview-hidden'), false, label);
    }
});

test('file selection sends only an opaque nonce and fails closed with a dead worker', async () => {
    const dom = await loadEditor();
    let reads = 0;
    let invalidation = null;
    dom.chrome.runtime.sendMessage = async message => {
        invalidation = structuredClone(message);
        throw new Error('Extension context invalidated.');
    };
    const input = dom.window.document.getElementById('GPXUpload');
    const file = new dom.window.File([GPX], 'private-name.gpx', { type: 'application/gpx+xml' });
    file.text = async () => { reads++; return GPX; };
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    fireTrustedEvent(input, 'change', { bubbles: true });

    await waitFor(dom, () => uploadStatus(dom));
    assert.equal(invalidation.type, 'GPX_PROCESS_INVALIDATE');
    assert.equal(typeof invalidation.selectionNonce, 'string');
    assert.equal(Object.hasOwn(invalidation, 'fileIdentity'), false);
    assert.doesNotMatch(JSON.stringify(invalidation), /private-name\.gpx|application\/gpx\+xml/);
    assert.equal(reads, 0, 'selection nonce must not read or hash the GPX body');
    assert.equal(processButton(dom), null);
    assert.match(uploadStatus(dom).textContent, /selected GPX could not be prepared/);
});

test('Process parses on the page without disclosing local-file metadata and auto-applies a bound match', async () => {
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
    await chooseGpx(dom, {
        name: 'private-hike-unique.gpx',
        type: 'application/x-private-gpx',
        lastModified: 1_977_609_599_123,
    });
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
    assert.doesNotMatch(JSON.stringify(dom.messages),
        /private-hike-unique\.gpx|application\/x-private-gpx|1977609599123/,
        'local file metadata must never cross the extension messaging boundary');

    const apply = dom.messages.find(message => message.type === 'GPX_PROCESS_APPLY');
    assert.deepEqual(JSON.parse(JSON.stringify({
        type: apply.type,
        jobId: apply.jobId,
        selectedIds: apply.selectedIds,
        primaryId: apply.primaryId,
    })), { type: 'GPX_PROCESS_APPLY', jobId: 'job-1', selectedIds: [7], primaryId: 7 });
    assert.equal(apply.selectionGeneration, start.selectionGeneration);
    assert.equal(apply.selectionNonce, start.selectionNonce);

    assert.ok(labels.includes('Reading track…') || labels.includes('Finding summits…'),
        'the busy label cycles through real states');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.disabled, true);
    assert.equal(button.querySelector('.bpb-process-label').textContent, 'Filling form…',
        'the button stays busy until Peakbagger’s postback reloads the page');
    observer.disconnect();
});

test('timezone resolution ignores route-invalid coordinates and untrustworthy timestamps', async () => {
    const content = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
      <trkpt lat="49.5" lon="999"><time>2026-01-01T12:00:00Z</time></trkpt>
      <trkpt lat="49.5" lon="-123.1"><time>not-a-time</time></trkpt>
      <trkpt lat="49.5" lon="-123.099"><time>2026-07-01T15:00:00Z</time></trkpt>
      <trkpt lat="49.5" lon="-999"><time>2026-01-01T12:00:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const dom = await loadEditor({
        respond: message => message.type === 'GPX_PROCESS_START'
            ? { phase: 'no-matches' }
            : { action: 'ignore' }
    });
    await chooseGpx(dom, { content });
    processButton(dom).click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_START'));

    const start = dom.messages.find(message => message.type === 'GPX_PROCESS_START');
    assert.equal(start.utcOffsetMinutes, -420,
        'the valid July point, not rejected January coordinates or an invalid time, controls DST');
});

test('timezone resolution observes DST and stays unknown for an all-invalid route', async () => {
    const process = async content => {
        const dom = await loadEditor({
            respond: message => message.type === 'GPX_PROCESS_START'
                ? { phase: 'no-matches' }
                : { action: 'ignore' }
        });
        await chooseGpx(dom, { content });
        processButton(dom).click();
        await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_START'));
        return dom.messages.find(message => message.type === 'GPX_PROCESS_START').utcOffsetMinutes;
    };
    const gpx = (lat, lon, time) => `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
      <trkpt lat="${lat}" lon="${lon}"><time>${time}</time></trkpt>
    </trkseg></trk></gpx>`;

    assert.equal(await process(gpx(49.5, -123.1, '2026-01-15T12:00:00Z')), -480);
    assert.equal(await process(gpx(49.5, -123.1, '2026-07-15T12:00:00Z')), -420);
    assert.equal(await process(gpx(999, 999, '2026-07-15T12:00:00Z')), null);
});

test('the trip name is sent only when Trip Info filling is enabled', async () => {
    const dom = await loadEditor({
        settings: { fillTripInfo: true },
        respond: message => message.type === 'GPX_PROCESS_START'
            ? { phase: 'no-matches' }
            : { action: 'ignore' }
    });
    await chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_START'));
    assert.equal(dom.messages.find(message => message.type === 'GPX_PROCESS_START').trackName, 'Corridor walk');
});

test('local upload fails before reading the file when capture settings are unavailable', async () => {
    const errors = [];
    const dom = await loadEditor({
        prepare: d => {
            d.chrome.storage.sync.get = async () => {
                throw new Error('SYNC_UPLOAD_SETTINGS_SENTINEL');
            };
            d.window.console.error = (...args) => { errors.push(args); };
        },
        respond: message => message.type === 'DRAFT_READY' ? { action: 'ignore' } : null,
    });
    const input = await chooseGpx(dom);
    let fileReads = 0;
    input.files[0].text = async () => {
        fileReads++;
        return GPX;
    };
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));

    assert.equal(uploadStatus(dom).textContent,
        'Capture settings could not be read. Reload and try again. Nothing was captured.');
    assert.equal(fileReads, 0, 'the GPX must remain unread while privacy choices are unknown');
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_START'), false);
    assert.match(errors.flat().map(String).join('\n'), /SYNC_UPLOAD_SETTINGS_SENTINEL/);
});

test('local upload rejects an oversized file before reading or messaging the worker', async () => {
    const dom = await loadEditor({
        respond: message => message.type === 'DRAFT_READY' ? { action: 'ignore' } : null,
    });
    const input = await chooseGpx(dom, { size: MAX_GPX_BYTES + 1 });
    let read = false;
    input.files[0].text = async () => { read = true; return GPX; };

    processButton(dom).click();
    await waitFor(dom, () => /too large to process safely/.test(uploadStatus(dom)?.textContent || ''));

    assert.equal(read, false);
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_START'), false);
    assert.match(uploadStatus(dom).textContent, /16 MiB.*20,000 track points/);
});

test('processing failures name the problem and restore the native Preview', async () => {
    const dom = await loadEditor({
        respond: message => message.type === 'GPX_PROCESS_START'
            ? { phase: 'error', error: { code: 'peakbagger-signed-out', message: 'Your Peakbagger login could not be verified. Confirm you’re signed in, then try again.' } }
            : { action: 'ignore' }
    });
    await chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));

    const status = uploadStatus(dom);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.match(status.textContent, /login could not be verified/);
    assert.equal(processButton(dom), null, 'failure restores the native path');
    assert.equal(dom.window.document.getElementById('GPXPreview')
        .classList.contains('bpb-native-preview-hidden'), false);
});

test('runtime exceptions are logged without entering the local-upload status', async () => {
    const sentinel = 'RAW_UPLOAD_SENTINEL: chrome.runtime.lastError';
    const errors = [];
    const dom = await loadEditor({
        prepare: d => {
            d.window.console.error = (...args) => { errors.push(args); };
        },
        respond: message => {
            if (message.type === 'DRAFT_READY') return { action: 'ignore' };
            throw new Error(sentinel);
        }
    });
    await chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));

    assert.match(uploadStatus(dom).textContent, /GPX file could not be read/);
    assert.doesNotMatch(uploadStatus(dom).textContent, /RAW_UPLOAD_SENTINEL|chrome\.runtime/);
    assert.match(errors.flat().map(String).join('\n'), /RAW_UPLOAD_SENTINEL/);
});

test('an unparseable file fails inline without leaving the page broken', async () => {
    const dom = await loadEditor({
        respond: () => ({ action: 'ignore' })
    });
    await chooseGpx(dom, { content: '<gpx><trk><trkseg></gpx' });
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));
    assert.match(uploadStatus(dom).textContent, /GPX file contains invalid XML/);
    assert.equal(processButton(dom), null);
    assert.equal(dom.messages.some(message => message.type === 'GPX_PROCESS_START'), false,
        'nothing crosses to the worker when the file cannot be parsed');
});

test('a waypoint-only file points the user back at Peakbagger’s own path', async () => {
    const dom = await loadEditor({ respond: () => ({ action: 'ignore' }) });
    await chooseGpx(dom, { content: '<gpx><wpt lat="1" lon="2"/></gpx>' });
    processButton(dom).click();
    await waitFor(dom, () => uploadStatus(dom));
    assert.match(uploadStatus(dom).textContent, /no track points.*Preview may still accept/i);
    assert.equal(processButton(dom), null);
});

const MULTI_MATCHES = [
    { id: 7, name: 'First Peak', confidence: 91, classification: 'strong', selected: true, date: '2026-07-01', time: '08:12', upDistanceM: 3400 },
    { id: 8, name: 'Second Peak', confidence: 72, classification: 'probable', selected: false, date: '2026-07-01', time: '10:40', upDistanceM: 7800 }
];

const loadCard = async ({
    boundPid = 7, matches = MULTI_MATCHES, boundFallback = null,
    applyResult = { ok: true, tabIds: [5, 100] }, settings = {}, prepare = null
} = {}) => {
    const dom = await loadEditor({
        settings,
        prepare,
        respond: message => {
            if (message.type === 'DRAFT_READY') return { action: 'ignore' };
            if (message.type === 'GPX_PROCESS_START') {
                return { phase: 'ready', jobId: 'job-2', boundPid, matches, boundFallback };
            }
            if (message.type === 'GPX_PROCESS_APPLY') {
                return typeof applyResult === 'function' ? applyResult(message) : applyResult;
            }
            return undefined;
        }
    });
    await chooseGpx(dom);
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
    assert.match(card.querySelector('.bpb-summit-meta').textContent, /at 08:12 · 2\.1 mi/,
        'Auto follows the fixture’s imperial-first native ascent fields');
    assert.equal(apply.textContent, 'Fill this ascent');

    checkboxes[1].click();
    assert.equal(apply.textContent, 'Fill + open 1 draft');

    apply.click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));
    const message = dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY');
    assert.deepEqual(JSON.parse(JSON.stringify({
        type: message.type,
        jobId: message.jobId,
        selectedIds: message.selectedIds,
        primaryId: message.primaryId,
    })), { type: 'GPX_PROCESS_APPLY', jobId: 'job-2', selectedIds: [7, 8], primaryId: 7 });
    await waitFor(dom, () => !dom.window.document.querySelector('.bpb-summit-card'));
    const button = processButton(dom);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.querySelector('.bpb-process-label').textContent, 'Filling form…');
});

test('a rejected Apply restores the native path without exposing the browser exception', async () => {
    const dom = await loadCard({
        applyResult: () => { throw new Error('Extension context invalidated.'); }
    });
    cardParts(dom).apply.click();

    await waitFor(dom, () => uploadStatus(dom));
    assert.match(uploadStatus(dom).textContent, /prepared draft could not be delivered/);
    assert.doesNotMatch(uploadStatus(dom).textContent, /Extension context invalidated/);
    assert.equal(uploadStatus(dom).getAttribute('role'), 'alert');
    assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null);
    assert.equal(processButton(dom), null, 'the dead-worker path must not remain stuck at Filling form');
    assert.equal(dom.window.document.getElementById('GPXPreview')
        .classList.contains('bpb-native-preview-hidden'), false);
});

test('summit distances honor explicit units and Auto follows metric-first page fields', async () => {
    const explicitMetric = await loadCard({ settings: { units: 'metric' } });
    assert.match(explicitMetric.window.document.querySelector('.bpb-summit-meta').textContent,
        /at 08:12 · 3\.4 km/);

    const autoMetric = await loadCard({
        prepare: d => {
            const miles = d.window.document.getElementById('UpMi');
            const kilometers = d.window.document.getElementById('UpKm');
            miles.parentNode.insertBefore(kilometers, miles);
        }
    });
    assert.match(autoMetric.window.document.querySelector('.bpb-summit-meta').textContent,
        /at 08:12 · 3\.4 km/);
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
        /closest approach to Bound Peak is 787 ft from the summit/);
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
    const applied = dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY');
    assert.deepEqual(JSON.parse(JSON.stringify({
        type: applied.type,
        jobId: applied.jobId,
        selectedIds: applied.selectedIds,
        primaryId: applied.primaryId,
    })), { type: 'GPX_PROCESS_APPLY', jobId: 'job-2', selectedIds: [7], primaryId: 7 });
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
    await chooseGpx(dom);
    processButton(dom).click();
    await waitFor(dom, () => dom.messages.some(message => message.type === 'GPX_PROCESS_APPLY'));
    assert.equal(dom.window.document.querySelector('.bpb-summit-card'), null);
    assert.equal(dom.messages.find(entry => entry.type === 'GPX_PROCESS_APPLY').primaryId, 7);
});

test('the stylesheet keeps its reduced-motion and dark-theme guards', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new globalThis.URL('../../src/ascent/ascent-upload.css', import.meta.url), 'utf8');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /html\[data-bpb-theme='dark'\] \.bpb-process-button/);
    assert.match(css, /html\[data-bpb-theme='dark'\] \.bpb-capture-hint/);
    assert.match(css, /html\[data-bpb-theme='dark'\] \.bpb-gpx-drop-zone\.is-gpx-drag-over/);
    assert.match(css, /\.bpb-gpx-drop-zone \{ transition: none; \}/);
    assert.match(css, /animation: none !important/);
});
