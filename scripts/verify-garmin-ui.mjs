/* global window, document, scrollX, scrollY, innerWidth */
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
assert.equal(process.argv.length, 2, 'No arguments supported');
assertChromeLaunchAllowed();
const root = path.resolve(new URL('../dist/', import.meta.url).pathname);
const output = '/tmp/garmin-implementation-ui'; await mkdir(output, { recursive: true });
const certificate = await createFixtureCertificate({ label: 'garmin-ui' });
const server = createServer({ key: certificate.key, cert: certificate.cert }, async (request, response) => {
    try {
        const pathname = new URL(request.url, 'https://www.peakbagger.com').pathname;
        // Other settings sections retain their real markup and styles, but
        // their unrelated network/account controllers stay idle in this fixture.
        if (pathname === '/options/options.js') { response.setHeader('content-type', 'text/javascript'); response.end(''); return; }
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
            const prefs = { ...defaults };
            const row = { id: '123', owner: '1234', cid: '5678', phase: 'ready', saved: [], summary: { date: '2026-10-23', type: 'hiking' },
                analysis: { matches: [{ id: 123, name: 'Example Mountain', classification: 'strong' }, { id: 124, name: 'Example Ridge', classification: 'probable' }], hasTimestamps: false } };
            window.fixture = { mode: 'success', checks: 0, connects: 0, enables: 0, opens: 0, captures: 0, state: { configured: true, enabled: !window.location.pathname.endsWith('/options/options.html'), pending: 1, cid: '5678', items: [row], history: [], connectedDate: '2026-10-23' } };
            window.chrome = { permissions: { request: async () => true }, storage: { sync: { get: async () => ({ bpbSettings: prefs }) }, onChanged: { addListener() {}, removeListener() {} } },
                tabs: { query: async () => [{ id: 1 }], getCurrent: async () => ({ id: 1 }) }, runtime: { sendMessage: async message => {
                    if (message.type === 'SETTINGS_PATCH') { Object.assign(prefs, message.patch); return { ok: true, settings: prefs }; }
                    if (message.type === 'GARMIN_SUMMARY') return { ok: true, configured: true, pending: 1 };
                    if (message.type === 'CAPTURE_STATUS') return null;
                    if (message.type === 'CAPTURE_START') window.fixture.captures++;
                    if (message.type === 'GARMIN_INBOX_OPEN') { window.fixture.opens++; await new Promise(resolve => setTimeout(resolve, 300)); return { ok: false }; }
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
        for (const theme of ['light', 'dark']) for (const width of [1180, 390]) {
            console.log(`${name}: ${theme}/${width}`);
            await page.setViewportSize({ width, height: 1000 });
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
            if (name === 'chromium') await page.locator('.garmin-workspace').screenshot({ path: path.join(output, `inbox-${width}-${theme}.png`) });
            await page.locator('.garmin-activity button').click();
            assert.equal(await page.locator('#inbox-matches input:checked').count(), 1);
            assert.equal(await page.locator('#inbox-matches input:not(:checked)').count(), 1);
            await page.locator('#inbox-dismiss').click();
            await page.waitForFunction(() => document.querySelectorAll('#inbox-list .garmin-activity').length === 0);
            await page.locator('#inbox-history summary').click();
            await page.locator('#inbox-history-list button').click();
            await page.locator('#inbox-list .garmin-activity').waitFor();
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
            cases++;
        }
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.goto(`${origin}/options/inbox.html`); await page.locator('.garmin-activity').waitFor();
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        for (const theme of ['light', 'dark']) {
            await page.setViewportSize({ width: 390, height: 700 });
            await page.goto(`${origin}/popup/popup.html`);
            await page.locator('#inbox-count').filter({ hasText: '1' }).waitFor();
            await page.evaluate(theme => document.documentElement.dataset.bpbTheme = theme, theme);
            const inbox = page.locator('#activity-inbox'); await inbox.focus();
            const selectors = ['#activity-inbox', '.brand', '#state']; const before = await geometry(selectors);
            await inbox.press('Enter');
            await page.waitForFunction(() => document.querySelector('#activity-inbox').getAttribute('aria-busy') === 'true');
            stable(before, await geometry(selectors)); await inbox.press('Enter');
            await page.locator('#activity-inbox-status').filter({ hasText: 'Couldn’t open inbox' }).waitFor();
            stable(before, await geometry(selectors));
            assert.equal(await page.evaluate(() => window.fixture.opens), 1);
            assert.equal(await page.evaluate(() => window.fixture.captures), 0);
            if (name === 'chromium') await page.screenshot({ path: path.join(output, `popup-${theme}.png`) });
            cases++;
        }
        assert.deepEqual(errors, []);
        console.log(`${name} ${browser.version()}: settings/rejected-key, manual descriptions, inbox pending/rejection/retry, Strong/Probable selection; both themes at 1180/390px, 200% CSS zoom. Hidden DOM/CSS; transport/session replies stubbed.`);
        await context.close();
    }
    assert.equal(cases, 12); console.log(`Garmin UI checks passed: ${cases} cases. Images: ${output}`);
} finally {
    const closed = await Promise.allSettled(browsers.reverse().map(browser => browser.close()));
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await certificate.remove();
    assert(closed.every(result => result.status === 'fulfilled'), 'Browser teardown failed');
}
