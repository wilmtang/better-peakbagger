// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An interrupted GPX re-preparation must not leave Save, Preview and the file
// input blocked. The built ascent-editor bundle runs on the captured form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, waitFor, fireTrustedEvent, PAGE_FIXTURES } from '../helpers/load-page.mjs';
import type { PageDom, StubMessage } from '../helpers/page-types.mts';

const URL = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=7&cid=900001';
const GPX = `<?xml version="1.0"?><gpx creator="SourceApp" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Corridor walk</name><trkseg>
    <trkpt lat="49.5" lon="-123.1"><ele>100</ele><time>2026-07-01T15:00:00Z</time></trkpt>
    <trkpt lat="49.5" lon="-123.099"><ele>130</ele><time>2026-07-01T16:00:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
const match = (id: number, name: string, confidence: number) => ({ id, name, classification: 'strong', confidence, time: '9:00 AM', upDistanceM: 1000 });

type EditorDom = PageDom & { holdNextPreparation: () => void; release: () => void };

// Every GPX_PROCESS_INVALIDATE answers at once, except the one a test chose
// to hold: that is the re-preparation in flight.
const loadEditor = async (startReply: Record<string, unknown>, settings: Record<string, unknown> = { removeGpxTimestamps: true }) => {
    let hold = false; let releaseHeld: (() => void) | null = null;
    const dom = await (loadPage as (fixture: string, options: Record<string, unknown>) => Promise<EditorDom>)('climber-ascentedit.html', {
        url: URL, settings, bundles: ['vendor/marked.umd.js', 'content/ascent-editor.js'], fixtures: PAGE_FIXTURES,
        prepare: (d: EditorDom) => {
            class DataTransferMock { files: File[] = []; items = { add: (file: File) => this.files.push(file) }; }
            (d.window as unknown as { DataTransfer: unknown }).DataTransfer = DataTransferMock;
            d.chrome.runtime.sendMessage = async (message: StubMessage) => {
                if (message.type === 'GPX_PROCESS_INVALIDATE') {
                    if (hold) { hold = false; await new Promise<void>(resolve => { releaseHeld = resolve; }); }
                    return { ok: true };
                }
                if (message.type === 'GPX_PROCESS_START') return { ...startReply, pageSessionId: message.pageSessionId,
                    selectionGeneration: message.selectionGeneration, selectionNonce: message.selectionNonce };
                return { action: 'ignore' };
            };
            d.holdNextPreparation = () => { hold = true; };
            d.release = () => { releaseHeld?.(); };
        },
    });
    return dom;
};

const chooseGpx = async (dom: EditorDom) => {
    const input = dom.window.document.getElementById('GPXUpload') as HTMLInputElement;
    const file = new dom.window.File([GPX], 'walk.gpx', { type: 'application/gpx+xml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    fireTrustedEvent(input, 'change', { bubbles: true });
    await waitFor(dom, () => dom.window.document.querySelector('.bpb-process-button'));
    return input;
};

const toggleTimestamps = (dom: EditorDom) => {
    const checkbox = dom.window.document.getElementById('bpb-include-timestamps-once') as HTMLInputElement;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new dom.window.Event('change'));
};

// A Save click that the preparation guard does not swallow.
const saveReachesForm = (dom: EditorDom) => {
    const save = dom.window.document.getElementById('SaveButton')!;
    let reached = false;
    const listener = () => { reached = true; };
    dom.window.document.addEventListener('click', listener);
    save.addEventListener('click', event => event.preventDefault(), { once: true });
    save.click();
    dom.window.document.removeEventListener('click', listener);
    return reached;
};

const settle = (dom: EditorDom) => new Promise(resolve => dom.window.setTimeout(resolve, 20));

test('Attach GPX during a timestamp re-preparation leaves Save and the file input usable', async () => {
    const dom = await loadEditor({ phase: 'no-matches' });
    try {
        const input = await chooseGpx(dom);
        dom.holdNextPreparation();
        toggleTimestamps(dom);
        await waitFor(dom, () => input.disabled);
        dom.window.document.querySelector('.bpb-attach-gpx-button').click();
        await settle(dom);
        dom.release();
        await waitFor(dom, () => !input.disabled);
        assert.equal(saveReachesForm(dom), true, 'Save reaches the form once the preparation settles');
    } finally { dom.window.close(); }
});

test('the summit card Cancel during a re-preparation leaves Save and the file input usable', async () => {
    const dom = await loadEditor({ phase: 'ready', jobId: 'job', matches: [match(7, 'First', 95), match(8, 'Second', 90)] });
    try {
        const input = await chooseGpx(dom);
        dom.window.document.querySelector('.bpb-process-button').click();
        await waitFor(dom, () => dom.window.document.querySelector('.bpb-summit-card'));
        dom.holdNextPreparation();
        toggleTimestamps(dom);
        await waitFor(dom, () => input.disabled);
        const cancel = dom.window.document.querySelector('.bpb-summit-cancel');
        const waiting = cancel.getAttribute('aria-disabled');
        cancel.click();
        await settle(dom);
        dom.release();
        await waitFor(dom, () => !input.disabled);
        assert.equal(saveReachesForm(dom), true);
        assert.equal(waiting, 'true', 'card actions wait for the re-preparation');
    } finally { dom.window.close(); }
});

test('a page suspend during a preparation still releases its latch when it settles', async () => {
    const dom = await loadEditor({ phase: 'no-matches' });
    try {
        const input = await chooseGpx(dom);
        dom.holdNextPreparation();
        toggleTimestamps(dom);
        await waitFor(dom, () => input.disabled);
        // A persisted pagehide suspends without starting another preparation.
        const hide = new dom.window.Event('pagehide');
        Object.defineProperty(hide, 'persisted', { value: true });
        dom.window.dispatchEvent(hide);
        await settle(dom);
        dom.release();
        await waitFor(dom, () => !input.disabled);
        assert.equal(saveReachesForm(dom), true);
    } finally { dom.window.close(); }
});

test('turning timestamp removal on re-prepares a chosen file before Save can send it', async () => {
    const dom = await loadEditor({ phase: 'no-matches' }, { removeGpxTimestamps: false });
    const attachedText = () => (dom.window.document.getElementById('GPXUpload') as HTMLInputElement).files![0].text();
    try {
        await chooseGpx(dom);
        await settle(dom);
        assert.match(await attachedText(), /<time>/, 'removal is off: the original is attached');
        await dom.chrome.storage.sync.set({ bpbSettings: { removeGpxTimestamps: true } });
        const deadline = Date.now() + 3000;
        while (/<time>/.test(await attachedText()) && Date.now() < deadline) await settle(dom);
        assert.doesNotMatch(await attachedText(), /<time>/, 'the native field no longer holds recorded times');
    } finally { dom.window.close(); }
});
