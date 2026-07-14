// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await fs.readFile(new URL('../src/ascent-draft.js', import.meta.url), 'utf8');

const formHtml = `<!doctype html><body><form>
  <input id="DateText"><input id="SuffixText"><input id="StartFt"><input id="StartM"><input id="EndFt"><input id="EndM">
  <input id="GainFt" value="300"><input id="GainM" value="91"><input id="ExUpFt"><input id="ExUpM"><input id="ExDnFt"><input id="ExDnM">
  <input id="UpMi"><input id="UpKm"><input id="DnMi"><input id="DnKm"><input id="UpDay"><input id="UpHr"><input id="UpMin">
  <input id="DnDay"><input id="DnHr"><input id="DnMin"><input id="GPXUpload" type="file">
  <button id="GPXPreview" type="button">Preview</button><button id="SaveButton" type="button">Save</button>
</form></body>`;

const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 30));

const loadDraft = responseFactory => {
    const dom = new JSDOM(formHtml, {
        url: 'https://peakbagger.com/climber/ascentedit.aspx?pid=12&cid=34',
        runScripts: 'outside-only'
    });
    const messages = [];
    dom.window.chrome = {
        runtime: {
            sendMessage: async message => {
                messages.push(message);
                return responseFactory(message);
            }
        }
    };
    class DataTransferMock {
        constructor() {
            this.files = [];
            this.items = { add: file => this.files.push(file) };
        }
    }
    dom.window.DataTransfer = DataTransferMock;
    Object.defineProperty(dom.window.document.getElementById('GPXUpload'), 'files', {
        value: [], writable: true, configurable: true
    });
    dom.window.eval(source);
    return { dom, messages };
};

test('fills the expected fields, attaches coordinate-only GPX, previews once, and never saves', async () => {
    let previewClicks = 0;
    let saveClicks = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        fields: {
            date: '2026-07-01', time: '08:45', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 }
        },
        gpx: '<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="47" lon="-121"></trkpt></trkseg></trk></gpx>'
    };
    const { dom, messages } = loadDraft(message => message.type === 'DRAFT_READY' ? payload : { ok: true });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    dom.window.document.getElementById('SaveButton').addEventListener('click', () => { saveClicks++; });
    await waitForAsync();

    assert.equal(dom.window.document.getElementById('DateText').value, '2026-07-01');
    assert.equal(dom.window.document.getElementById('SuffixText').value, '08:45');
    assert.equal(dom.window.document.getElementById('UpMi').value, '3.11');
    assert.equal(dom.window.document.getElementById('UpKm').value, '5.00');
    assert.equal(dom.window.document.getElementById('StartM').value, '1000');
    assert.equal(dom.window.document.getElementById('UpHr').value, '2');
    assert.equal(dom.window.document.getElementById('GPXUpload').files.length, 1);
    assert.equal(previewClicks, 1);
    assert.equal(saveClicks, 0);
    assert.deepEqual(messages.map(message => message.type), ['DRAFT_READY', 'DRAFT_PREVIEW_STARTED']);
});

test('a post-preview reload shows the confidence banner without another submission', async () => {
    const { dom, messages } = loadDraft(() => ({ action: 'banner', classification: 'probable', confidence: 71 }));
    let previewClicks = 0;
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForAsync();
    assert.equal(previewClicks, 0);
    assert.equal(messages.length, 1);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /Probable match · 71%/);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /Preview submitted/);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /Save is manual/);
});

test('ordinary Peakbagger editor tabs are left completely untouched', async () => {
    const { dom, messages } = loadDraft(() => ({ action: 'ignore' }));
    await waitForAsync();
    assert.equal(messages.length, 1);
    assert.equal(dom.window.document.getElementById('bpb-draft-banner'), null);
    assert.equal(dom.window.document.getElementById('DateText').value, '');
});

test('privacy guard blocks a payload containing time, elevation, or extensions', async () => {
    const { dom, messages } = loadDraft(message => message.type === 'DRAFT_READY' ? {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 90,
        fields: {
            date: '2026-01-01', time: '', startElevationM: 1, endElevationM: 1,
            upDistanceM: 1, downDistanceM: 1, upGainM: 1, downGainM: 0,
            upDuration: { days: 0, hours: 0, minutes: 0 }, downDuration: { days: 0, hours: 0, minutes: 0 }
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"><time>private</time></trkpt></trkseg></trk></gpx>'
    } : { ok: true });
    await waitForAsync();
    assert.deepEqual(messages.map(message => message.type), ['DRAFT_READY']);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /privacy check/);
});
