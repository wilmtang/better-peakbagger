/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference types="chrome" />
/* eslint-disable @typescript-eslint/no-shadow -- serialized browser callbacks use their argument names. */
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real toolbar -> provider adapter -> worker -> popup -> draft, without changing
// the shipped manifest, seeding jobs, or replacing any extension runtime code.
/* global chrome */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import { captureProfileCount, installPreviewProbe, sanitizePreviewEvent, type PreviewEvent } from './capture-preview-diagnostics.mts';
import { chromium } from 'playwright';
import { activateToolbarTarget, createFixtureCertificate, waitForCondition as waitFor } from './browser-verification-fixtures.mjs';
import { createResourceStack, closeServer, listenServer } from './resource-stack.mjs';
import { runChildProcess } from './resource-stack.mjs';
import { fileURLToPath } from 'node:url';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

const waitForCondition = <T,>(read: () => T | Promise<T>, ready: (value: T) => unknown, { timeoutMs = 10_000, message = 'capture condition' } = {}) => waitFor(async () => {
    const value = await read();
    if (ready(value)) return value;
    throw new Error(`Current state: ${JSON.stringify(value)}`);
}, { timeoutMs, description: message });

const profileCount = captureProfileCount(process.argv.slice(2));
if (process.argv.length > 2) {
    for (let profile = 1; profile <= profileCount; profile++) {
        console.log(`Fresh capture profile ${profile}/${profileCount} started.`);
        const options = { label: 'fresh capture profile',
            env: { ...process.env, BPB_CAPTURE_FIRST_PROVIDER: profile % 2 ? 'garmin' : 'strava',
                ...(process.env.BPB_CAPTURE_FLOW_ARTIFACTS ? { BPB_CAPTURE_FLOW_ARTIFACTS: path.join(process.env.BPB_CAPTURE_FLOW_ARTIFACTS, `profile-${profile}`) } : {}) } };
        await runChildProcess(process.execPath, [fileURLToPath(import.meta.url)], options);
        console.log(`Fresh capture profile ${profile}/${profileCount} passed, including teardown.`);
    }
    process.exit(0);
}

type Job = { phase: string; error?: { code?: string }; matches: { id: number }[]; id: string };
type Preview = { date: FormDataEntryValue | null; suffix: FormDataEntryValue | null; gpx: string };
const resources = createResourceStack();
let failure;
const artifacts = process.env.BPB_CAPTURE_FLOW_ARTIFACTS;
const links = '<div>Logged in: Test Climber | <a href="/climber/climber.aspx?cid=900001">My Home Page</a><a href="/climber/climberedit.aspx?cid=900001">Edit Account</a></div>';
const gpx = '<?xml version="1.0"?><gpx version="1.1"><metadata><desc>PRIVATE_SOURCE_SENTINEL</desc></metadata>'
    + '<wpt lat="0" lon="0"><ele>130</ele><time>2026-07-01T16:00:00Z</time><name>Summit waypoint</name><desc>PRIVATE_WAYPOINT_SENTINEL</desc></wpt>'
    + '<trk><name>Fixture traverse</name><trkseg>'
    + [[-0.001, 100, 15], [0, 130, 16], [0.001, 100, 17]].map(([lon, ele, hour]) =>
        `<trkpt lat="0" lon="${lon}"><ele>${ele}</ele><time>2026-07-01T${hour}:00:00Z</time></trkpt>`).join('')
    + '</trkseg></trk></gpx>';
const peaks = '<p><t i="2829" n="Fixture summit" a="0" o="0" e="426.509" r="1" l="Fixture range"/></p>';
const state = { owner: true, signedIn: true, providerStatus: 200, providerBody: gpx, peakStatus: 200, peakBody: peaks,
    sessionReady: true, downloadFailure: false,
    exports: 0, peakRequests: 0, previews: [] as Preview[], saves: 0, holdExport: false, releases: [] as (() => void)[] };
