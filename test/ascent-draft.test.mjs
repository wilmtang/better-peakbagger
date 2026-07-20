// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// The built ascent-editor bundle (draft filling + report markup + editor); the
// editor stays dormant without a JournalText field, so it exercises draft fill.
const source = await fs.readFile(new URL('../dist/content/ascent-editor.js', import.meta.url), 'utf8');
const editorCss = await fs.readFile(new URL('../src/report-editor.css', import.meta.url), 'utf8');

const formHtml = `<!doctype html><body><form>
  <input id="DateText"><input id="SuffixText"><input id="StartFt"><input id="StartM"><input id="EndFt"><input id="EndM">
  <input id="GainFt" value="300"><input id="GainM" value="91"><input id="ExUpFt"><input id="ExUpM"><input id="ExDnFt"><input id="ExDnM">
  <input id="UpMi"><input id="UpKm"><input id="DnMi"><input id="DnKm"><input id="UpDay"><input id="UpHr"><input id="UpMin">
  <input id="DnDay"><input id="DnHr"><input id="DnMin"><input id="GPXUpload" type="file">
  <select id="TripDD"><option value="existing">Existing Trip</option><option value="new">**Add New Trip</option></select>
  <input id="TripSeqText"><input id="TripNameText"><input id="TripNightsText">
  <select id="AscentNightsDD">${Array.from({ length: 101 }, (_, value) => `<option value="${value}">${value}</option>`).join('')}</select>
  <span id="GPXStatusLabel">No GPS Data for this Ascent</span>
  <button id="GPXPreview" type="button">Preview</button><button id="SaveButton" type="button">Save</button>
</form></body>`;

const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 30));
const waitForCondition = async condition => {
    for (let attempt = 0; attempt < 50 && !condition(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

const loadDraft = (responseFactory, { statusText = 'No GPS Data for this Ascent', html = formHtml } = {}) => {
    const dom = new JSDOM(html, {
        url: 'https://peakbagger.com/climber/ascentedit.aspx?pid=12&cid=34',
        runScripts: 'outside-only'
    });
    const messages = [];
    const runtimeListeners = [];
    dom.window.document.getElementById('GPXStatusLabel').textContent = statusText;
    dom.window.chrome = {
        runtime: {
            sendMessage: async message => {
                messages.push(message);
                return responseFactory(message);
            },
            onMessage: { addListener: listener => runtimeListeners.push(listener) }
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
    const dispatchRuntimeMessage = message => runtimeListeners.forEach(listener => listener(message));
    return { dom, messages, dispatchRuntimeMessage };
};

test('fills the expected fields, attaches reduced GPX with elevation and time, previews once, and never saves', async () => {
    let previewClicks = 0;
    let saveClicks = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        fields: {
            date: '2026-07-01', time: '08:45', suffix: 'a', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 }
        },
        gpx: '<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="47" lon="-121"><ele>1000.5</ele><time>2026-07-01T15:45:00Z</time></trkpt></trkseg></trk></gpx>'
    };
    const { dom, messages } = loadDraft(message => message.type === 'DRAFT_READY' ? payload : { ok: true });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    dom.window.document.getElementById('SaveButton').addEventListener('click', () => { saveClicks++; });
    await waitForCondition(() => previewClicks === 1);

    assert.equal(dom.window.document.getElementById('DateText').value, '2026-07-01');
    assert.equal(dom.window.document.getElementById('SuffixText').value, 'a');
    assert.equal(dom.window.document.getElementById('UpMi').value, '3.11');
    assert.equal(dom.window.document.getElementById('UpKm').value, '5.00');
    assert.equal(dom.window.document.getElementById('StartM').value, '1000');
    assert.equal(dom.window.document.getElementById('UpHr').value, '2');
    assert.equal(dom.window.document.getElementById('GPXUpload').files.length, 1);
    assert.equal(previewClicks, 1);
    assert.equal(saveClicks, 0);
    assert.deepEqual(messages.map(message => message.type), ['DRAFT_READY', 'DRAFT_PREVIEW_STARTED']);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /91% confidence/);
    dom.window.close();
});

test('fills multi-peak Trip Info and accepts allowlisted waypoint names when capture permits them', async () => {
    let previewClicks = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        allowWaypoints: true,
        fields: {
            date: '2026-07-01', suffix: 'a', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 },
            tripInfo: { sequence: 2, name: 'Afternoon Hike', nightsOut: 1 },
            wildernessNightsOut: null
        },
        gpx: '<?xml version="1.0"?><gpx><wpt lat="47.1" lon="-121.2"><name>Camp &amp; Water</name></wpt><trk><trkseg><trkpt lat="47" lon="-121"></trkpt></trkseg></trk></gpx>'
    };
    const { dom } = loadDraft(message => message.type === 'DRAFT_READY' ? payload : { ok: true });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForCondition(() => previewClicks === 1);

    assert.equal(dom.window.document.getElementById('TripDD').value, 'new');
    assert.equal(dom.window.document.getElementById('TripSeqText').value, '2');
    assert.equal(dom.window.document.getElementById('TripNameText').value, 'Afternoon Hike');
    assert.equal(dom.window.document.getElementById('TripNightsText').value, '1');
    assert.equal(dom.window.document.getElementById('GPXUpload').files.length, 1);
    dom.window.close();
});

