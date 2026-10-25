/* global window, document, scrollX, scrollY, innerWidth, getComputedStyle */
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual packaged UI with synthetic runtime replies. Native host-permission
// prompts and real Garmin/Peakbagger sessions require separate verification.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:https';
import { chromium, firefox } from 'playwright';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createFixtureCertificate, resolveFixtureFile, sendFixtureFile } from './browser-verification-fixtures.mjs';
import { settingsSchema as Schema } from '../src/settings/settings-schema.js';
import { initSectionNav } from '../src/ui/section-nav.js';
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && ['--popup', '--navigation'].includes(args[0])), 'Only --popup or --navigation is supported');
const popupOnly = args.includes('--popup');
const navigationOnly = args.includes('--navigation');
assertChromeLaunchAllowed();
const root = path.resolve(process.env.BPB_VERIFY_GARMIN_SOURCE || new URL('../dist/', import.meta.url).pathname);
const output = '/tmp/garmin-implementation-ui'; await mkdir(output, { recursive: true });
const certificate = await createFixtureCertificate({ label: 'garmin-ui' });
const server = createServer({ key: certificate.key, cert: certificate.cert }, async (request, response) => {
    try {
        const pathname = new URL(request.url, 'https://www.peakbagger.com').pathname;
        // Other settings sections retain their real markup and styles, but
        // their unrelated network/account controllers stay idle in this fixture.
        // Keep the real navigation controller: an empty options.js masks broken
        // fragment landings when Garmin appears after the settings read.
        if (pathname === '/options/options.js') { response.setHeader('content-type', 'text/javascript'); response.end(`(${initSectionNav})();`); return; }
        const file = await resolveFixtureFile(pathname, root);
        if (!file) { response.writeHead(404); response.end(); return; }
        await sendFixtureFile(response, file);
    } catch { response.writeHead(500); response.end(); }
});
const browsers = []; let cases = 0;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://www.peakbagger.com:${server.address().port}`;
    for (const name of ['chromium', 'firefox']) {
        assertChromeLaunchAllowed();
        console.log(`Starting hidden ${name} Garmin UI checks`);
        const browser = name === 'chromium' ? await chromium.launch({ channel: 'chromium', headless: true, timeout: 30000,
            args: ['--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', ...certificate.chromeTrustArgs], ignoreDefaultArgs: ['--enable-unsafe-swiftshader'] })
            : await firefox.launch({ headless: true, timeout: 30000, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        browsers.push(browser);
        const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
        context.setDefaultTimeout(15000);
        await context.addInitScript(defaults => {
            const prefs = { ...defaults, removeGpxTimestamps: true,
                theme: new window.URLSearchParams(window.location.search).get('theme') || defaults.theme,
                ...(window.location.search.includes('disabled') ? { enableGarminInbox: false } : {}) };
            const listeners = [];
            const row = { id: '123', owner: '1234', cid: '5678', phase: 'ready', saved: [], summary: { date: '2026-10-23', type: 'hiking' },
                analysis: { matches: [{ id: 123, name: 'Example Mountain', classification: 'strong' }, { id: 124, name: 'Example Ridge', classification: 'probable' }], hasTimestamps: true } };
            window.fixture = { mode: 'success', checks: 0, connects: 0, enables: 0, opens: 0, captures: 0, statuses: 0, state: { configured: true, enabled: !window.location.pathname.endsWith('/options/options.html'), pending: 1, cid: '5678', items: [row], history: [], connectedDate: '2026-10-23' } };
            if (window.location.search.includes('navigation')) {
                window.fixture.holdSettings = true;
                window.fixture.readGate = new Promise(resolve => { window.fixture.releaseSettings = resolve; });
            }
            if (window.location.search.includes('queued')) {
                row.analysis = null; row.phase = 'waiting';
                window.fixture.state.queued = 1;
                window.fixture.state.peakbaggerBlocked = { code: 'cloudflare' };
            }
            window.fixture.setEnabled = value => { prefs.enableGarminInbox = value; listeners.forEach(fn => fn({ bpbSettings: { newValue: prefs } }, 'sync')); };
            window.chrome = { permissions: { request: async () => true }, storage: { sync: { get: async () => { if (window.fixture.holdSettings) await window.fixture.readGate; return { bpbSettings: prefs }; } },
                local: { get: async () => ({ bpbDeviceSettings: { schemaVersion: 1, settings: prefs } }) }, onChanged: { addListener: fn => listeners.push(fn), removeListener() {} } },
            tabs: { query: async () => [{ id: 1, url: 'https://www.peakbagger.com/default.aspx' }], getCurrent: async () => ({ id: 1 }) }, runtime: { sendMessage: async message => {
                if (message.type === 'GARMIN_STATUS') window.fixture.statuses++;
                if (message.type === 'SETTINGS_PATCH') { Object.assign(prefs, message.patch); return { ok: true, settings: prefs }; }
                if (message.type === 'GARMIN_SUMMARY') return { ok: true, ...structuredClone(window.fixture.state) };
                if (message.type === 'CAPTURE_STATUS') return null;
                if (message.type === 'CAPTURE_START') window.fixture.captures++;
                if (message.type === 'GARMIN_INBOX_OPEN') {
                    window.fixture.opens++;
                    return new Promise(resolve => { window.fixture.finishOpen = resolve; });
                }
                if (message.type === 'GARMIN_DISMISS') { window.fixture.state.items = []; window.fixture.state.history = [{ id: row.id, date: row.summary.date, dismissed: true, undoAvailable: true }]; }
                if (message.type === 'GARMIN_UNDO') { window.fixture.state.items = [row]; window.fixture.state.history = []; }
                if (message.type === 'GARMIN_OPEN_DRAFTS') { window.fixture.opens++; await new Promise(resolve => setTimeout(resolve, 350)); row.handoff = true; }
                if (message.type === 'GARMIN_CONNECT') { window.fixture.connects++; await new Promise(resolve => setTimeout(resolve, 350));
                    if (window.fixture.mode !== 'success') return { ok: false, error: { message: 'Garmin didn’t accept this key. Copy the full key or get a new one.' } }; }
                if (message.type === 'GARMIN_ENABLE') { window.fixture.enables++; await new Promise(resolve => setTimeout(resolve, 350));
                    if (window.fixture.mode !== 'success') return { ok: false, error: { message: 'Open Peakbagger and sign in before enabling drafts.' } };
                    window.fixture.state.enabled = true; }
                if (message.type === 'GARMIN_CHECK') { window.fixture.checks++; window.fixture.state.checking = true;
                    setTimeout(() => { window.fixture.state.checking = false; window.fixture.state.error = { code: 'key-rejected', message: 'Garmin needs a new API key. Imports paused; your drafts are safe.' }; }, 350); }
                return { ok: true, ...structuredClone(window.fixture.state) };
            } } };
        }, Schema.DEFAULTS);
        const page = await context.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const geometry = selectors => page.evaluate(selectors => ({ scroll: [scrollX, scrollY, document.querySelector('.content')?.scrollTop || 0], boxes: selectors.map(s => {
            const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        }) }), selectors);
        const stable = (before, after) => { assert.deepEqual(after.scroll, before.scroll); before.boxes.forEach((box, i) => Object.keys(box).forEach(key => assert(Math.abs(box[key] - after.boxes[i][key]) <= 1, `${name} shifted ${i}.${key}: ${box[key]} → ${after.boxes[i][key]}`))); };
        for (const theme of ['light', 'dark']) for (const width of popupOnly ? [] : [1180, 390]) {
            console.log(`${name}: ${theme}/${width}`);
            await page.setViewportSize({ width, height: 1000 });
            const landing = async () => {
                await page.waitForFunction(() => !!window.fixture.releaseSettings);
                assert(await page.locator('#capture-garmin').isHidden(), 'The fragment target must stay hidden until settings resolve');
                await page.evaluate(() => { window.fixture.holdSettings = false; window.fixture.releaseSettings(); });
                try {
                    await page.waitForFunction(() => {
                        const content = document.querySelector('.content'), target = document.getElementById('capture-garmin');
                        const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
                        return !target.hidden && content.scrollTop > 0 && content.style.scrollBehavior === ''
                            && Math.abs(target.getBoundingClientRect().top - content.getBoundingClientRect().top - margin) <= 1
                            && document.querySelector('.side-nav [aria-current]')?.getAttribute('href') === '#capture-garmin';
                    });
                } catch (error) {
                    throw new Error(`Garmin return did not land: ${JSON.stringify(await geometry(['#capture-garmin', '.content', '.side-nav']))}`, { cause: error });
                }
            };
            await page.goto(`${origin}/options/options.html?navigation#capture-garmin`);
            await landing();
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            await page.locator('.garmin-inbox-link').click();
            await page.locator('.garmin-activity').waitFor();
            await page.goBack();
            await landing();
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            const landed = await geometry(['#capture-garmin', '.content', '.side-nav']);
            await page.evaluate(() => window.fixture.setEnabled(true));
            stable(landed, await geometry(['#capture-garmin', '.content', '.side-nav']));
            // Later preference updates must not steal the reader's position.
            await page.evaluate(() => {
                const content = document.querySelector('.content');
                content.scrollTo({ top: content.scrollTop + 100, behavior: 'instant' });
            });
            const scrolled = await geometry(['#capture-garmin', '.content', '.side-nav']);
            await page.evaluate(() => window.fixture.setEnabled(true));
            stable(scrolled, await geometry(['#capture-garmin', '.content', '.side-nav']));
            await page.goForward();
            await page.locator('.garmin-activity').waitFor();
            await page.locator('.garmin-brand a').click();
            await page.waitForFunction(() => {
                const content = document.querySelector('.content'), target = document.getElementById('capture-garmin');
                return target && content && !target.hidden && content.scrollTop > 0 && content.style.scrollBehavior === ''
                    && Math.abs(target.getBoundingClientRect().top - content.getBoundingClientRect().top
                        - parseFloat(getComputedStyle(target).scrollMarginTop)) <= 1;
            });
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `navigation-${width}-${theme}.png`) });
            if (navigationOnly) { cases++; continue; }
            await page.goto(`${origin}/options/options.html#capture-garmin`);
            await page.locator('#garmin-key-status').filter({ hasText: 'Connected on this device' }).waitFor();
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            const actionSizes = await page.evaluate(() => ['#garmin-connect', '#garmin-save', '#garmin-enable', '#settings-backup-export']
                .map(selector => ({ selector, height: document.querySelector(selector).getBoundingClientRect().height })));
            for (const action of actionSizes) assert(action.height >= 32 && action.height <= 36,
                `${name}/${width}: action buttons must use the compact shared size: ${JSON.stringify(actionSizes)}`);
            assert(Math.max(...actionSizes.map(action => action.height)) - Math.min(...actionSizes.map(action => action.height)) <= 1,
                `${name}/${width}: Garmin and existing settings actions must have equal heights: ${JSON.stringify(actionSizes)}`);
            assert.equal(await page.locator('#garmin-connect').evaluate(el => el.classList.contains('primary')), false,
                'Reconnecting an already connected account is a secondary action');
            const entry = await geometry(['#garmin-key', '#garmin-show-key']);
            await page.locator('#garmin-show-key').click();
            assert.equal(await page.locator('#garmin-key').getAttribute('type'), 'text');
            stable(entry, await geometry(['#garmin-key', '#garmin-show-key']));
            await page.locator('#garmin-show-key').click();
            stable(entry, await geometry(['#garmin-key', '#garmin-show-key']));
            await page.locator('#garmin-key').fill('fictional-demo-key-for-layout');
            await page.evaluate(() => { window.fixture.mode = 'rejected'; });
            const button = page.locator('#garmin-connect'); await button.focus();
            const selectors = ['#garmin-connect', '#capture-garmin h3', '#garmin-preferences'];
            const before = await geometry(selectors);
            await button.press('Enter'); await page.waitForFunction(() => document.querySelector('#garmin-connect').getAttribute('aria-busy') === 'true');
            stable(before, await geometry(selectors));
            await button.press('Enter');
            await page.locator('#garmin-key-status').filter({ hasText: 'Garmin didn’t accept' }).waitFor();
            stable(before, await geometry(selectors));
            assert.equal(await page.evaluate(() => window.fixture.connects), 1);
            assert(await button.evaluate(el => document.activeElement === el));
            await page.evaluate(() => { window.fixture.mode = 'success'; });
            await button.press('Enter');
            await page.waitForFunction(() => document.querySelector('#garmin-connect').getAttribute('aria-busy') === 'true');
            stable(before, await geometry(selectors));
            await page.locator('#garmin-key-status').filter({ hasText: 'Connected on this device' }).waitFor();
            stable(before, await geometry(selectors));
            assert.equal(await page.evaluate(() => window.fixture.connects), 2);
            assert(await button.evaluate(el => document.activeElement === el));
            assert.equal(await page.locator('.garmin-key-label a').getAttribute('href'), 'https://connect.garmin.com/app/settings/personalApiToken');
            await page.locator('#garmin-frequency').selectOption('0');
            assert.equal(await page.locator('#garmin-recent-help').textContent(), 'How far back Check now looks.');
            const types = page.locator('#garmin-types');
            assert.equal(await types.inputValue(), 'walking');
            assert.equal(await types.locator('option:checked').textContent(), 'Mountain activities');
            assert.match(await page.locator('label[for="garmin-types"] small').textContent(), /rock climbing, mountaineering and backcountry skiing/);
            await types.scrollIntoViewIfNeeded();
            const beforeTypes = await geometry(['#garmin-types', '#garmin-save', '#garmin-scope-note']);
            await types.selectOption('all');
            stable(beforeTypes, await geometry(['#garmin-types', '#garmin-save', '#garmin-scope-note']));
            await types.selectOption('walking');
            stable(beforeTypes, await geometry(['#garmin-types', '#garmin-save', '#garmin-scope-note']));
            const save = page.locator('#garmin-save'); await save.focus();
            const beforeSave = await geometry(['#garmin-save', '#garmin-scope-note', '#garmin-preferences > details']);
            await save.press('Enter');
            await page.locator('#garmin-settings-status').filter({ hasText: 'Preferences saved.' }).waitFor();
            stable(beforeSave, await geometry(['#garmin-save', '#garmin-scope-note', '#garmin-preferences > details']));
            if (name === 'chromium') {
                await page.screenshot({ path: path.join(output, `settings-${width}-${theme}-top.png`) });
                await page.locator('#garmin-save').scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(output, `settings-${width}-${theme}-actions.png`) });
            }
            if (width === 1180) {
                await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
                await types.scrollIntoViewIfNeeded();
                assert(await page.evaluate(() => {
                    const content = document.querySelector('.content');
                    return content.scrollWidth <= content.clientWidth + 1;
                }), 'The expanded activity description must wrap at 200% zoom');
                const enlarged = await geometry(['#garmin-types', '#garmin-save', '#garmin-scope-note']);
                await types.selectOption('all');
                stable(enlarged, await geometry(['#garmin-types', '#garmin-save', '#garmin-scope-note']));
                await types.selectOption('walking');
                stable(enlarged, await geometry(['#garmin-types', '#garmin-save', '#garmin-scope-note']));
                if (name === 'chromium') await page.screenshot({ path: path.join(output, `settings-${theme}-zoom.png`) });
                await page.evaluate(() => { document.documentElement.style.zoom = ''; });
            }
            const enable = page.locator('#garmin-enable'); await enable.focus();
            const beforeEnable = await geometry(['#garmin-enable', '#garmin-save', '.garmin-inbox-link', '#garmin-preferences > details']);
            await page.evaluate(() => { window.fixture.mode = 'enable-rejected'; });
            await enable.press('Enter');
            await page.waitForFunction(() => document.querySelector('#garmin-enable').getAttribute('aria-busy') === 'true');
            stable(beforeEnable, await geometry(['#garmin-enable', '#garmin-save', '.garmin-inbox-link', '#garmin-preferences > details']));
            await enable.press('Enter');
            await page.locator('#garmin-settings-status').filter({ hasText: 'Open Peakbagger and sign in' }).waitFor();
            stable(beforeEnable, await geometry(['#garmin-enable', '#garmin-save', '.garmin-inbox-link', '#garmin-preferences > details']));
            assert.equal(await page.evaluate(() => window.fixture.enables), 1);
            assert(await enable.evaluate(el => document.activeElement === el));
            await page.evaluate(() => { window.fixture.mode = 'success'; });
            await enable.press('Enter');
            await page.locator('#garmin-settings-status').filter({ hasText: 'Garmin drafts enabled.' }).waitFor();
            assert(await enable.isHidden(), 'Successful setup deliberately removes the enable action');
            assert.equal(await page.evaluate(() => window.fixture.enables), 2);
            page.once('dialog', dialog => dialog.dismiss());
            await page.locator('#garmin-preferences > details').evaluate(el => { el.open = true; });
            const beforeDelete = await page.locator('#garmin-settings-status').textContent();
            await page.locator('#garmin-delete').focus(); await page.locator('#garmin-delete').press('Enter');
            assert.equal(await page.locator('#garmin-settings-status').textContent(), beforeDelete);
            await page.goto(`${origin}/options/inbox.html?queued`);
            await page.locator('#inbox-queue').filter({ hasText: '1 activity waiting' }).waitFor();
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            assert.match(await page.locator('#inbox-status').textContent(), /human check/);
            assert(await page.locator('#inbox-resume-peaks').isVisible());
            const queuedGeometry = await geometry(['#inbox-check', 'h1', '#inbox-list', 'footer']);
            await page.evaluate(() => { window.fixture.state.peakbaggerBlocked = { code: 'rate-limit' }; });
            await page.locator('#inbox-status').filter({ hasText: 'asked us to wait' }).waitFor();
            stable(queuedGeometry, await geometry(['#inbox-check', 'h1', '#inbox-list', 'footer']));
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `queued-${width}-${theme}.png`) });
            await page.goto(`${origin}/options/inbox.html`);
            await page.locator('.garmin-activity').waitFor();
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            const check = page.locator('#inbox-check'); await check.focus();
            const inboxSelectors = ['#inbox-check', 'h1', '#inbox-list', 'footer'];
            const idle = await geometry(inboxSelectors);
            await check.press('Space'); await page.waitForFunction(() => window.fixture.state.checking);
            stable(idle, await geometry(inboxSelectors));
            await page.waitForFunction(() => document.querySelector('#inbox-status').textContent.includes('needs a new API key'));
            stable(idle, await geometry(inboxSelectors));
            assert.equal(await page.locator('.garmin-activity').count(), 1);
            assert(await check.evaluate(el => document.activeElement === el));
            assert(await page.locator('#inbox-update-key').isVisible());
            await check.press('Enter'); assert.equal(await page.evaluate(() => window.fixture.checks), 1);
            if (name === 'chromium') await page.locator('#inbox-content .garmin-workspace').screenshot({ path: path.join(output, `inbox-${width}-${theme}.png`) });
            await page.evaluate(() => {
                window.fixture.holdSettings = true;
                window.fixture.readGate = new Promise(resolve => { window.fixture.releaseSettings = resolve; });
            });
            await page.locator('.garmin-activity button').click();
            const firstReview = await geometry(['#inbox-open', '#inbox-review-title', '#inbox-history', 'footer']);
            await page.evaluate(() => { window.fixture.holdSettings = false; window.fixture.releaseSettings(); });
            await page.locator('#inbox-timestamp-row').waitFor();
            stable(firstReview, await geometry(['#inbox-open', '#inbox-review-title', '#inbox-history', 'footer']));
            const reviewStatus = await page.locator('#inbox-review-status').textContent();
            page.once('dialog', dialog => dialog.dismiss());
            await page.locator('#inbox-done').focus(); await page.locator('#inbox-done').press('Enter');
            assert.equal(await page.locator('#inbox-review-status').textContent(), reviewStatus);
            assert.equal(await page.locator('#inbox-matches input:checked').count(), 1);
            assert.equal(await page.locator('#inbox-matches input:not(:checked)').count(), 1);
            await page.locator('#inbox-dismiss').click();
            await page.waitForFunction(() => document.querySelectorAll('#inbox-list .garmin-activity').length === 0);
            await page.waitForFunction(() => document.activeElement.id === 'inbox-check');
            await page.locator('#inbox-history summary').click();
            await page.locator('#inbox-history-list button').click();
            await page.locator('#inbox-list .garmin-activity').waitFor();
            await page.waitForFunction(() => document.activeElement.matches('#inbox-list .garmin-activity button'));
            await page.locator('#inbox-list .garmin-activity button').click();
            const beforeUpdatedMatches = await geometry(['#inbox-refresh', '#inbox-open', '#inbox-history']);
            await page.evaluate(() => { window.fixture.state.items[0].analysis.matches[0].name = 'Updated Mountain'; });
            await page.locator('#inbox-refresh').filter({ hasText: 'Review updated matches' }).waitFor();
            stable(beforeUpdatedMatches, await geometry(['#inbox-refresh', '#inbox-open', '#inbox-history']));
            assert(await page.locator('#inbox-matches').textContent().then(text => text.includes('Example Mountain')));
            const refresh = page.locator('#inbox-refresh'); await refresh.focus(); await refresh.press('Enter');
            await page.locator('#inbox-matches').filter({ hasText: 'Updated Mountain' }).waitFor();
            assert(await refresh.evaluate(el => document.activeElement === el));
            const open = page.locator('#inbox-open'); await open.focus();
            const reviewSelectors = ['#inbox-open', '#inbox-refresh', '#inbox-review-title', '#inbox-history', 'footer'];
            const beforeOpen = await geometry(reviewSelectors);
            await open.press('Enter'); await page.waitForFunction(() => document.querySelector('#inbox-open').getAttribute('aria-busy') === 'true');
            stable(beforeOpen, await geometry(reviewSelectors)); await open.press('Enter');
            await page.locator('#inbox-saved').waitFor(); stable(beforeOpen, await geometry(reviewSelectors));
            assert.equal(await page.evaluate(() => window.fixture.opens), 1);
            assert.equal(await refresh.getAttribute('aria-disabled'), 'true');
            assert.equal(await page.locator('#inbox-dismiss').getAttribute('aria-disabled'), 'true');
            assert(await open.evaluate(el => document.activeElement === el));
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `review-${width}-${theme}.png`) });
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.goto(`${origin}/options/options.html?disabled#general`);
            await page.waitForFunction(() => document.getElementById('garmin-key') && document.getElementById('capture-garmin').hidden);
            assert(await page.locator('.side-nav a[href="#capture-garmin"]').isHidden());
            assert.equal(await page.evaluate(() => window.fixture.statuses), 0);
            await page.goto(`${origin}/options/inbox.html?disabled`);
            await page.locator('#inbox-disabled').waitFor();
            assert(await page.locator('#inbox-content').isHidden());
            assert.equal(await page.evaluate(() => window.fixture.statuses), 0);
            await page.evaluate(() => window.fixture.setEnabled(true));
            await page.locator('.garmin-activity').waitFor();
            assert(await page.locator('#inbox-disabled').isHidden());
            await page.goto(`${origin}/popup/popup.html?disabled`);
            await page.waitForFunction(() => document.getElementById('state').textContent.length > 0);
            assert(await page.locator('.inbox-entry').isHidden());
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `popup-disabled-${width}-${theme}.png`) });
            await page.evaluate(() => window.fixture.setEnabled(true));
            await page.locator('#activity-inbox').waitFor();
            cases++;
        }
        if (!popupOnly && !navigationOnly) {
            await page.setViewportSize({ width: 390, height: 1000 });
            await page.goto(`${origin}/options/inbox.html`); await page.locator('.garmin-activity').waitFor();
            await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        }
        for (const theme of navigationOnly ? [] : ['light', 'dark']) for (const zoom of [1, 2]) {
            await page.setViewportSize({ width: 390 * zoom, height: 600 * zoom });
            await page.goto(`${origin}/popup/popup.html?theme=${theme}`);
            await page.locator('#inbox-count').filter({ hasText: '1' }).waitFor();
            await page.waitForFunction(() => document.querySelector('#state').textContent.length > 0);
            await page.waitForFunction(theme => document.documentElement.dataset.bpbTheme === theme, theme);
            await page.evaluate(zoom => {
                document.documentElement.style.zoom = zoom;
                window.fixture.closed = 0;
                window.close = () => { window.fixture.closed++; };
            }, zoom);
            const sizes = await geometry(['#activity-inbox', '.inbox-entry']);
            assert(sizes.boxes[0].width < sizes.boxes[1].width / 2,
                'Inbox navigation must have a compact Open inbox action, not a full-width menu-like button');
            assert.equal(await page.locator('.inbox-entry h2').textContent(), 'Activity inbox');
            assert.equal(await page.locator('#activity-inbox').textContent(), 'Open inbox');
            assert(await page.locator('.inbox-entry svg[aria-hidden="true"]').isVisible());
            const inbox = page.locator('#activity-inbox'); await inbox.focus();
            const selectors = ['#activity-inbox', '.inbox-entry', '#inbox-count', '.brand', '#state'];
            const before = await geometry(selectors);
            await inbox.hover(); stable(before, await geometry(selectors));
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `popup-${theme}-${zoom}x-idle.png`) });
            for (const pending of [0, 99, 200, 1]) {
                await page.evaluate(pending => {
                    window.fixture.state.pending = pending;
                    window.fixture.setEnabled(true);
                }, pending);
                await page.waitForFunction(pending => document.querySelector('#activity-inbox')
                    .getAttribute('aria-label').includes(`${pending} pending`), pending);
                stable(before, await geometry(selectors));
                assert.equal(await page.locator('#inbox-count').textContent(), pending > 99 ? '99+' : pending ? String(pending) : '');
                if (pending === 0) {
                    assert(await page.locator('#inbox-count').isHidden(), 'An empty count must not paint an empty badge');
                    if (name === 'chromium') await page.screenshot({ path: path.join(output, `popup-${theme}-${zoom}x-empty.png`) });
                }
            }
            for (const summary of [
                { configured: false, manual: false, queued: 0, text: 'Connect Garmin' },
                { configured: true, manual: true, queued: 0, text: 'ready when you check' },
                { configured: true, manual: false, queued: 200, text: '200 waiting for peak checks' },
            ]) {
                await page.evaluate(summary => {
                    Object.assign(window.fixture.state, summary);
                    window.fixture.setEnabled(true);
                }, summary);
                await page.locator('#activity-inbox-status').filter({ hasText: summary.text }).waitFor();
                stable(before, await geometry(selectors));
            }
            await page.evaluate(() => {
                window.fixture.state.error = { code: 'key-rejected' };
                window.fixture.setEnabled(true);
            });
            await page.locator('#activity-inbox-status').filter({ hasText: 'Garmin needs a new key' }).waitFor();
            stable(before, await geometry(selectors));
            await inbox.press('Enter');
            await page.waitForFunction(() => document.querySelector('#activity-inbox').getAttribute('aria-busy') === 'true');
            stable(before, await geometry(selectors));
            assert(await inbox.evaluate(el => document.activeElement === el));
            await inbox.press('Enter'); await inbox.press('Space');
            await inbox.click({ force: true });
            assert.equal(await page.evaluate(() => window.fixture.opens), 1);
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `popup-${theme}-${zoom}x-pending.png`) });
            await page.evaluate(() => window.fixture.finishOpen({ ok: false }));
            await page.locator('#activity-inbox-status').filter({ hasText: 'Couldn’t open inbox' }).waitFor();
            stable(before, await geometry(selectors));
            assert(await inbox.evaluate(el => document.activeElement === el));
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `popup-${theme}-${zoom}x-error.png`) });
            await inbox.press('Space');
            await page.waitForFunction(() => document.querySelector('#activity-inbox').getAttribute('aria-busy') === 'true');
            stable(before, await geometry(selectors));
            assert.equal(await page.evaluate(() => window.fixture.opens), 2);
            await page.evaluate(() => window.fixture.finishOpen({ ok: true }));
            await page.waitForFunction(() => window.fixture.closed === 1);
            stable(before, await geometry(selectors));
            assert.equal(await page.evaluate(() => window.fixture.captures), 0);
            assert.equal(await page.evaluate(() => document.documentElement.dataset.bpbTheme), theme);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.evaluate(() => window.fixture.setEnabled(false));
            await page.locator('.inbox-entry').waitFor({ state: 'hidden' });
            await page.locator('#open-settings').focus(); await page.keyboard.press('Tab');
            assert.equal(await inbox.evaluate(el => document.activeElement === el), false);
            cases++;
        }
        assert.deepEqual(errors, []);
        console.log(`${name} ${browser.version()}: ${navigationOnly ? 'delayed Garmin deep links, Inbox Back/Forward and Settings return; both themes at 1180×1000 and 390×1000' : `${popupOnly ? 'popup' : 'settings and inbox'}; popup counts, pending/rejection/retry/success, duplicate activation and focus; both themes at 390×600 CSS px, 100%/200% CSS zoom`}. Hidden DOM/CSS; transport/session replies and popup dismissal stubbed.`);
        await context.close();
    }
    assert.equal(cases, popupOnly || navigationOnly ? 8 : 16); console.log(`Garmin UI checks passed: ${cases} cases. Images: ${output}`);
} finally {
    const closed = await Promise.allSettled(browsers.reverse().map(browser => browser.close()));
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await certificate.remove();
    assert(closed.every(result => result.status === 'fulfilled'), 'Browser teardown failed');
}