let providerPageSerial = 0;
const network = { browserStarted: 0, browserFinished: 0, postStarted: 0, bodyRead: 0, formParsed: 0, fileRead: 0, failed: 0, serverFailed: 0 };
const nativeEvents: PreviewEvent[] = [];
try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bpb-capture-flow-'));
    resources.defer('capture flow root', () => rm(root, { recursive: true, force: true }));
    const cert = await createFixtureCertificate({ directory: root as never });
    assert.ok(cert);
    resources.defer('capture flow certificate', cert.remove);
    const base = (await readFile('test/fixtures/pages/climber-ascentedit.html', 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/(<form\b[^>]*\baction=")[^"]*/i, '$1');
    const forms = (post: FormData | null = null) => {
        let html = base.replace(/(<select[^>]*id="PeakListBox"[^>]*>)/, '$1<option value="2829" selected>Fixture summit</option>');
        if (post) {
            for (const id of ['DateText', 'SuffixText', 'TripSeqText', 'TripNameText']) {
                const value = String(post.get(id) || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                html = html.replace(new RegExp(`(<input\\b[^>]*id="${id}"[^>]*)(>)`), `$1 value="${value}"$2`);
            }
            html = html.replace('No GPS Data for this Ascent', 'GPX file successfully uploaded.');
        }
        return html;
    };
    const server = https.createServer({ key: cert.key, cert: cert.cert }, (request, response) => {
        void (async () => {
            const url = new URL(request.url!, `https://${request.headers.host}`);
            const send = (body: string, status = 200, type = 'text/html') => {
                response.writeHead(status, { 'content-type': type }); response.end(body);
            };
            if (url.pathname.includes('/export')) {
                state.exports++;
                if (state.holdExport) await new Promise<void>(resolve => state.releases.push(resolve));
                send(state.providerBody, state.providerStatus, 'application/gpx+xml');
            } else if (url.hostname === 'connect.garmin.com' || url.hostname === 'www.strava.com') {
                const garmin = url.hostname === 'connect.garmin.com';
                const profile = garmin ? '/app/profile/' : '/athletes/';
                send(`<!doctype html><title>Capture fixture ${++providerPageSerial}</title><meta name="csrf-token" content="${state.sessionReady ? 'fixture-token' : ''}"><script>window.USE_DI_SESSION=true</script>`
                    + `<header id="${garmin ? 'garmin-header' : 'global-header'}"><a href="${profile}77">Me</a></header>`
                    + `<main><section data-testid="activity-header"><a href="${profile}${state.owner ? 77 : 88}">Author</a>`
                    + (garmin ? '<button aria-label="Edit an Activity">Edit</button>' : `<a href="${url.pathname}/edit">Edit</a>`)
                    + '</section><h1>Fixture hike</h1></main>');
            } else if (url.pathname === '/Default.aspx') {
                send(state.signedIn ? links : '<a href="/login.aspx">Sign in</a>');
            } else if (url.pathname === '/Async/pllbb2.aspx') {
                state.peakRequests++;
                send(state.peakBody, state.peakStatus, 'text/xml');
            } else if (/\/ascentedit\.aspx$/i.test(url.pathname)) {
                if (request.method === 'GET') return send(forms());
                network.postStarted++;
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(chunk);
                network.bodyRead++;
                const post = await new Request(url, { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
                network.formParsed++;
                if (post.has('SaveButton') || post.has('SaveButton2')) state.saves++;
                if (post.has('GPXPreview')) { state.previews.push({ date: post.get('DateText'), suffix: post.get('SuffixText'), gpx: await (post.get('GPXUpload') as File).text() });
                    network.fileRead++;
                }
                send(forms(post));
            } else send('', 404);
        })().catch(() => { network.serverFailed++; response.writeHead(500); response.end('Fixture request failed'); });
    });
    resources.defer('capture fixture server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');
    const port = (server.address() as AddressInfo).port;
    const extensionSource = path.resolve(process.env.BPB_VERIFY_EXTENSION_SOURCE || 'dist');
    assertChromeLaunchAllowed();
    const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chromium' }),
        headless: true, viewport: { width: 1000, height: 760 },
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [...cert.chromeTrustArgs, '--enable-unsafe-extension-debugging', `--load-extension=${extensionSource}`, `--disable-extensions-except=${extensionSource}`,
            `--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1:${port},MAP connect.garmin.com 127.0.0.1:${port},MAP www.strava.com 127.0.0.1:${port}`],
    });
    resources.defer('capture browser', () => context.close());
    resources.defer('held export responses', () => state.releases.splice(0).forEach(release => release()));
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (state.downloadFailure && url.hostname === 'connect.garmin.com' && url.pathname.includes('/export')) {
            return route.abort('failed');
        }
        return ['www.peakbagger.com', 'connect.garmin.com', 'www.strava.com'].includes(url.hostname)
            ? route.continue() : route.abort('blockedbyclient');
    });
    await context.exposeBinding('__bpbRecordPreview', (_source, input: unknown) => {
        const event = sanitizePreviewEvent(input);
        if (!event) return;
        nativeEvents.push(event);
        if (nativeEvents.length > 64) nativeEvents.shift();
    });
    await context.addInitScript(installPreviewProbe);
    const previewPost = (request: import('playwright').Request) => request.method() === 'POST'
        && new URL(request.url()).hostname === 'www.peakbagger.com'
        && new URL(request.url()).pathname.toLowerCase().endsWith('/ascentedit.aspx');
    context.on('request', request => { if (previewPost(request)) network.browserStarted++; });
    context.on('requestfinished', request => { if (previewPost(request)) network.browserFinished++; });
    context.on('requestfailed', request => {
        if (previewPost(request)) network.failed++;
    });
    const cdp = await context.browser()!.newBrowserCDPSession();
    const { extensions } = await cdp.send('Extensions.getExtensions');
    const extension = extensions.find(item => item.name === 'Better Peakbagger');
    assert.ok(extension, 'packaged extension did not load');
    assert.equal(extension.path, extensionSource);
    const control = await context.newPage();
    // Capture controls are popup-only. A query distinguishes this observer tab
    // from the actual toolbar popup target without changing its trusted path.
    await control.goto(`chrome-extension://${extension.id}/popup/popup.html?verification=observer`);
    const popupState = () => control.evaluate(() => {
        const win = chrome.extension.getViews({ type: 'popup' })[0];
        if (!win) return null;
        const doc = win.document;
        return { title: doc.querySelector('.state-title')?.textContent, text: doc.body.innerText,
            ready: !doc.querySelector<HTMLElement>('#results')?.hidden, count: doc.querySelectorAll('#peak-list input').length,
            width: win.innerWidth, scrollWidth: doc.documentElement.scrollWidth };
    });
    const screenshotPopup = async (name: string) => {
        if (!artifacts) return;
        const { targetInfos } = await cdp.send('Target.getTargets');
        const target = targetInfos.find(item => item.url === `chrome-extension://${extension.id}/popup/popup.html`);
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target!.targetId, flatten: false });
        let listener: (event: { sessionId: string; message: string }) => void = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            assert.ok(target, 'popup target missing');
            const response = new Promise<{ data: string }>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Popup screenshot timed out')), 5000);
                listener = event => {
                    if (event.sessionId !== sessionId) return;
                    const message = JSON.parse(event.message);
                    if (message.id === 1) {
                        if (message.error) reject(new Error(JSON.stringify(message.error)));
                        else resolve(message.result);
                    }
                };
                cdp.on('Target.receivedMessageFromTarget', listener);
            });
            await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }) });
            const result = await response;
            await mkdir(artifacts, { recursive: true });
            await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
        } finally {
            clearTimeout(timer);
            cdp.off('Target.receivedMessageFromTarget', listener);
            await cdp.send('Target.detachFromTarget', { sessionId });
        }
    };
    const closePopup = () => control.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.close());
    const clickPopup = (selector: string) => control.evaluate(selector => {
        const button = chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector<HTMLButtonElement>(selector);
        if (!button || button.disabled) throw new Error(`Unavailable popup control: ${selector}`);
        button.click();
    }, selector);
    const invoke = async (page: Page, startCapture = false) => {
        await closePopup();
        await waitForCondition(async () => (await popupState()) === null, Boolean, { message: 'previous toolbar popup did not close' });
        // Reopening preserves the URL; each fixture document has a unique
        // title so the toolbar gesture targets the actual fresh tab.
        const title = await page.title();
        const target = await waitForCondition(async () => {
            const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
            return targetInfos.find(item => item.url === page.url() && item.title === title);
        }, Boolean, { message: 'provider tab target did not appear' });
        await activateToolbarTarget(cdp, page, target.targetId);
        await cdp.send('Extensions.triggerAction', { id: extension.id, targetId: target.targetId });
        await waitForCondition(popupState, Boolean, { timeoutMs: 5000, message: 'toolbar popup did not open' }).catch(async error => {
            console.error('Toolbar failure state:', {
                expectedTarget: target,
                tabs: await control.evaluate(() => chrome.tabs.query({})),
                targets: (await cdp.send('Target.getTargets')).targetInfos,
            });
            throw error;
        });
        const tabId = await control.evaluate(async ({ url, title }) =>
            (await chrome.tabs.query({})).find(tab => tab.url === url && tab.title === title)?.id, { url: page.url(), title });
        if (startCapture) {
            assert.equal(await jobFor(tabId), null, 'opening the popup must not start a provider read');
            await waitForCondition(popupState, ui => ui?.title === 'Prepare this activity',
                { timeoutMs: 5000, message: 'explicit capture action was not displayed' });
            await clickPopup('#state button');
        }
        return tabId;
    };
    const jobFor = (tabId: number | undefined): Promise<Job | null> => control.evaluate(tabId => chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId }), tabId);
    assert.notEqual((await jobFor(-1))?.error?.code, 'forbidden',
        'the capture observer must use an authorized popup context');
    const terminal = (tabId: number | undefined) => waitForCondition(() => jobFor(tabId), job => ['ready', 'error', 'no-gps'].includes(job?.phase ?? ''),
        { timeoutMs: 30_000, message: 'capture did not settle' });
    let activityId = 100;
    const start = async (provider = 'garmin') => {
        const page = await context.newPage();
        await page.goto(provider === 'garmin' ? `https://connect.garmin.com/app/activity/${++activityId}` : `https://www.strava.com/activities/${++activityId}`);
        // Exercise selection explicitly: the supplied CDP target must not
        // silently run the toolbar action against a different selected tab.
        if (activityId === 101) await control.evaluate(async () => {
            const tab = await chrome.tabs.getCurrent();
            await chrome.tabs.update(tab!.id!, { active: true });
        });
        return { page, tabId: await invoke(page, true) };
    };
    const completed: { provider: string; draft: Page }[] = [];
    for (const provider of process.env.BPB_CAPTURE_FIRST_PROVIDER === 'strava' ? ['strava', 'garmin'] : ['garmin', 'strava']) {
        const source = await start(provider);
        const job = await terminal(source.tabId);
        assert.ok(job);
        assert.equal(job.phase, 'ready', JSON.stringify(job.error));
        assert.equal(job.matches.length, 1);
        assert.equal(job.matches[0].id, 2829);
        await waitForCondition(popupState, ui => ui?.ready && ui.count === 1,
            { timeoutMs: 5000, message: 'capture results not displayed' });
        const ui = await popupState();
        assert.ok(ui);
        assert.ok(ui.scrollWidth <= ui.width, 'popup must not overflow horizontally');
        await screenshotPopup(`${provider}-results`);
        const previewsBefore = state.previews.length;
        nativeEvents.length = 0;
        for (const key of Object.keys(network) as (keyof typeof network)[]) network[key] = 0;
        await clickPopup('#open-drafts');
        await waitForCondition(() => state.previews.length, count => count === previewsBefore + 1,
            { timeoutMs: 15_000, message: 'draft did not Preview exactly once' }).catch(async error => {
            let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
            let controls: unknown;
            try { controls = await Promise.race([Promise.all(context.pages().filter(page => {
                const url = new URL(page.url());
                return url.hostname === 'www.peakbagger.com' && url.pathname.toLowerCase().endsWith('/ascentedit.aspx');
            }).slice(0, 4).map(page => page.evaluate(() => {
                const preview = document.querySelector<HTMLInputElement>('#GPXPreview');
                const upload = document.querySelector<HTMLInputElement>('#GPXUpload');
                return { present: !!preview, connected: !!preview?.isConnected, disabled: !!preview?.disabled,
                    ownedForm: !!preview?.form && preview.form === upload?.form, uploadDisabled: !!upload?.disabled,
                    files: upload?.files?.length ?? 0,
                    invalid: [...(preview?.form?.elements ?? [])].filter(element => 'validity' in element
                        && !(element as HTMLInputElement).validity.valid).length };
            }).catch(() => ({ unavailable: true })))), new Promise(resolve => {
                diagnosticTimer = setTimeout(() => resolve([{ unavailable: true, timedOut: true }]), 1000);
            })]); } finally { clearTimeout(diagnosticTimer); }
            console.error('Draft Preview failure:', { provider, network, nativeEvents, controls });
            throw error;
        });
        const draft = context.pages().find(page => page.url().includes('/ascentedit.aspx') && !completed.some(item => item.draft === page));
        assert.ok(draft, 'draft tab missing');
        await draft.waitForFunction(() => globalThis.document.getElementById('GPXStatusLabel')?.textContent?.includes('successfully'));
        assert.equal(state.saves, 0, 'capture must never Save');
        assert.equal(state.previews.at(-1)!.date, '2026-07-01');
        assert.equal(state.previews.at(-1)!.suffix, '', 'a single peak has no suffix');
        assert.doesNotMatch(state.previews.at(-1)!.gpx, /PRIVATE_|<metadata|<desc/);
        const stored = await control.evaluate(() => chrome.storage.session.get(null));
        assert.doesNotMatch(JSON.stringify(stored), /PRIVATE_/);
        if (artifacts) { await mkdir(artifacts, { recursive: true }); await draft.screenshot({ path: path.join(artifacts, `${provider}-draft.png`) }); }
        // Revisit by GET. Reloading the POST result would ask Chrome itself to
        // repeat that POST, independently of extension exactly-once behavior.
        await draft.goto(draft.url());
        await draft.waitForLoadState('load');
        assert.equal(state.previews.length, previewsBefore + 1, 'revisiting must not repeat Preview');
        completed.push({ provider, draft });
        console.log(`${provider}: toolbar access, real export, summit match, draft fields, one Preview, no Save passed`);
        await source.page.close();
        await draft.close();
    }
    const cases = [
        { name: 'other owner', patch: { owner: false }, code: 'not-owner', exports: 0 },
        { name: 'Peakbagger signed out', patch: { signedIn: false }, code: 'peakbagger-signed-out', exports: 0 },
        { name: 'Garmin session not ready', patch: { sessionReady: false }, code: 'provider-session-not-ready', exports: 0 },
        { name: 'provider download failed', patch: { downloadFailure: true }, code: 'provider-download-failed', exports: 0 },
        { name: 'no GPS', patch: { providerBody: '<gpx/>' }, phase: 'no-gps', exports: 1 },
        { name: 'invalid GPX', patch: { providerBody: '<gpx><broken>' }, code: 'invalid-gpx', exports: 1 },
        { name: 'provider rate limit', patch: { providerStatus: 429 }, code: 'provider-rate-limited', exports: 1 },
        { name: 'summit unavailable', patch: { peakStatus: 503 }, code: 'peakbagger-unavailable', exports: 1 },
    ];
    for (const item of cases) {
        Object.assign(state, { owner: true, signedIn: true, sessionReady: true, downloadFailure: false,
            providerStatus: 200, providerBody: gpx, peakStatus: 200, peakBody: peaks }, item.patch);
        const before = state.exports;
        const source = await start();
        const job = await terminal(source.tabId);
        assert.ok(job);
        if (item.code) assert.equal(job.error?.code, item.code, `${item.name}: ${JSON.stringify(job)}`);
        else assert.equal(job.phase, item.phase);
        assert.equal(state.exports - before, item.exports, `${item.name}: export gate`);
        await waitForCondition(popupState, ui => !!ui?.title && !/…$/.test(ui.title), { timeoutMs: 5000, message: `${item.name} popup stuck` });
        assert.equal(state.saves, 0);
        if (['provider-session-not-ready', 'provider-download-failed'].includes(item.code ?? '')) {
            const expectedTitle = item.code === 'provider-session-not-ready'
                ? 'Activity session isn’t ready' : 'Couldn’t download the activity';
            await waitForCondition(popupState, ui => ui?.title === expectedTitle && ui.text.includes('Reopen activity'),
                { timeoutMs: 5000, message: `${item.name} recovery button did not appear` });
            await screenshotPopup(item.code!);
            state.sessionReady = true;
            state.downloadFailure = false;
            const [reopened] = await Promise.all([
                context.waitForEvent('page'), clickPopup('#state button'),
            ]);
            await reopened.waitForURL(source.page.url());
            await reopened.waitForLoadState('load');
            assert.equal(source.page.isClosed(), false, 'Reopen activity must preserve the source and any unsaved notes');
            assert.equal(state.exports, before, 'reopening must not export without a new toolbar gesture');
            const reopenedId = await invoke(reopened, true);
            assert.notEqual(reopenedId, source.tabId, 'recovery must capture the fresh tab, even with the same URL');
            const recovered = await terminal(reopenedId);
            assert.ok(recovered);
            assert.equal(recovered.phase, 'ready', JSON.stringify(recovered.error));
            assert.equal(state.exports, before + 1);
            await reopened.close();
        }
        if (item.name === 'summit unavailable') {
            assert.equal((await popupState())?.title, 'Peakbagger is unavailable');
            await screenshotPopup('peakbagger-outage');
            state.peakStatus = 200;
            await clickPopup('#state button');
            await waitForCondition(() => jobFor(source.tabId), job => job?.phase === 'ready', { timeoutMs: 15_000, message: 'outage retry failed' });
        }
        await closePopup();
        await source.page.close();
        for (const page of context.pages()) if (page.url().startsWith('https://www.peakbagger.com/')) await page.close();
        console.log(`${item.name}: expected terminal state and export boundary passed`);
    }
    for (const action of ['cancel', 'reopen']) {
        Object.assign(state, { owner: true, signedIn: true, providerStatus: 200, providerBody: gpx,
            peakStatus: 200, peakBody: peaks, holdExport: true });
        const exportsBefore = state.exports;
        const peaksBefore = state.peakRequests;
        const source = await start();
        await waitForCondition(() => state.releases.length, count => count === 1, { message: 'export was not held' });
        await waitForCondition(popupState, ui => ui?.title === 'Getting the GPS track…', { message: 'export progress was not displayed' });
        const original = await jobFor(source.tabId);
        assert.ok(original);
        assert.equal(original.phase, 'exporting-gpx');
        if (action === 'cancel') {
            const aborted = source.page.waitForEvent('requestfailed', {
                predicate: request => request.url().includes('/export'), timeout: 10_000,
            });
            await clickPopup('#state button');
            await waitForCondition(popupState, ui => ui?.title === 'Capture cancelled', { message: 'cancellation not displayed' });
            await aborted;
            assert.equal(await jobFor(source.tabId), null);
            assert.equal(state.peakRequests, peaksBefore, 'cancelled export must not reach summit lookup');
            await screenshotPopup('cancelled');
        } else {
            // invoke closes the current popup before clicking the real toolbar.
            assert.equal(await invoke(source.page), source.tabId);
            await waitForCondition(popupState, ui => ui?.title === 'Getting the GPS track…', { message: 'reopened popup lost progress' });
            assert.equal((await jobFor(source.tabId))?.id, original.id, 'reopening must reuse the running job');
        }
        assert.equal(state.exports, exportsBefore + 1);
        state.holdExport = false;
        state.releases.splice(0).forEach(release => release());
        if (action === 'cancel') await clickPopup('#state button');
        const ready = await terminal(source.tabId);
        assert.ok(ready);
        assert.equal(ready.phase, 'ready', JSON.stringify(ready.error));
        assert.equal(ready.id === original.id, action === 'reopen', 'only an explicit restart creates a new job');
        await waitForCondition(popupState, ui => ui?.ready && ui.count === 1, { message: 'results not displayed after lifecycle action' });
        const expectedExports = exportsBefore + (action === 'cancel' ? 2 : 1);
        assert.equal(state.exports, expectedExports);
        await invoke(source.page);
        await waitForCondition(popupState, ui => ui?.ready && ui.count === 1, { message: 'reopening lost completed results' });
        assert.equal((await jobFor(source.tabId))?.id, ready.id);
        assert.equal(state.exports, expectedExports, 'reopening ready results must not export again');
        await clickPopup('#clear-capture');
        await waitForCondition(popupState, ui => ui?.title === 'Captured track data deleted', { message: 'track deletion not displayed' });
        assert.equal(await jobFor(source.tabId), null);
        const stored = await control.evaluate(() => chrome.storage.session.get(null));
        assert.doesNotMatch(JSON.stringify(stored), new RegExp(ready.id), 'clearing removes the job and its payload');
        assert.equal(state.saves, 0);
        await closePopup();
        await source.page.close();
        for (const page of context.pages()) if (page.url().startsWith('https://www.peakbagger.com/')) await page.close();
        console.log(`${action}: export lifecycle, stable results, and track deletion passed`);
    }
    if (artifacts) await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ browser: context.browser()!.version(),
        network, nativeEvents, cases: ['garmin success', 'strava success', ...cases.map(item => item.name), 'cancel and restart', 'popup close and reopen', 'track deletion'] }, null, 2));
    const browserName = process.env.CHROME_BIN ? path.basename(process.env.CHROME_BIN) : 'Chrome for Testing';
    console.log(`Capture flow passed in hidden ${browserName} ${context.browser()!.version()}, 1000x760 pages; no WebGL or native focus proof.`);
} catch (error) {
    failure = error;
    console.error('Capture diagnostics:', JSON.stringify({ network, nativeEvents }));
    if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(path.join(artifacts, 'preview-diagnostics.json'), JSON.stringify({ network, nativeEvents }, null, 2));
    }
}
finally { await resources.dispose(failure as never); }