test('fills single-ascent wilderness nights without firing Peakbagger’s AutoPostBack change', async () => {
    let previewClicks = 0;
    let nightsChanges = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        fields: {
            date: '2026-07-01', suffix: '', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 1, hours: 2, minutes: 5 },
            downDuration: { days: 1, hours: 1, minutes: 55 },
            tripInfo: null, wildernessNightsOut: 2
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="47" lon="-121"></trkpt></trkseg></trk></gpx>'
    };
    const { dom } = loadDraft(message => message.type === 'DRAFT_READY' ? payload : { ok: true });
    dom.window.document.getElementById('AscentNightsDD').addEventListener('change', () => { nightsChanges++; });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForCondition(() => previewClicks === 1);

    assert.equal(dom.window.document.getElementById('AscentNightsDD').value, '2');
    assert.equal(nightsChanges, 0);
    dom.window.close();
});

test('the ascent-details setting leaves optional route fields untouched while Preview still runs', async () => {
    let previewClicks = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        fields: {
            date: '2026-07-01', suffix: '', fillAscentDetails: false,
            startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 }
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="47" lon="-121"></trkpt></trkseg></trk></gpx>'
    };
    const { dom } = loadDraft(message => message.type === 'DRAFT_READY' ? payload : { ok: true });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForCondition(() => previewClicks === 1);

    assert.equal(dom.window.document.getElementById('DateText').value, '2026-07-01');
    assert.equal(dom.window.document.getElementById('StartM').value, '');
    assert.equal(dom.window.document.getElementById('UpMi').value, '');
    assert.equal(previewClicks, 1);
    dom.window.close();
});

test('missing optional Peakbagger forms do not block the core date and GPX Preview flow', async () => {
    let previewClicks = 0;
    const minimalHtml = `<!doctype html><body><form>
      <input id="DateText"><input id="GPXUpload" type="file">
      <span id="GPXStatusLabel">No GPS Data for this Ascent</span>
      <button id="GPXPreview" type="button">Preview</button>
    </form></body>`;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        fields: {
            date: '2026-07-01', suffix: 'a', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 },
            tripInfo: { sequence: 1, name: 'Overnight trip', nightsOut: 1 },
            wildernessNightsOut: 1
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="47" lon="-121"></trkpt></trkseg></trk></gpx>'
    };
    const { dom } = loadDraft(message => message.type === 'DRAFT_READY' ? payload : { ok: true }, {
        html: minimalHtml
    });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForCondition(() => previewClicks === 1);

    assert.equal(dom.window.document.getElementById('DateText').value, '2026-07-01');
    assert.equal(dom.window.document.getElementById('GPXUpload').files.length, 1);
    assert.equal(previewClicks, 1);
    assert.doesNotMatch(dom.window.document.getElementById('bpb-draft-banner').textContent, /stopped/i);
    dom.window.close();
});

