// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden real-extension test of Preview -> manual Save -> persisted GPX/trip.
// The fixture deliberately shares one temporary upload across ascent forms.
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConsoleMessage, Page } from 'playwright';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFixtureCertificate, createSyntheticCaptureJob, createSyntheticCapturePayload, waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { createVerificationRoot, launchVerificationChrome } from './verification-launch.mts';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => T) => Promise<NonNullable<T>>;
interface SavedAscent { pid: string | null; tripId: FormDataEntryValue | null; sequence: FormDataEntryValue | null; suffix: FormDataEntryValue | null; gpx: string }
// Popup-world diagnostics; callbacks cast in place so the shared program keeps its globals.
interface DraftTabTrace { draftTabEvents: object[] }
const resources = createResourceStack();
const root = await createVerificationRoot(resources, 'bpb-multi-summit-', 'multi-summit root');
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>;
let failure: unknown = null;
const reportBrowserError = (message: ConsoleMessage) => {
    if (message.type() === 'error') console.error(`Browser: ${message.text()}`);
};
try {
    const certificate = await createFixtureCertificate({ directory: root as never });
    assert.ok(certificate);
    resources.defer('multi-summit certificate', () => certificate.remove());
    const server = createServer(certificate, (request, response) => {
        void handler(request, response).catch(error => { response.writeHead(500); response.end(error.message); });
    });
    resources.defer('multi-summit server', () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = (await readFile('test/fixtures/pages/climber-ascentedit.html', 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/(<form\b[^>]*\baction=")[^"]*/i, '$1');
    const context = await launchVerificationChrome(resources, 'multi-summit browser', path.join(root, 'profile'), {
        chromeBinary: process.env.CHROME_BIN,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], viewport: { width: 1000, height: 760 },
        trustArgs: certificate.chromeTrustArgs, extension: path.resolve('dist'), hosts: [`www.peakbagger.com 127.0.0.1:${port}`],
    });
    // Include worker failures in CI output; the public reply intentionally
    // contains only the user-facing error and hides its browser-level cause.
    context.on('console', reportBrowserError);
    resources.defer('multi-summit console listener', () => context.off('console', reportBrowserError));
    const saved = new Map<string, SavedAscent>();
    let temporary = '';
    let previews = 0;
    let savePosts = 0;
    let tripExists = false;
    const form = (pid: string | null, posted: FormData | null = null, previewed = false) => {
        let html = base;
        html = html.replace(/(<select[^>]*id="TripDD"[^>]*>)([\s\S]*?)(<\/select>)/, (_match: string, start: string, options: string, end: string) => start + options + (tripExists ? '<option value="44">Shared traverse</option>' : '') + end);
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
        const url = new URL(request.url!, 'https://www.peakbagger.com');
        const send = (body: string, type = 'text/html') => { response.writeHead(200, { 'content-type': type }); response.end(body); };
        if (/\/ascentedit\.aspx$/i.test(url.pathname)) {
            const aid = url.searchParams.get('aid');
            const pid = url.searchParams.get('pid');
            if (aid) return send(`<form id="Form1"><input id="JournalText"><input id="DateText"><select id="PeakListBox"><option>${saved.get(aid!)?.pid}</option></select><select id="TripDD"><option value="${saved.get(aid!)?.tripId}">Shared traverse</option></select></form>`);
            if (request.method === 'GET') return send(form(pid));
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk);
            const post = await new Request(url, { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
            if (post.has('GPXPreview')) {
                previews++;
                temporary = await (post.get('GPXUpload') as File).text();
                return send(form(pid, post, true));
            }
            if (post.has('SaveButton') || post.has('SaveButton2')) {
                savePosts++;
                const id = String(800 + saved.size);
                const tripId = post.get('TripDD') === '-1' ? '44' : post.get('TripDD');
                tripExists = true;
                saved.set(id, { pid, tripId, sequence: post.get('TripSeqText'), suffix: post.get('SuffixText'), gpx: temporary });
                temporary = ''; // Saving consumes Peakbagger's temporary upload.
                return send(`<div id="UpdatePanelAE"><h2><span id="SubTitle">Ascent Added/Saved Successfully!</span></h2><p><a href="Photo.aspx?aid=${id}&pid=${pid}&cid=900001">Add Photos</a><a href="climber.aspx?cid=900001">Go Back to Referring Page</a></p></div>`);
            }
            return send(form(pid));
        }
        if (/\/ascent\.aspx$/i.test(url.pathname)) {
            const aid = url.searchParams.get('aid');
            return send(`<a href="/peak.aspx?pid=${saved.get(aid!)?.pid}">Saved peak</a><a href="/climber/ascentedit.aspx?aid=${aid}">Edit Ascent</a><a href="/climber/GPXFile.aspx?aid=${aid}">Download this GPS track</a>`);
        }
        if (/\/GPXFile\.aspx$/i.test(url.pathname)) return send(saved.get(url.searchParams.get('aid')!)?.gpx || '<gpx/>', 'application/gpx+xml');
        return send('<!doctype html><html><body>Fixture</body></html>');
    };
    const first = await context.newPage();
    await first.goto('https://www.peakbagger.com/climber/ascentedit.aspx?pid=2829&cid=900001');
    await first.locator('#bpb-report-editor').waitFor();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const control = await context.newPage();
    await control.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
    await control.evaluate(() => {
        const trace = globalThis as unknown as DraftTabTrace;
        trace.draftTabEvents = [];
        const record = (event: string, tab: Partial<chrome.tabs.Tab> & { frozen?: boolean }) => {
            const { id, status, url, pendingUrl, discarded, frozen, groupId } = tab;
            trace.draftTabEvents.push({ time: Date.now(), event, id, status, url, pendingUrl, discarded, frozen, groupId });
            if (trace.draftTabEvents.length > 100) trace.draftTabEvents.shift();
        };
        chrome.tabs.onCreated.addListener(tab => record('created', tab));
        chrome.tabs.onUpdated.addListener((_id, change, tab) => {
            if (change.status || change.url) record('updated', tab);
        });
        chrome.tabs.onRemoved.addListener(id => record('removed', { id }));
    });
    for (const provider of ['strava', 'upload']) {
        const theme = provider === 'upload' ? 'dark' : 'light';
        await control.evaluate(next => chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { theme: next } }), theme);
        const source = provider === 'upload' ? first : await context.newPage();
        if (provider === 'strava') await source.goto('https://www.peakbagger.com/Default.aspx');
        else await first.goto('https://www.peakbagger.com/climber/ascentedit.aspx?pid=2829&cid=900001');
        const sourceTabId = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id, source.url());
        // The worker reads these selection fields; the shared helper does not declare them.
        const job = createSyntheticCaptureJob(sourceTabId) as ReturnType<typeof createSyntheticCaptureJob> & { pageSessionId?: string; selectionGeneration?: number; selectionNonce?: string };
        job.provider = provider;
        job.matches.push({ ...structuredClone(job.matches[0]), id: 2830, name: 'Second summit', confidence: 90 });
        job.matches.push({ ...structuredClone(job.matches[0]), id: 2831, name: 'Third summit', confidence: 85 });
        job.matches[1].draftFields.upDistanceM += 100;
        job.matches[2].draftFields.upDistanceM += 200;
        job.selectedIds = [2829, 2830, 2831];
        job.capturePreferences.fillTripInfo = true;
        job.tripName = '2026-07-01';
        Object.assign(job, { pageSessionId: 'browser-save-session', selectionGeneration: 1, selectionNonce: 'browser-save-selection' });
        const payload = createSyntheticCapturePayload(job);
        const opened = await control.evaluate(async ({ job: draftJob, payload: draftPayload, provider: draftProvider }): Promise<{ tabIds?: number[] }> => {
            await chrome.storage.session.set({ bpbCaptureJobs: { [draftJob.sourceTabId]: draftJob }, bpbDraftTabs: {}, [draftPayload.key]: draftPayload.value });
            if (draftProvider === 'strava') return chrome.runtime.sendMessage({ type: 'CAPTURE_OPEN_DRAFTS', tabId: draftJob.sourceTabId, selectedIds: draftJob.selectedIds });
            const [result] = await chrome.scripting.executeScript({ target: { tabId: draftJob.sourceTabId }, func: async (captured: typeof draftJob) => chrome.runtime.sendMessage({ type: 'GPX_PROCESS_APPLY', jobId: captured.id, selectedIds: captured.selectedIds, primaryId: 2829, pageSessionId: captured.pageSessionId, selectionGeneration: captured.selectionGeneration, selectionNonce: captured.selectionNonce }), args: [draftJob] });
            return result.result as { tabIds?: number[] };
        }, { job, payload, provider });
        if (opened.tabIds?.length !== 3) {
            console.error('Draft opening diagnostics:', JSON.stringify({
                provider,
                pages: context.pages().map(page => page.url()),
                ...await control.evaluate(async () => ({
                    tabs: await chrome.tabs.query({}),
                    events: (globalThis as unknown as DraftTabTrace).draftTabEvents,
                })),
            }));
        }
        assert.ok(opened.tabIds?.length === 3, JSON.stringify(opened));
        const firstUrl = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=2829&cid=900001';
        const secondUrl = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=2830&cid=900001';
        const thirdUrl = 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=2831&cid=900001';
        // Select the exact returned tab as a user would. An arbitrary blank
        // Playwright page may be either draft before its initial navigation;
        // forcing goto on it can interrupt the extension's own navigation.
        await control.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), opened.tabIds![1]);
        const pages = await waitForCondition((): Page[] | null => {
            const a = context.pages().find(page => page !== first && page.url() === firstUrl) || (provider === 'upload' ? first : null);
            const b = context.pages().find(page => page.url() === secondUrl);
            const c = context.pages().find(page => page.url() === thirdUrl);
            return a && b && c ? [a, b, c] : null;
        }).catch(async error => { console.log(context.pages().map(page => page.url()), await control.evaluate(()=>chrome.tabs.query({})));  throw error; });
        await pages[0].waitForFunction(() => document.getElementById('GPXStatusLabel')?.textContent?.includes('successfully'));
        await pages[1].getByText('Save the previous ascent to prepare this summit with its GPX and trip.', { exact: true }).waitFor();
        await pages[2].getByText('Save the previous ascent to prepare this summit with its GPX and trip.', { exact: true }).waitFor();
        for (const page of pages) await page.waitForFunction(expected => document.documentElement.getAttribute('data-bpb-theme') === expected, theme);
        const before = saved.size;
        assert.equal(previews, before + 1);
        assert.equal(savePosts, before);
        assert.equal(await pages[0].locator('#SuffixText').inputValue(), 'a');
        for (const queued of pages.slice(1)) {
            for (const id of ['SaveButton', 'SaveButton2']) {
                assert.equal(await queued.locator(`#${id}`).isDisabled(), true);
                assert.equal(await queued.locator(`#${id}`).evaluate(node => getComputedStyle(node).opacity), '0.55');
            }
            await queued.locator('#DateText').press('Enter');
            await queued.evaluate(() => {
                document.getElementById('SaveButton2')!.click();
                (document.getElementById('Form1') as HTMLFormElement).requestSubmit(document.getElementById('SaveButton'));
            });
        }
        assert.equal(savePosts, before, 'queued forms cannot save without their suffix and shared trip');
        assert.equal(await pages[0].locator('#TripNameText').inputValue(), '2026-07-01');
        if (process.env.BPB_VERIFY_MULTI_READY_SCREENSHOT) await pages[0].screenshot({ path: process.env.BPB_VERIFY_MULTI_READY_SCREENSHOT, fullPage: true });
        if (process.env.BPB_VERIFY_MULTI_SCREENSHOT) {
            await pages[1].screenshot({ path: process.env.BPB_VERIFY_MULTI_SCREENSHOT });
            await pages[1].setViewportSize({ width: 650, height: 760 });
            await pages[1].screenshot({ path: process.env.BPB_VERIFY_MULTI_SCREENSHOT.replace(/\.png$/, '-narrow.png') });
            await pages[1].setViewportSize({ width: 1000, height: 760 });
        }
        if (provider === 'upload') {
            const repairFile = path.join(root, 'repair.gpx');
            await writeFile(repairFile, payload.value.gpx);
            await pages[0].locator('#GPXUpload').setInputFiles(repairFile);
            const attach = pages[0].getByRole('button', { name: 'Attach GPX', exact: true });
            await attach.waitFor();
            assert.equal(await pages[0].locator('.bpb-process-button').count(), 0);
            await Promise.all([pages[0].waitForNavigation(), attach.click()]);
            assert.equal(previews, before + 2);
        }
        await pages[0].locator('#SaveButton').click();
        await pages[1].waitForFunction(() => document.getElementById('GPXStatusLabel')?.textContent?.includes('successfully'));
        assert.equal(await pages[1].locator('#TripDD').inputValue(), '44');
        assert.equal(await pages[1].locator('#TripSeqText').inputValue(), '2');
        assert.equal(await pages[1].locator('#SuffixText').inputValue(), 'b');
        await pages[0].goto(`https://www.peakbagger.com/climber/ascent.aspx?aid=${800 + before}`);
        const reviewed = await control.evaluate(draftJob => chrome.runtime.sendMessage({
            type: 'CAPTURE_OPEN_DRAFTS', tabId: draftJob.sourceTabId, selectedIds: draftJob.selectedIds,
        }), job) as { tabIds: number[] };
        assert.deepEqual(reviewed.tabIds, opened.tabIds!.slice(1), 'Review drafts must not recreate a saved summit');
        assert.equal(savePosts, before + 1);
        assert.equal(previews, before + (provider === 'upload' ? 3 : 2), 'review must not restart GPS Preview');
        await pages[1].locator('#SaveButton').click();
        await pages[2].waitForFunction(() => document.getElementById('GPXStatusLabel')?.textContent?.includes('successfully'));
        assert.equal(await pages[2].locator('#TripDD').inputValue(), '44');
        assert.equal(await pages[2].locator('#TripSeqText').inputValue(), '3');
        assert.equal(await pages[2].locator('#SuffixText').inputValue(), 'c');
        await pages[2].locator('#SaveButton2').click();
        await pages[2].getByText('All selected ascents and their GPX tracks have been checked.', { exact: true }).waitFor();
        const results = [...saved.values()].slice(before);
        assert.equal(results.length, 3);
        for (const ascent of results) { assert.equal(ascent.gpx, payload.value.gpx); assert.equal(ascent.tripId, '44'); }
        assert.deepEqual(results.map(ascent => ascent.sequence), ['1', '2', '3']);
        assert.deepEqual(results.map(ascent => ascent.suffix), ['a', 'b', 'c']);
        const remaining = await control.evaluate(async key => (await chrome.storage.session.get(key))[key], payload.key);
        assert.equal(remaining, undefined);
        console.log(`${provider}: three manually saved ascents retain a/b/c, the complete GPX, and one date-named trip`);
        for (const page of pages) await page.close();
        if (provider === 'strava') await source.close();
    }
    console.log(`Hidden Chrome ${context.browser()!.version()}, 1000x760; native window/focus behavior untested.`);
} catch (error) { failure = error; }
await resources.dispose(failure as null);
