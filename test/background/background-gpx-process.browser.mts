// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End to end: the real ascentedit fixture page (built content bundle) wired
// to the real built worker, through a trusted file pick.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadPage, waitFor, fireTrustedEvent, PAGE_FIXTURES } from '../helpers/fixture-page.mts';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { editors } from '../helpers/report-editor-page.mts';
import type { LoadedPage } from '../helpers/fixture-page.mts';
import type { StubMessage } from '../helpers/page-types.mts';
import {
    createHarness, PAGE_URL, type Harness, type Values, type WorkerGlobals,
} from '../helpers/gpx-process-harness.mts';

const workerBundle = await fs.readFile(new URL('../../dist/background.js', import.meta.url), 'utf8');
const workerRealms: FixtureDom[] = [];
test.afterEach(() => { for (const realm of workerRealms.splice(0)) realm.window.close(); });

// The worker needs its own realm next to the page. A window realm also has
// document, DOMParser and storage, so this case does not prove the worker
// avoids them; the Node cases in background-gpx-process.test.mts do. As
// there, IndexedDB stays absent, which also skips the worker's Garmin inbox
// branches and keeps this origin's real database out.
const runWorker = (globals: WorkerGlobals) => {
    const realm = new FixtureDom('<!doctype html><title>Worker realm</title>');
    workerRealms.push(realm);
    Object.defineProperty(realm.window, 'indexedDB', { value: undefined });
    Object.assign(realm.window, globals);
    realm.window.eval(workerBundle);
};

// ---- End to end: real fixture page + built content bundle + built worker ----

// The sink carries worker→page delivery outside the harness's tab objects,
// which must stay structuredClone-able for the worker's tabs.get stub.
type PageListener = (message: Values) => void;
interface Sink { deliver?: (tabId: number, message: Values) => void }
const wireWorkerToPage = (harness: Harness, sink: Sink) => (dom: LoadedPage) => {
    const pageListeners: PageListener[] = [];
    dom.chrome.runtime.sendMessage = (message: StubMessage) =>
        harness.send(structuredClone(message), { tab: { id: 5, windowId: 9 }, url: dom.window.location.href });
    (dom.chrome.runtime as { onMessage?: unknown }).onMessage = { addListener: (listener: PageListener) => pageListeners.push(listener) };
    sink.deliver = (tabId, message) => {
        if (tabId === 5) pageListeners.forEach(listener => listener(message));
    };
};

test('end to end: user file pick → Process → filled form → exactly one GPS Preview', async () => {
    const harness = createHarness({ runWorker });
    // Route worker→tab messages to the page's runtime listeners.
    const sink: Sink = {};
    const dom = await loadPage('climber-ascentedit.html', {
        url: PAGE_URL,
        bundles: ['vendor/marked.umd.js', 'content/ascent-editor.js'],
        fixtures: PAGE_FIXTURES,
        prepare: wireWorkerToPage(harness, sink)
    });
    // Deliver DRAFT_PROCEED (recorded by the harness) into the page.
    const pump = () => {
        while (harness.tabMessages.length) {
            const { tabId, message } = harness.tabMessages.shift()!;
            sink.deliver?.(tabId, message);
        }
    };
    const pumpTimer = setInterval(pump, 5);

    let previewClicks = 0;
    const preview = dom.window.document.getElementById('GPXPreview');
    preview.addEventListener('click', event => {
        previewClicks++;
        event.preventDefault();
    });

    const gpx = `<?xml version="1.0"?><gpx creator="SourceApp" xmlns="http://www.topografix.com/GPX/1/1"
      xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
      <trk><name>Secret name</name><trkseg>
        <trkpt lat="0" lon="-0.001"><ele>100</ele><time>2026-07-01T15:00:00Z</time>
          <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>171</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
        <trkpt lat="0" lon="0"><ele>130</ele><time>2026-07-01T16:00:00Z</time></trkpt>
        <trkpt lat="0" lon="0.001"><ele>100</ele><time>2026-07-01T17:00:00Z</time></trkpt>
      </trkseg></trk></gpx>`;
    const input = dom.window.document.getElementById('GPXUpload');
    await fireTrustedEvent(input, { type: 'files', files: [{ name: 'myclimb.gpx', mimeType: 'application/gpx+xml', text: gpx }] });
    await waitFor(dom, () => dom.window.document.querySelector('.bpb-process-button'));

    const button = dom.window.document.querySelector('.bpb-process-button');
    assert.ok(button, 'the Process button replaces native Preview');
    button.click();

    try {
        await waitFor(dom, () => previewClicks === 1);
    } catch (error) {
        const status = dom.window.document.querySelector('.bpb-upload-status')?.textContent || '';
        const job = harness.values.bpbCaptureJobs?.['5'];
        throw new Error(`${(error as Error).message}; upload status=${status}; job phase=${job?.phase || 'none'}; messages=${JSON.stringify(harness.runtimeMessages)}`);
    } finally {
        clearInterval(pumpTimer);
    }

    assert.equal(dom.window.document.getElementById('DateText').value, '2026-07-01');
    assert.equal(dom.window.document.getElementById('StartM').value, '100');
    assert.equal(dom.window.document.getElementById('EndM').value, '100');

    const uploaded = input.files![0]!;
    assert.equal(uploaded.name, 'track.gpx', 'the upload field holds the newly serialized copy');
    const uploadedText = await uploaded.text();
    assert.match(uploadedText, /creator="Better Peakbagger"/);
    assert.doesNotMatch(uploadedText, /SourceApp|extensions|hr>|Secret name/,
        'the cleaned serialization carries nothing from the source XML');

    assert.equal(previewClicks, 1);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /confidence/);

    // The native peak picker is empty on this pid-bound fixture. The prepared
    // match name must still reach report autosave so the manager can render a
    // human title while retaining the pid-based storage key.
    const richEditor = editors(dom).rich;
    richEditor.commands.setContent('<p>Summit report</p>', { emitUpdate: true });
    const reportKey = 'bpbReportDraft:77:p7';
    await waitFor(dom, () => dom.chrome._localStore[reportKey]);
    assert.deepEqual(JSON.parse(JSON.stringify(dom.chrome._localStore[reportKey].label)), {
        peak: 'Test Peak',
        date: '2026-07-01'
    });

    // Simulated post-Preview reload: the second DRAFT_READY yields the banner,
    // never a second Preview.
    const afterReload = await harness.send({
        type: 'DRAFT_READY', pid: '7', cid: '77',
        previewResult: { state: 'success', message: 'GPX file successfully uploaded.' }
    });
    assert.equal(afterReload.action, 'banner');
    assert.equal(afterReload.peakName, 'Test Peak');
    assert.equal(previewClicks, 1);
});