test('post-Preview day rows are filled once and acknowledged without another Preview', async () => {
    const dayRows = Array.from({ length: 2 }, (_, index) => {
        const sequence = index + 1;
        return `<input id="Date${sequence}"><input id="GainFt${sequence}"><input id="GainM${sequence}" value="${sequence === 1 ? '999' : ''}">
          <input id="LossFt${sequence}"><input id="LossM${sequence}"><input id="DistMi${sequence}"><input id="DistKm${sequence}">
          <input id="MaxFt${sequence}"><input id="MaxM${sequence}"><input id="CampFt${sequence}"><input id="CampM${sequence}">`;
    }).join('');
    const html = formHtml.replace('<span id="GPXStatusLabel">', `${dayRows}<span id="GPXStatusLabel">`);
    const response = {
        action: 'banner', classification: 'strong', confidence: 91,
        jobId: 'job', pid: '12', cid: '34', dayStatsPending: true,
        dayStats: [
            { date: '2026-07-11', gainM: 400, lossM: 50, distanceM: 1609.344, maxElevationM: 1400, campElevationM: 1200 },
            { date: '2026-07-12', gainM: 600, lossM: 900, distanceM: 8046.72, maxElevationM: 2100, campElevationM: null }
        ]
    };
    const { dom, messages } = loadDraft(message => message.type === 'DRAFT_READY' ? response : { ok: true }, {
        html,
        statusText: 'Your file is now successfully uploaded.'
    });
    await waitForCondition(() => messages.some(message => message.type === 'DRAFT_DAY_STATS_APPLIED'));

    assert.equal(dom.window.document.getElementById('Date1').value, '2026-07-11');
    assert.equal(dom.window.document.getElementById('GainFt1').value, '1312');
    assert.equal(dom.window.document.getElementById('GainM1').value, '999', 'existing server/user values must not be overwritten');
    assert.equal(dom.window.document.getElementById('LossFt1').value, '164');
    assert.equal(dom.window.document.getElementById('DistMi1').value, '1.000');
    assert.equal(dom.window.document.getElementById('MaxM2').value, '2100');
    assert.equal(dom.window.document.getElementById('CampM1').value, '1200');
    assert.equal(dom.window.document.getElementById('CampM2').value, '');
    assert.deepEqual(messages.map(message => message.type), ['DRAFT_READY', 'DRAFT_DAY_STATS_APPLIED']);
    assert.deepEqual({ ...messages[1] }, {
        type: 'DRAFT_DAY_STATS_APPLIED', jobId: 'job', pid: '12', cid: '34'
    });
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /Preview is ready/);
    dom.window.close();
});

test('a post-preview reload shows a dismissible, short-lived confidence toast without another submission', async () => {
    const { dom, messages } = loadDraft(
        () => ({ action: 'banner', classification: 'probable', confidence: 71 }),
        { statusText: 'Your file is now successfully uploaded.' });
    let previewClicks = 0;
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForAsync();
    assert.equal(previewClicks, 0);
    assert.equal(messages.length, 1);
    assert.deepEqual({ ...messages[0].previewResult }, {
        state: 'success', message: 'Your file is now successfully uploaded.'
    });
    const banner = dom.window.document.getElementById('bpb-draft-banner');
    assert.match(banner.textContent, /Probable match · 71% confidence/);
    assert.match(banner.textContent, /Preview is ready/);
    assert.ok(banner.classList.contains('bpb-draft-banner-probable'));
    assert.equal(banner.style.position, '', 'layout and colors belong to the theme-aware stylesheet');
    assert.equal(banner.dataset.autoDismissMs, '4000');
    const dismiss = banner.querySelector('button[aria-label="Dismiss notification"]');
    assert.ok(dismiss);
    dismiss.click();
    assert.equal(dom.window.document.getElementById('bpb-draft-banner'), null);
    dom.window.close();
});

test('draft banner CSS covers semantic states in explicit light and dark themes', () => {
    for (const theme of ['light', 'dark']) {
        for (const kind of ['strong', 'probable', 'waiting', 'error']) {
            assert.match(editorCss, new RegExp(`html\\[data-bpb-theme="${theme}"\\] \\.bpb-draft-banner-${kind}\\s*\\{`));
        }
    }
    assert.match(editorCss, /prefers-color-scheme:\s*dark/);
    assert.match(editorCss, /prefers-reduced-motion:\s*reduce/);
});

test('a rejected Preview reports Peakbagger’s error and retries only after the user asks', async () => {
    let readyCalls = 0;
    let previewClicks = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 91,
        fields: {
            date: '2026-07-01', suffix: '', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 }
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="47" lon="-121"><ele>1000</ele><time>2026-07-01T15:45:00Z</time></trkpt></trkseg></trk></gpx>'
    };
    const { dom, messages } = loadDraft(message => {
        if (message.type !== 'DRAFT_READY') return { ok: true };
        readyCalls++;
        return readyCalls === 1
            ? { action: 'preview-error', message: 'Peakbagger rejected GPS Preview: Invalid GPX file. The GPX and draft were kept.' }
            : payload;
    }, { statusText: 'Invalid GPX file.' });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForCondition(() => dom.window.document.getElementById('bpb-draft-banner'));

    assert.deepEqual({ ...messages[0].previewResult }, { state: 'error', message: 'Invalid GPX file.' });
    assert.equal(previewClicks, 0);
    const retry = [...dom.window.document.querySelectorAll('#bpb-draft-banner button')]
        .find(button => button.textContent === 'Retry GPS Preview');
    assert.ok(retry);
    retry.click();
    await waitForCondition(() => previewClicks === 1);
    assert.deepEqual(messages.map(message => message.type),
        ['DRAFT_READY', 'DRAFT_READY', 'DRAFT_PREVIEW_STARTED']);
    assert.equal(previewClicks, 1);
    dom.window.close();
});

