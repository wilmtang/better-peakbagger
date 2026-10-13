// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Transition geometry checks against shipped UI assets with controlled APIs.
// Fixtures are isolated HTTPS Peakbagger pages; no live data or accounts are used.
/* global document, location */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, firefox } from 'playwright';
import { JSDOM } from 'jsdom';
import { createBrowserFixtureServer, fixtureContentType, projectRoot } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';

const selected = process.argv.find(value => value.startsWith('--surface='))?.split('=')[1];
const output = process.env.BPB_JITTER_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
const assets = new Map();
async function asset(file) {
    if (!assets.has(file)) assets.set(file, await readFile(path.join(projectRoot, 'dist', file)));
    return assets.get(file);
}
export const geometry = async (page, selector) => page.locator(selector).evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
});
function stable(before, after, label, keys = ['x', 'y', 'width', 'height']) {
    for (const key of keys) assert.ok(Math.abs(before[key] - after[key]) <= 1,
        `${label}: ${key} shifted ${after[key] - before[key]}px; ${JSON.stringify({ before, after })}`);
}
async function capture(page, label) {
    if (output) await page.screenshot({ path: path.join(output, `${label}.png`) });
}
async function load(page, origin, file, initialize, argument) {
    await page.addInitScript(initialize, argument);
    await page.goto(`${origin}/dist/${file}`);
}
async function popupCase(page, origin, variant) {
    await load(page, origin, 'popup/popup.html', ({ theme }) => {
        const job = { phase: 'ready', provider: 'garmin', activityId: '777', hasCachedGpx: true, selectedIds: [1],
            trackSummary: { originalPointCount: 50, retainedPointCount: 50, maxDeviationM: 0 },
            matches: [{ id: 1, name: 'A very long mountain name for a narrow popup', classification: 'strong', confidence: 98,
                evidence: { distanceM: 2, trackQuality: 1 } }] };
        globalThis.chrome = {
            tabs: { query: async () => [{ id: 9 }], create: async () => ({}), update: async () => ({}) },
            storage: { sync: { get: async () => ({ bpbSettings: { theme } }), set: async () => {} },
                onChanged: { addListener() {}, removeListener() {} } },
            runtime: { openOptionsPage: async () => {}, sendMessage: async message => {
                if (['CAPTURE_START', 'CAPTURE_STATUS'].includes(message.type)) return job;
                if (message.type === 'CAPTURE_OPEN_DRAFTS') return new Promise(resolve => {
                    globalThis.__finishOpen = fail => resolve(fail
                        ? { phase: 'error', error: { message: 'Drafts could not be opened. Try again.' } }
                        : { job: { ...job, phase: 'opened' }, groupWarning: true });
                });
                if (message.type === 'CAPTURE_CLEAR') return new Promise(resolve => {
                    globalThis.__finishClear = () => resolve({ ok: false, error: { message: 'The captured track could not be deleted. Try again.' } });
                });
                return { ok: true };
            } },
        };
    }, variant);
    await page.locator('#open-drafts').filter({ hasText: 'Open 1 draft' }).waitFor();
    const button = '#open-drafts';
    const before = await geometry(page, button);
    await page.click(button);
    await page.waitForFunction(() => typeof globalThis.__finishOpen === 'function');
    stable(before, await geometry(page, button), 'popup pending');
    await page.evaluate(() => globalThis.__finishOpen(true));
    await page.waitForFunction(() => !document.getElementById('open-drafts').disabled);
    stable(before, await geometry(page, button), 'popup error');
    await page.click(button);
    await page.waitForFunction(() => document.getElementById('open-drafts').disabled);
    await page.evaluate(() => globalThis.__finishOpen(false));
    await page.locator(button).filter({ hasText: 'Show opened drafts' }).waitFor();
    stable(before, await geometry(page, button), 'popup grouped completion');
    const clearBefore = await geometry(page, '#clear-capture');
    await page.click('#clear-capture');
    await page.waitForFunction(() => typeof globalThis.__finishClear === 'function');
    stable(clearBefore, await geometry(page, '#clear-capture'), 'popup clear pending');
    await page.evaluate(() => globalThis.__finishClear());
    await page.locator('#clear-capture').filter({ hasText: 'Delete captured track data' }).waitFor();
    stable(clearBefore, await geometry(page, '#clear-capture'), 'popup clear error');
    await capture(page, `${variant.name}-popup-error`);
}
async function accessCase(page, origin, variant) {
    for (const id of ['gaia', 'onx', 'alltrails', 'caltopo']) {
        await load(page, origin, `${id}/access.html`, ({ theme }) => {
            globalThis.chrome = {
                storage: { sync: { get: async () => ({ bpbSettings: { theme } }) },
                    onChanged: { addListener() {} } },
                permissions: { request: () => new Promise((resolve, reject) => {
                    globalThis.__finishPermission = result => result === 'error' ? reject(new Error('Unavailable')) : resolve(result);
                }) },
            };
        }, variant);
        const selector = `#allow-${id}`;
        const before = await geometry(page, selector);
        for (const result of ['error', false, true]) {
            await page.click(selector);
            await page.waitForFunction(id => document.getElementById(`allow-${id}`).disabled, id);
            stable(before, await geometry(page, selector), `${id} pending`);
            await page.evaluate(result => globalThis.__finishPermission(result), result);
            await page.waitForFunction(({ id, result }) => result === true
                ? !document.getElementById(`close-${id}`).hidden
                : !document.getElementById(`allow-${id}`).disabled, { id, result });
            stable(before, await geometry(page, selector), `${id} ${result}`);
        }
        await capture(page, `${variant.name}-${id}-access`);
    }
}
async function handoffCase(page, origin, variant) {
    await page.route(`${origin}/climber/ascent.aspx?aid=7654321`, route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><style>body{margin:20px;font:14px Arial}html[data-bpb-theme="dark"] body{background:#202222;color:#eee}#gpxlinks{max-width:900px;text-align:center}</style>'
        + '<a href="/climber/AscentEdit.aspx?aid=7654321">Edit ascent</a><p id="gpxlinks"><a href="/climber/GPXFile.aspx?aid=7654321&sep=1">Download this GPS track</a></p>' }));
    await page.addInitScript(({ theme }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { storage: { sync: { get: async () => ({ bpbSettings: { theme } }) },
            onChanged: { addListener() {}, removeListener() {} } }, runtime: { sendMessage: async message => {
            if (message.type.endsWith('_PERMISSION_REQUEST')) return new Promise(resolve => {
                globalThis.__finishPermission = () => resolve({ ok: true });
            });
            if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'fixture' };
            if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'fixture' };
            if (message.type.endsWith('_IMPORT_PREPARE')) return new Promise(resolve => {
                globalThis.__finishImport = success => resolve({ ok: success, supplied: success, targetTabId: 9,
                    message: success ? 'Your track is ready in the map. Review the preview and confirm when ready.'
                        : 'The map could not prepare this track. Check your connection and try the transfer again.' });
            });
            return { ok: true };
        } } };
    }, variant);
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
    await page.addStyleTag({ content: (await asset('css/ascent-gaia.css')).toString() });
    await page.addScriptTag({ content: (await asset('content/ascent-gaia.js')).toString() });
    await page.locator('.bpb-map-handoff-button').first().waitFor();
    for (const id of ['gaia', 'onx', 'alltrails', 'caltopo']) {
        const selector = `[data-provider="${id}"]`;
        const before = await geometry(page, selector);
        const allBefore = await page.locator('.bpb-map-handoff-button').evaluateAll(elements => elements.map(element => {
            const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
        }));
        for (const success of [false, true]) {
            await page.click(selector);
            await page.waitForFunction(() => typeof globalThis.__finishPermission === 'function');
            stable(before, await geometry(page, selector), `${id} preparing`);
            await page.evaluate(() => { globalThis.__finishImport = null; globalThis.__finishPermission(); });
            await page.waitForFunction(() => typeof globalThis.__finishImport === 'function');
            stable(before, await geometry(page, selector), `${id} opening`);
            await page.evaluate(success => globalThis.__finishImport(success), success);
            await page.waitForFunction(id => !document.querySelector(`[data-provider="${id}"]`).disabled, id);
            stable(before, await geometry(page, selector), `${id} completed ${success}`);
            const allAfter = await page.locator('.bpb-map-handoff-button').evaluateAll(elements => elements.map(element => {
                const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
            }));
            allBefore.forEach((rect, index) => stable(rect, allAfter[index], `${id} neighboring action ${index}`));
        }
    }
    await capture(page, `${variant.name}-handoff`);
    await page.addStyleTag({ content: (await asset('css/ascent-weather.css')).toString() });
    await page.locator('#gpxlinks').evaluate(element => { element.id = 'bpb-ascent-gpx-details'; });
    const collapsed = await geometry(page, '[data-provider="gaia"]');
    await page.click('[data-provider="gaia"]');
    await page.evaluate(() => globalThis.__finishPermission());
    await page.waitForFunction(() => document.querySelector('[data-provider="gaia"]').textContent.includes('Opening'));
    stable(collapsed, await geometry(page, '[data-provider="gaia"]'), 'handoff GPX details pending');
    await page.evaluate(() => globalThis.__finishImport(true));
    await page.waitForFunction(() => !document.querySelector('[data-provider="gaia"]').disabled);
    stable(collapsed, await geometry(page, '[data-provider="gaia"]'), 'handoff GPX details completion');
}
async function ascentBackupCase(page, origin, variant) {
    const html = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascent.html'), 'utf8');
    const edit = new JSDOM(await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascentedit.html'), 'utf8'));
    edit.window.document.getElementById('PeakListBox').innerHTML = '<option value="2296" selected>Mount Rainier</option>';
    edit.window.document.getElementById('DateText').setAttribute('value', '2026-07-12');
    edit.window.document.getElementById('PointFt').setAttribute('value', '14411');
    const editHtml = edit.serialize();
    edit.window.close();
    await page.route('**/climber/ascent.aspx?aid=7654321', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/climber/ascentedit.aspx**', route => route.fulfill({ contentType: 'text/html', body: editHtml }));
    await page.route('**/climber/GPXFile.aspx**', route => route.fulfill({ contentType: 'application/gpx+xml',
        body: '<gpx><trk><trkseg></trkseg></trk></gpx>' }));
    await page.addInitScript(({ theme }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }), sendMessage: async message => {
            if (message.type === 'GITHUB_BACKUP_STATUS') return { enabled: true, connected: true, auto: false };
            if (message.type === 'GITHUB_CHECK_ASCENT_BACKUP') return { ok: true, current: false };
            if (message.type === 'TRUSTED_ACTION_ISSUE') return { ok: true, token: 'fixture' };
            if (message.type === 'TRUSTED_ACTION_BEGIN') return { ok: true, grantToken: 'fixture' };
            if (message.type === 'GITHUB_BACKUP_ASCENT') return new Promise(resolve => {
                globalThis.__finishBackup = ok => resolve(ok ? { ok: true, result: { commitUrl: 'https://github.com/example/backup/commit/123' } }
                    : { ok: false, error: { code: 'network', message: 'A long backup failure. Check your connection before trying this ascent again.' } });
            });
            return { ok: true };
        } } };
    }, variant);
    await page.goto(`${origin}/climber/ascent.aspx?aid=7654321`);
    await page.addStyleTag({ content: (await asset('css/ascent-backup.css')).toString() });
    await page.addScriptTag({ content: (await asset('content/ascent-backup.js')).toString() });
    const action = '.bpb-gh-btn';
    await page.locator(action).filter({ hasText: 'Back up ascent and TR' }).waitFor();
    const before = await geometry(page, action);
    for (const success of [false, true]) {
        await page.click(action);
        await page.waitForFunction(() => typeof globalThis.__finishBackup === 'function');
        stable(before, await geometry(page, action), 'ascent backup pending');
        await page.evaluate(success => { globalThis.__finishBackup(success); globalThis.__finishBackup = null; }, success);
        await page.locator(action).filter({ hasText: success ? 'Backed up' : 'Try again' }).waitFor();
        stable(before, await geometry(page, action), `ascent backup complete ${success}`);
    }
    await capture(page, `${variant.name}-ascent-backup`);
}
async function profileBackupCase(page, origin, variant) {
    const html = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-ascents.html'), 'utf8');
    await page.route('**/climber/ClimbListC.aspx**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.addInitScript(({ theme }) => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.bpbTheme = theme; });
        globalThis.chrome = { runtime: { sendMessage: async message => message.type === 'GITHUB_BACKUP_STATUS'
            ? { enabled: true, connected: true, repo: { fullName: 'fixture/backup' } } : { ok: true } } };
    }, variant);
    await page.goto(`${origin}/climber/ClimbListC.aspx?cid=900001&j=-1&y=9999`);
    await page.addStyleTag({ content: (await asset('css/profile-backup.css')).toString() });
    const source = (await asset('content/profile-backup.js')).toString();
    const seam = 'const responseText = (url, kind, signal) =>';
    assert.ok(source.includes(seam), 'profile callback fixture seam');
    // Expose the actual view callback in this fixture only, avoiding live writes.
    await page.addScriptTag({ content: source.replace(seam, `globalThis.__renderBackupProgress = renderState; ${seam}`) });
    await page.locator('#bpb-profile-backup .bpb-profile-primary').waitFor();
    const state = { status: 'running', current: null, completed: 1, total: 99, fetched: 1, buffered: 0, uploading: 0,
        failures: [], backedUp: 0, skipped: 0, notReached: 98 };
    await page.evaluate(state => globalThis.__renderBackupProgress(state), state);
    const action = '#bpb-profile-backup .bpb-profile-actions button';
    const before = await page.locator(action).evaluateAll(elements => elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    }));
    await page.locator(action).first().focus();
    await page.evaluate(() => { globalThis.__focusedAction = document.activeElement; });
    for (let tick = 0; tick < 20; tick++) {
        await page.evaluate(state => globalThis.__renderBackupProgress(state), { ...state, completed: tick,
            current: { peakName: tick % 2 ? 'Short peak' : 'An extremely long mountain name repeated through progress updates without moving the active buttons' } });
        const after = await page.locator(action).evaluateAll(elements => elements.map(element => {
            const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
        }));
        before.forEach((rect, index) => stable(rect, after[index], `profile progress ${tick} action ${index}`));
        assert.equal(await page.evaluate(() => document.activeElement === globalThis.__focusedAction), true, 'progress preserves focused node');
    }
    for (const status of ['pause-requested', 'paused', 'cancel-requested']) {
        await page.evaluate(state => globalThis.__renderBackupProgress(state), { ...state, status, pauseReason: 'github', pauseError: null });
        const controls = await page.locator(action).evaluateAll(elements => elements.map(element => {
            const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
        }));
        controls.forEach((rect, index) => stable(before[status === 'cancel-requested' ? 1 : index], rect, `profile ${status}`));
    }
    await capture(page, `${variant.name}-profile-backup`);
}
async function settingsCase(page, origin, variant) {
    await load(page, origin, 'options/options.html', ({ theme }) => {
        const settings = { theme, units: 'auto', enable3dMap: true };
        const listeners = [];
        const area = { get: async () => ({ bpbSettings: settings }), set: async value => {
            const oldValue = { ...settings }; Object.assign(settings, value.bpbSettings);
            listeners.forEach(listener => listener({ bpbSettings: { oldValue, newValue: { ...settings } } }, 'sync'));
        }, remove: async () => {} };
        globalThis.chrome = { storage: { sync: area, local: area, session: area,
            onChanged: { addListener: listener => listeners.push(listener), removeListener() {} } },
        permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.0' }), getURL: file => new URL(`/dist/${file}`, location.origin).href,
            sendMessage: async message => {
                if (message.type === 'SETTINGS_PATCH') { Object.assign(settings, message.patch); return { ok: true, settings: { ...settings } }; }
                return { ok: true, configured: false, connected: false };
            } } };
    }, variant);
    await page.locator('#unit-example-gpx').filter({ hasText: '12.4 mi' }).waitFor();
    await page.locator('.content').evaluate(content => {
        const fixture = document.createElement('section'); fixture.id = 'jitter-component-fixture';
        fixture.innerHTML = '<div class="github-code"><span class="github-code-value">AAAA-BBBB</span><span class="github-code-copy">Copy</span></div>'
            + '<div class="draft-actions"><button class="secondary" data-action="copy"><span>Copy Markdown</span></button><button class="secondary">Delete</button></div>'
            + '<div class="favorites-source-filter"><button>All <span>123</span></button><button>Custom <span>99</span></button></div>';
        content.append(fixture);
    });
    for (const zoom of [1, 2]) {
        await page.locator('body').evaluate((body, zoom) => { body.style.zoom = String(zoom); }, zoom);
        await page.locator('#units').scrollIntoViewIfNeeded();
        const before = await geometry(page, '#units');
        for (const units of ['metric', 'imperial', 'auto']) {
            await page.selectOption('#units', units);
            await page.waitForFunction(units => document.getElementById('units').value === units, units);
            stable(before, await geometry(page, '#units'), `units example ${units} zoom ${zoom}`);
        }
        await capture(page, `${variant.name}-units-${zoom}`);
        for (const id of ['terrain-cache-usage', 'settings-backup-github-status', 'favorites-github-status', 'ignored-github-status', 'photos-github-status']) {
            await page.locator(`#${id}`).evaluate(element => {
                const row = element.closest('.row'); row.hidden = false;
                row.querySelectorAll('.control').forEach(control => { control.hidden = false; });
            });
            const row = page.locator(`#${id}`).locator('..');
            await row.scrollIntoViewIfNeeded();
            const action = row.locator('button, input').first();
            const rect = await action.boundingBox();
            await page.locator(`#${id}`).evaluate(element => { element.textContent = 'A long error from the connected backup service. Check your connection and review the current backup before retrying. '.repeat(3); });
            stable(rect, await action.boundingBox(), `${id} feedback zoom ${zoom}`);
        }
        const nav = page.locator('.nav-item').first();
        const navBefore = await nav.boundingBox();
        await nav.evaluate(element => { element.toggleAttribute('aria-current', !element.hasAttribute('aria-current')); });
        stable(navBefore, await nav.boundingBox(), `navigation selected zoom ${zoom}`);
        await page.locator('#jitter-component-fixture').scrollIntoViewIfNeeded();
        for (const [selector, labels] of [['.github-code-copy', ['Copied', 'Select and copy']], ['[data-action="copy"] > span', ['Copied', 'Copy Markdown']]]) {
            const target = page.locator(`#jitter-component-fixture ${selector}`);
            const parent = target.locator('..');
            const rect = await parent.boundingBox();
            for (const label of labels) {
                await target.evaluate((element, label) => { element.textContent = label; }, label);
                stable(rect, await parent.boundingBox(), `${selector} ${label} zoom ${zoom}`);
            }
        }
        const filter = page.locator('#jitter-component-fixture .favorites-source-filter button').first();
        const filterRect = await filter.boundingBox();
        await filter.evaluate(element => { element.setAttribute('aria-pressed', 'true'); });
        stable(filterRect, await filter.boundingBox(), `favorites selected zoom ${zoom}`);
    }
    await capture(page, `${variant.name}-settings`);
}
const cases = { popup: popupCase, access: accessCase, handoff: handoffCase, 'ascent-backup': ascentBackupCase, 'profile-backup': profileBackupCase, settings: settingsCase };
const resources = createResourceStack();
let failure = null;
try {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-jitter-fixture-'));
    resources.defer('jitter fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await createBrowserFixtureServer({ temporaryRoot });
    resources.defer('jitter fixture server', () => fixture.close());
    const origin = `https://www.peakbagger.com:${fixture.port}`;
    for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
        if (process.argv.includes('--chrome-only') && name !== 'chrome') continue;
        if (engine === chromium) assertChromeLaunchAllowed();
        const browser = await engine.launch({ headless: true, ...(engine === chromium
            ? { channel: 'chromium', args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
            : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }) });
        try {
            for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
                for (const [surface, check] of Object.entries(cases)) {
                    if (selected && selected !== surface) continue;
                    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, colorScheme: theme });
                    try {
                        await context.route(`${origin}/dist/**`, async route => {
                            const file = new URL(route.request().url()).pathname.slice('/dist/'.length);
                            if (file.includes('..')) return route.abort();
                            try { await route.fulfill({ body: await asset(file), contentType: fixtureContentType(file) }); }
                            catch { await route.fulfill({ status: 404, body: 'Missing shipped fixture asset' }); }
                        });
                        const page = await context.newPage();
                        page.setDefaultTimeout(10000);
                        page.on('pageerror', error => console.error(`${surface}: ${error.message}`));
                        const variant = { theme, width, name: `${name}-${theme}-${width}` };
                        await check(page, origin, variant);
                        console.log(JSON.stringify({ browser: name, version: browser.version(), hidden: true,
                            surface, theme, viewport: `${width}x900`, result: 'passed' }));
                    } finally { await context.close(); }
                }
            }
        } finally { await browser.close(); }
    }
} catch (error) { failure = error; }
await resources.dispose(failure);
