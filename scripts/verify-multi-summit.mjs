// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden real-extension test of Preview -> manual Save -> persisted GPX/trip.
// The fixture deliberately shares one temporary upload across ascent forms.
/* global chrome, document */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { createFixtureCertificate, createSyntheticCaptureJob, createSyntheticCapturePayload, waitForCondition } from './browser-verification-fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-multi-summit-'));
let context;
let server;
let certificate;
let handler;
try {
    certificate = await createFixtureCertificate({ directory: root });
    server = createServer(certificate, (request, response) => {
        void handler(request, response).catch(error => { response.writeHead(500); response.end(error.message); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = (await readFile('test/fixtures/pages/climber-ascentedit.html', 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/(<form\b[^>]*\baction=")[^"]*/i, '$1');
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chromium' }),
        headless: true, ignoreHTTPSErrors: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], viewport: { width: 1000, height: 760 },
        args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`,
            `--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1:${port}`],
    });
    const saved = new Map();
    let temporary = '';
    let previews = 0;
    let savePosts = 0;
    let tripExists = false;
    const form = (pid, posted = null, previewed = false) => {
        let html = base;
        html = html.replace(/(<select[^>]*id="TripDD"[^>]*>)([\s\S]*?)(<\/select>)/, (_, start, options, end) => start + options + (tripExists ? '<option value="44">Shared traverse</option>' : '') + end);
        // Restore successful controls as the real postback does.
        if (posted) {
            for (const id of ['DateText', 'SuffixText', 'TripSeqText', 'TripNameText', 'TripNightsText']) {
                const value = String(posted.get(id) || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                html = html.replace(new RegExp(`(<input\\b[^>]*id="${id}"[^>]*)(>)`), `$1 value="${value}"$2`);
            }
            html = html.replace(`value="${posted.get('TripDD')}"`, `value="${posted.get('TripDD')}" selected`);
        }
        if (previewed) html = html.replace('No GPS Data for this Ascent', 'GPX file successfully uploaded.');
        return html;
    };
    handler = async (request, response) => {
        const url = new URL(request.url, 'https://www.peakbagger.com');
        const send = (body, type = 'text/html') => { response.writeHead(200, { 'content-type': type }); response.end(body); };
        if (/\/ascentedit\.aspx$/i.test(url.pathname)) {
            const aid = url.searchParams.get('aid');
            const pid = url.searchParams.get('pid');
            if (aid) return send(`<form id="Form1"><input id="JournalText"><input id="DateText"><select id="PeakListBox"><option>${saved.get(aid)?.pid}</option></select><select id="TripDD"><option value="${saved.get(aid)?.tripId}">Shared traverse</option></select></form>`);
            if (request.method === 'GET') return send(form(pid));
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const post = await new Request(url, { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
            if (post.has('GPXPreview')) {
                previews++;
                temporary = await post.get('GPXUpload').text();
                return send(form(pid, post, true));
            }
            if (post.has('SaveButton') || post.has('SaveButton2')) {
                savePosts++;
                const id = String(800 + saved.size);
                const tripId = post.get('TripDD') === '-1' ? '44' : post.get('TripDD');
                tripExists = true;
                saved.set(id, { pid, tripId, sequence: post.get('TripSeqText'), gpx: temporary });
                temporary = ''; // Saving consumes Peakbagger's temporary upload.
                return send(`<div id="UpdatePanelAE"><h2><span id="SubTitle">Ascent Added/Saved Successfully!</span></h2><p><a href="Photo.aspx?aid=${id}&pid=${pid}&cid=900001">Add Photos</a><a href="climber.aspx?cid=900001">Go Back to Referring Page</a></p></div>`);
            }
            return send(form(pid));
        }
        if (/\/ascent\.aspx$/i.test(url.pathname)) {
            const aid = url.searchParams.get('aid');
            return send(`<a href="/peak.aspx?pid=${saved.get(aid)?.pid}">Saved peak</a><a href="/climber/ascentedit.aspx?aid=${aid}">Edit Ascent</a><a href="/climber/GPXFile.aspx?aid=${aid}">Download this GPS track</a>`);
        }
        if (/\/GPXFile\.aspx$/i.test(url.pathname)) return send(saved.get(url.searchParams.get('aid'))?.gpx || '<gpx/>', 'application/gpx+xml');
        return send('<!doctype html><html><body>Fixture</body></html>');
    };
    const first = await context.newPage();
    await first.goto('https://www.peakbagger.com/climber/ascentedit.aspx?pid=2829&cid=900001');
    await first.locator('#bpb-report-editor').waitFor();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const control = await context.newPage();
    await control.goto(`chrome-extension://${new URL(worker.url()).host}/options/options.html`);
    for (const provider of ['strava', 'upload']) {
        const source = provider === 'upload' ? first : await context.newPage();
        if (provider === 'strava') await source.goto('https://www.peakbagger.com/Default.aspx');
        else await first.goto('https://www.peakbagger.com/climber/ascentedit.aspx?pid=2829&cid=900001');
        const sourceTabId = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, source.url());
        const job = createSyntheticCaptureJob(sourceTabId);
        job.provider = provider;
        job.matches.push({ ...structuredClone(job.matches[0]), id: 2830, name: 'Second summit', confidence: 90 });
        job.matches[1].draftFields.upDistanceM += 100;
        job.selectedIds = [2829, 2830];
        job.capturePreferences.fillTripInfo = true;
        Object.assign(job, { pageSessionId: 'browser-save-session', selectionGeneration: 1, selectionNonce: 'browser-save-selection' });
        const payload = createSyntheticCapturePayload(job);
        const opened = await control.evaluate(async ({ job, payload, provider }) => {
            await chrome.storage.session.set({ bpbCaptureJobs: { [job.sourceTabId]: job }, bpbDraftTabs: {}, [payload.key]: payload.value });
            if (provider === 'strava') return chrome.runtime.sendMessage({ type: 'CAPTURE_OPEN_DRAFTS', tabId: job.sourceTabId, selectedIds: job.selectedIds });
            const [result] = await chrome.scripting.executeScript({ target: { tabId: job.sourceTabId }, func: async job => chrome.runtime.sendMessage({ type: 'GPX_PROCESS_APPLY', jobId: job.id, selectedIds: job.selectedIds, primaryId: 2829, pageSessionId: job.pageSessionId, selectionGeneration: job.selectionGeneration, selectionNonce: job.selectionNonce }), args: [job] });
            return result.result;
        }, { job, payload, provider });
        assert.ok(opened.tabIds?.length === 2, JSON.stringify(opened));
        const firstUrl = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=2829&cid=900001';
        const secondUrl = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=2830&cid=900001';
        // Explicitly open the waiting tab as a user may do while reviewing
        // the first ascent. Chrome may defer an inactive newly created tab.
        const waitingPage = await waitForCondition(() => context.pages().find(page => page.url() === secondUrl || page.url() === ''));
        await waitingPage.goto(secondUrl);
        const pages = await waitForCondition(() => {
            const a = context.pages().find(page => page !== first && page.url() === firstUrl) || (provider === 'upload' ? first : null);
            const b = context.pages().find(page => page.url() === secondUrl);
            return a && b ? [a, b] : null;
        }).catch(async error => { console.log(context.pages().map(page => page.url()), await control.evaluate(()=>chrome.tabs.query({})));  throw error; });
        await pages[0].waitForFunction(() => document.getElementById('GPXStatusLabel')?.textContent.includes('successfully'));
        await pages[1].getByText('Save the previous ascent to prepare this summit with its GPX and trip.', { exact: true }).waitFor();
        const before = saved.size;
        assert.equal(previews, before + 1);
        assert.equal(savePosts, before);
        if (process.env.BPB_VERIFY_MULTI_SCREENSHOT) await pages[1].screenshot({ path: process.env.BPB_VERIFY_MULTI_SCREENSHOT });
        await pages[0].locator('#SaveButton').click();
        await pages[1].waitForFunction(() => document.getElementById('GPXStatusLabel')?.textContent.includes('successfully'));
        assert.equal(await pages[1].locator('#TripDD').inputValue(), '44');
        assert.equal(await pages[1].locator('#TripSeqText').inputValue(), '2');
        await pages[1].locator('#SaveButton').click();
        await pages[1].getByText('All selected ascents and their GPX tracks have been checked.', { exact: true }).waitFor();
        const results = [...saved.values()].slice(before);
        assert.equal(results.length, 2);
        for (const ascent of results) { assert.equal(ascent.gpx, payload.value.gpx); assert.equal(ascent.tripId, '44'); }
        assert.deepEqual(results.map(ascent => ascent.sequence), ['1', '2']);
        const remaining = await control.evaluate(async key => (await chrome.storage.session.get(key))[key], payload.key);
        assert.equal(remaining, undefined);
        console.log(`${provider}: both manually saved ascents retain the complete GPX and one trip`);
        await pages[0].close(); await pages[1].close();
        if (provider === 'strava') await source.close();
    }
    console.log(`Hidden Chrome ${context.browser().version()}, 1000x760; native window/focus behavior untested.`);
} finally {
    await context?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await certificate?.remove(); await rm(root, { recursive: true, force: true });
}