test('a queued draft waits persistently and starts when the background releases it', async () => {
    let readyCalls = 0;
    let previewClicks = 0;
    const payload = {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'probable', confidence: 71,
        fields: {
            date: '2026-07-01', suffix: 'b', startElevationM: 1000, endElevationM: 900,
            upDistanceM: 5000, downDistanceM: 6000, upGainM: 1200, downGainM: 80,
            upDuration: { days: 0, hours: 2, minutes: 5 },
            downDuration: { days: 0, hours: 1, minutes: 55 }
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="47" lon="-121"></trkpt></trkseg></trk></gpx>'
    };
    const { dom, dispatchRuntimeMessage } = loadDraft(message => {
        if (message.type !== 'DRAFT_READY') return { ok: true };
        readyCalls++;
        return readyCalls === 1
            ? { action: 'wait', message: 'Waiting for the previous GPS Preview to finish.' }
            : payload;
    });
    dom.window.document.getElementById('GPXPreview').addEventListener('click', () => { previewClicks++; });
    await waitForCondition(() => /Waiting/.test(dom.window.document.getElementById('bpb-draft-banner')?.textContent || ''));
    assert.equal(dom.window.document.getElementById('bpb-draft-banner').dataset.autoDismissMs, undefined);

    dispatchRuntimeMessage({ type: 'DRAFT_PROCEED' });
    await waitForCondition(() => previewClicks === 1);
    assert.equal(readyCalls, 2);
    assert.equal(previewClicks, 1);

    dispatchRuntimeMessage({ type: 'DRAFT_CLEARED' });
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /no longer connected/);
    dom.window.close();
});

test('ordinary Peakbagger editor tabs get only the fresh-form date autofill', async () => {
    const { dom, messages } = loadDraft(() => ({ action: 'ignore' }));
    await waitForAsync();
    assert.equal(messages.length, 1);
    assert.equal(dom.window.document.getElementById('bpb-draft-banner'), null);
    // The bundled ascent-upload module deliberately fills an empty Ascent Date
    // with the local today; the draft machinery must fill nothing else.
    const pad = value => String(value).padStart(2, '0');
    const today = new Date();
    assert.equal(dom.window.document.getElementById('DateText').value,
        `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
    for (const id of ['SuffixText', 'StartM', 'EndM', 'UpMi', 'TripNameText']) {
        assert.equal(dom.window.document.getElementById(id).value, '', `${id} must stay untouched`);
    }
    assert.equal(dom.window.document.getElementById('GPXUpload').files.length, 0);
    dom.window.close();
});

test('privacy guard still blocks non-allowlisted GPX extensions', async () => {
    const { dom, messages } = loadDraft(message => message.type === 'DRAFT_READY' ? {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 90,
        fields: {
            date: '2026-01-01', time: '', startElevationM: 1, endElevationM: 1,
            upDistanceM: 1, downDistanceM: 1, upGainM: 1, downGainM: 0,
            upDuration: { days: 0, hours: 0, minutes: 0 }, downDuration: { days: 0, hours: 0, minutes: 0 }
        },
        gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"><ele>1</ele><time>2026-01-01T00:00:00Z</time><extensions><hr>120</hr></extensions></trkpt></trkseg></trk></gpx>'
    } : { ok: true });
    await waitForCondition(() => dom.window.document.getElementById('bpb-draft-banner'));
    assert.deepEqual(messages.map(message => message.type), ['DRAFT_READY']);
    const banner = dom.window.document.getElementById('bpb-draft-banner');
    assert.ok(banner);
    assert.match(banner.textContent, /privacy check/);
    dom.window.close();
});

test('privacy guard rejects waypoint data when capture disabled retention', async () => {
    const { dom, messages } = loadDraft(message => message.type === 'DRAFT_READY' ? {
        action: 'apply', jobId: 'job', pid: '12', cid: '34', classification: 'strong', confidence: 90,
        allowWaypoints: false,
        fields: {
            date: '2026-01-01', suffix: '', startElevationM: 1, endElevationM: 1,
            upDistanceM: 1, downDistanceM: 1, upGainM: 1, downGainM: 0,
            upDuration: { days: 0, hours: 0, minutes: 0 }, downDuration: { days: 0, hours: 0, minutes: 0 }
        },
        gpx: '<gpx><wpt lat="1" lon="2"><name>Camp</name></wpt><trk><trkseg><trkpt lat="1" lon="2"></trkpt></trkseg></trk></gpx>'
    } : { ok: true });
    await waitForCondition(() => dom.window.document.getElementById('bpb-draft-banner'));
    assert.deepEqual(messages.map(message => message.type), ['DRAFT_READY']);
    assert.match(dom.window.document.getElementById('bpb-draft-banner').textContent, /privacy check/);
    dom.window.close();
});
