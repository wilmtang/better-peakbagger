// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden rendering of the shipped draft bundle against the native form fixture.
// Worker replies and native Preview postbacks are stubbed; real-extension sender
// and document ownership are covered by the extension and worker checks.
/* global document, window, sessionStorage */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { createFixtureCertificate, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !['chrome', 'firefox'].includes(args[0])) {
    throw new Error('Usage: node scripts/verify-draft-recovery.mjs chrome|firefox');
}
const browserName = args[0];
const artifacts = process.env.BPB_DRAFT_RECOVERY_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
const resources = createResourceStack();
let failure;
try {
    const certificate = await createFixtureCertificate({ label: 'draft-recovery' });
    resources.defer('draft fixture certificate', () => certificate.remove());
    const base = (await readFile('test/fixtures/pages/climber-ascentedit.html', 'utf8'))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/\s+on\w+="[^"]*"/gi, '')
        .replace(/(<form\b[^>]*\baction=")[^"]*/i, '$1')
        .replace(/<textarea\b[^>]*id="JournalText"[\s\S]*?<\/textarea>/i, '')
        .replace('</head>', '<link rel="stylesheet" href="/report-editor.css"></head>')
        .replace('</body>', '<p id="verifier-following">Following native content</p><script src="/draft.js"></script></body>');
    const assets = new Map([
        ['/report-editor.css', ['text/css', await readFile(process.env.BPB_DRAFT_RECOVERY_CSS || 'dist/css/report-editor.css')]],
        ['/draft.js', ['text/javascript', await readFile(process.env.BPB_DRAFT_RECOVERY_BUNDLE || 'dist/content/ascent-editor.js')]],
        ['/climber/ascentedit.aspx', ['text/html', base]],
        ['/away', ['text/html', '<!doctype html><title>Away</title><p>Reviewing another page</p>']],
    ]);
    const server = createServer(certificate, (request, response) => {
        const asset = assets.get(new URL(request.url, 'https://www.peakbagger.com').pathname);
        response.writeHead(asset ? 200 : 404, { 'content-type': asset?.[0] || 'text/plain' });
        response.end(asset?.[1] || 'Fixture resource unavailable');
    });
    resources.defer('draft fixture server', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (browserName === 'chrome') assertChromeLaunchAllowed();
    const browser = browserName === 'chrome'
        ? await chromium.launch({ channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'],
            args: [...certificate.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] })
        : await firefox.launch({ headless: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
    resources.defer('draft recovery browser', () => browser.close());
    let cases = 0;
    for (const width of [1000, 390]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
        const context = await browser.newContext({ viewport: { width, height: 760 }, ignoreHTTPSErrors: true,
            colorScheme: theme });
        try {
            await context.addInitScript(({ zoom }) => {
                const listeners = [];
                const good = '<gpx><trk><trkseg><trkpt lat="47" lon="-121"/><trkpt lat="47.1" lon="-121.1"/></trkseg></trk></gpx>';
                const state = window.recoveryProbe = { ready: 0, acknowledgments: 0, pending: false, start: null,
                    release: null, saveSubmissions: 0,
                    notify: () => listeners.forEach(listener => listener({ type: 'DRAFT_PROCEED' })),
                    clear: () => listeners.forEach(listener => listener({ type: 'DRAFT_CLEARED' })) };
                window.chrome = { runtime: { onMessage: { addListener: listener => listeners.push(listener) },
                    sendMessage: async message => {
                        if (message.type === 'DRAFT_READY') {
                            state.ready++;
                            if (sessionStorage.getItem('workerError') === 'true') {
                                const error = { action: 'error', message: 'A previous summit left its ascent form before its saved GPX and trip were checked. Review that ascent before starting a new capture.' };
                                return state.ready === 1
                                    ? new Promise(resolve => { state.fail = () => resolve(error); }) : error;
                            }
                            const reply = sessionStorage.getItem('previewed') === 'true'
                                ? { action: 'banner', classification: 'strong', confidence: 95 }
                                : { action: 'apply', jobId: 'fixture-job', pid: '2829', cid: '900001',
                                    applyLeaseToken: 'fixture-lease', classification: 'strong', confidence: 95,
                                    fields: { date: '2026-07-01', suffix: 'b', fillAscentDetails: false }, gpx: good };
                            if (state.ready === 1 && sessionStorage.getItem('recover') !== 'true') {
                                return new Promise(resolve => { state.start = () => resolve(reply); });
                            }
                            return reply;
                        }
                        if (message.type === 'DRAFT_PREVIEW_STARTED') {
                            state.acknowledgments++;
                            if (sessionStorage.getItem('recover') === 'true') return { ok: true };
                            state.pending = true;
                            return new Promise(resolve => { state.release = () => { state.pending = false; resolve({ ok: false }); }; });
                        }
                        return { ok: true };
                    } } };
                document.addEventListener('DOMContentLoaded', () => {
                    document.documentElement.style.zoom = String(zoom);
                });
                document.addEventListener('click', event => {
                    if (event.target.id !== 'GPXPreview') return;
                    event.preventDefault();
                    sessionStorage.setItem('previews', String(Number(sessionStorage.getItem('previews') || 0) + 1));
                    sessionStorage.setItem('previewed', 'true');
                    document.getElementById('GPXStatusLabel').textContent = 'GPX file successfully uploaded.';
                    state.notify();
                }, true);
                document.addEventListener('submit', event => {
                    event.preventDefault();
                    state.saveSubmissions++;
                    throw new Error('The extension must never submit Save');
                });
            }, { zoom });
            const page = await context.newPage();
            const url = `https://www.peakbagger.com:${server.address().port}/climber/ascentedit.aspx?pid=2829&cid=900001`;
            await page.goto(url);
            await page.waitForFunction(() => window.recoveryProbe.start);
            await page.locator('#DateText').focus();
            const geometry = () => page.evaluate(() => {
                const rect = selector => {
                    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
                    return { x, y, width, height };
                };
                return { save: rect('#SaveButton'), save2: rect('#SaveButton2'), heading: rect('#SubTitle'),
                    following: rect('#verifier-following'), scroll: window.scrollY };
            });
            const idle = await geometry();
            const attemptSave = async () => {
                await page.locator('#DateText').focus();
                await page.locator('#DateText').press('Enter');
                await page.evaluate(() => {
                    for (const id of ['SaveButton', 'SaveButton2']) {
                        const control = document.getElementById(id);
                        control.click();
                        control.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
                        document.getElementById('Form1').requestSubmit(control);
                    }
                });
                assert.equal(await page.evaluate(() => window.recoveryProbe.saveSubmissions), 0,
                    'an unresolved handshake must never reach the native submit handler');
                for (const id of ['SaveButton', 'SaveButton2']) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
                assert.equal(await page.locator('#DateText').evaluate(element => element === document.activeElement), true);
            };
            await attemptSave();
            if (artifacts) await page.screenshot({ path: path.join(artifacts, `${browserName}-${width}-${theme}-${zoom}-initial-pending.png`) });
            await page.evaluate(() => window.recoveryProbe.start());
            await page.waitForFunction(() => window.recoveryProbe.pending);
            const pending = await geometry();
            await page.evaluate(() => window.recoveryProbe.release());
            await page.locator('.bpb-draft-banner-error').waitFor();
            assert.match(await page.locator('#SaveButton').getAttribute('title'), /Reload this ascent form/);
            const action = page.getByRole('button', { name: 'Reload ascent form', exact: true });
            assert.equal(await action.count(), 1);
            const bounds = await page.locator('.bpb-draft-banner-error').boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 0.75,
                `Recovery feedback must fit the viewport: ${JSON.stringify(bounds)}`);
            const textBounds = await page.locator('.bpb-draft-banner-text').boundingBox();
            assert.ok(textBounds.x >= 0 && textBounds.x + textBounds.width <= width + 0.75,
                'the error message must remain readable alongside its action');
            const dismissBounds = await page.getByRole('button', { name: 'Dismiss notification' }).boundingBox();
            assert.ok(dismissBounds && dismissBounds.x >= bounds.x
                && dismissBounds.x + dismissBounds.width <= bounds.x + bounds.width + 0.75
                && dismissBounds.y + dismissBounds.height <= bounds.y + bounds.height + 0.75,
            `The dismiss control must stay inside the banner: ${JSON.stringify({ bounds, dismissBounds })}`);
            const stable = async baseline => {
                const current = await geometry();
                for (const key of ['save', 'save2', 'heading', 'following']) {
                    for (const dimension of ['x', 'y', 'width', 'height']) {
                        assert.ok(Math.abs(current[key][dimension] - baseline[key][dimension]) <= 0.75,
                            `${browserName}/${width}/${theme}/${zoom}: ${key}.${dimension} shifted: ${JSON.stringify({ baseline, current })}`);
                    }
                }
                assert.ok(Math.abs(current.scroll - baseline.scroll) <= 0.75,
                    `document scroll shifted: ${JSON.stringify({ baseline: baseline.scroll, current: current.scroll })}`);
            };
            await stable(pending);
            await stable(idle);
            await action.focus();
            const actionBounds = await action.boundingBox();
            for (let repeat = 0; repeat < 2; repeat++) {
                const before = await page.evaluate(() => window.recoveryProbe.acknowledgments);
                await page.evaluate(() => window.recoveryProbe.notify());
                await page.waitForFunction(before => window.recoveryProbe.pending && window.recoveryProbe.acknowledgments > before, before);
                await page.evaluate(() => window.recoveryProbe.release());
                await page.waitForFunction(() => document.querySelector('#SaveButton')?.title.includes('Reload this ascent form'));
                await stable(pending);
                assert.deepEqual(await action.boundingBox(), actionBounds, 'the recovery action stays anchored');
                assert.equal(await action.evaluate(element => element === document.activeElement), true, 'repeated feedback preserves keyboard focus');
            }
            assert.equal(await page.locator('#SuffixText').inputValue(), '', 'failed apply is rolled back');
            if (artifacts) await page.screenshot({ path: path.join(artifacts, `${browserName}-${width}-${theme}-${zoom}.png`), fullPage: false });
            await page.evaluate(() => sessionStorage.setItem('recover', 'true'));
            await Promise.all([page.waitForNavigation(), action.press('Enter')]);
            await waitForCondition(() => page.evaluate(() => document.getElementById('SaveButton')?.disabled === false),
                { description: 'Preview-confirmed Save availability' }).catch(async error => {
                error.message += ` ${JSON.stringify(await page.evaluate(() => ({ url: window.location.href,
                    banner: document.getElementById('bpb-draft-banner')?.textContent,
                    save: document.getElementById('SaveButton')?.outerHTML,
                    ready: window.recoveryProbe.ready, previews: sessionStorage.getItem('previews') })))}`;
                throw error;
            });
            assert.equal(await page.locator('#SuffixText').inputValue(), 'b');
            assert.equal(await page.evaluate(() => sessionStorage.getItem('previews')), '1');
            await stable(idle);

            // A fresh queued form must remain guarded when the worker cannot
            // safely resume a departed summit's unverified save.
            await page.evaluate(() => { sessionStorage.setItem('workerError', 'true'); });
            await page.goto(url);
            await page.waitForFunction(() => window.recoveryProbe.fail);
            await page.locator('#DateText').focus();
            const errorIdle = await geometry();
            await attemptSave();
            await page.evaluate(() => window.recoveryProbe.fail());
            await page.locator('.bpb-draft-banner-error').waitFor();
            for (const id of ['SaveButton', 'SaveButton2']) {
                assert.equal(await page.locator(`#${id}`).isDisabled(), true, 'worker errors must block both Save controls');
            }
            assert.equal(await page.locator('#SuffixText').inputValue(), '');
            assert.equal(await page.locator('#TripSeqText').inputValue(), '');
            assert.equal(await page.locator('#TripDD').inputValue(), '0');
            await stable(errorIdle);
            await page.locator('#DateText').press('Enter');
            await page.evaluate(() => {
                for (const id of ['SaveButton', 'SaveButton2']) {
                    const control = document.getElementById(id);
                    control.click();
                    control.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
                    document.getElementById('Form1').requestSubmit(control);
                }
            });
            for (let repeat = 0; repeat < 2; repeat++) {
                const before = await page.evaluate(() => window.recoveryProbe.ready);
                await page.evaluate(() => window.recoveryProbe.notify());
                await page.waitForFunction(before => window.recoveryProbe.ready > before
                    && document.querySelector('.bpb-draft-banner-error'), before);
                await stable(errorIdle);
                assert.equal(await page.locator('#DateText').evaluate(element => element === document.activeElement), true,
                    'repeated worker errors must preserve the active field');
            }
            assert.equal(await page.evaluate(() => window.recoveryProbe.saveSubmissions), 0);
            assert.equal(await page.evaluate(() => window.recoveryProbe.acknowledgments), 0);
            if (artifacts) await page.screenshot({ path: path.join(artifacts, `${browserName}-${width}-${theme}-${zoom}-worker-error.png`) });
            await page.evaluate(() => window.recoveryProbe.clear());
            for (const id of ['SaveButton', 'SaveButton2']) assert.equal(await page.locator(`#${id}`).isDisabled(), false);
            await stable(errorIdle);
            cases++;
        } finally { await context.close(); }
    }
    assert.equal(cases, 8, 'all recovery variants must execute');
    const historyContext = await browser.newContext({ viewport: { width: 1000, height: 760 }, ignoreHTTPSErrors: true });
    try {
        await historyContext.addInitScript(() => {
            const state = window.historyProbe = { ready: 0, previews: 0, persisted: false };
            window.addEventListener('pageshow', event => { state.persisted = event.persisted; });
            document.addEventListener('click', event => {
                if (event.target.id === 'GPXPreview') { event.preventDefault(); state.previews++; }
            }, true);
            window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
                if (message.type !== 'DRAFT_READY') return { ok: true };
                if (++state.ready > 1) return { action: 'ignore' }; // capture expires while away
                const retryAt = Date.now() + 3000;
                sessionStorage.setItem('leaseDeadline', String(retryAt));
                return { action: 'wait', message: 'Waiting for the lease.', retryAt };
            } } };
        });
        const page = await historyContext.newPage();
        const origin = `https://www.peakbagger.com:${server.address().port}`;
        await page.goto(`${origin}/climber/ascentedit.aspx?pid=2829&cid=900001`);
        await page.getByText('Waiting for the lease.', { exact: true }).waitFor();
        await page.locator('#SuffixText').fill('manual');
        // Playwright's Firefox transport disables native BFCache. Exercise
        // its persisted-event behavior explicitly, and report that limit;
        // Chrome must actually preserve this document through navigation.
        const traverseAway = async () => browserName === 'chrome'
            ? page.goto(`${origin}/away`)
            : page.evaluate(() => window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true })));
        const traverseBack = async () => browserName === 'chrome'
            ? page.goBack({ waitUntil: 'commit' })
            : page.evaluate(() => window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })));
        await traverseAway();
        await page.waitForFunction(() => Date.now() > Number(sessionStorage.getItem('leaseDeadline')));
        await traverseBack();
        await page.waitForFunction(() => window.historyProbe?.persisted === true);
        await waitForCondition(() => page.evaluate(() => ({ ready: window.historyProbe.ready,
            persisted: window.historyProbe.persisted, saveDisabled: document.getElementById('SaveButton').disabled })),
        { description: 'a fresh handshake after persisted restoration', isReady: state => state.ready === 2 });
        await page.waitForFunction(() => document.getElementById('SaveButton')?.disabled === false);
        assert.equal(await page.locator('#SuffixText').inputValue(), 'manual');
        assert.equal(await page.evaluate(() => window.historyProbe.previews), 0, 'restoration never replays Preview');
        if (browserName === 'chrome') await page.goForward({ waitUntil: 'commit' });
        else await traverseAway();
        await traverseBack();
        await page.waitForFunction(() => window.historyProbe?.persisted && window.historyProbe.ready === 3);
        assert.equal(await page.evaluate(() => window.historyProbe.previews), 0);
    } finally { await historyContext.close(); }
    console.log(JSON.stringify({ verification: 'draft-recovery', browser: browserName, version: browser.version(),
        hidden: true, cases, viewports: [1000, 390], height: 760, themes: ['light', 'dark'], cssZoom: [1, 2],
        rendering: 'static DOM; WebGL unused', stubs: ['worker replies', 'native Preview postback'],
        actualBfcacheRestores: browserName === 'chrome' ? 2 : 0,
        simulatedPersistedRestores: browserName === 'firefox' ? 2 : 0,
        scenarios: ['initial handshake blocks native Save', 'apply rollback and reload recovery', 'fresh-form worker error, repeated feedback and explicit discard', 'lease expiry while cached and repeated Back/Forward'] }));
} catch (error) { failure = error; }
await resources.dispose(failure);
