// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shipped UI, isolated HTTPS fixtures, held responses, no live list mutations.
/* global document, location, requestAnimationFrame, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createBrowserFixtureServer, projectRoot } from './browser-verification-fixtures.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { createResourceStack } from './resource-stack.mjs';
import { darkCss } from '../src/theme/site-dark-css.js';

const asset = name => readFile(path.join(projectRoot, 'dist', name), 'utf8');
const form = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-buddy-form.html'), 'utf8');
const home = await readFile(path.join(projectRoot, 'test/fixtures/pages/climber-home.html'), 'utf8');
const nativeCss = home.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1];
const profile = form.replace('Casey Alpine', 'Damon Up').replaceAll('Casey Alpine', 'Damon Up')
    .replace('<span id="TitleLabel"><h1>Peakbagging Page for Damon Up</h1></span>',
        '<table id="transition-title" width="100%"><tr><td align="center"><span id="TitleLabel"><h1>Peakbagging Page for Damon Up</h1></span></td></tr></table>')
    .replace(/<textarea[\s\S]*?<\/textarea>/, '').replace(/<input id="ContactButton"[^>]*>/, '')
    .replace('</head>', `<style>${nativeCss}${darkCss}main{padding:12px}#transition-content{width:100%;margin-top:8px;min-height:1000px}</style></head>`)
    .replace('</main>', '<table class="gray" id="transition-content"><tr><td><h4>Personal Climb Logs</h4><a id="transition-next" href="/climber/ClimbListC.aspx?cid=900002">Ascent List</a></td></tr></table><a id="transition-person" href="/climber/climber.aspx?cid=900002">Damon Up</a></main>');
const serverBody = buddy => buddy ? profile.replaceAll('AddBuddy', 'RemoveBuddy')
    .replace('Add to your Buddy List', 'Remove from your Buddy List').replace('Add this Climber as a Buddy', 'This Climber is one of your buddies.') : profile;

function install({ theme, textScale = 1 }) {
    const listeners = [], entry = { cid: 900002, name: 'Damon Up', addedAt: 1, source: 'manual' };
    const store = { bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
        bpbIgnoredClimbers: { schemaVersion: 1, revision: 0, entries: [] },
        bpbBuddyCache: { ownerCid: 900001, entries: [], fetchedAt: Date.now() }, bpbBuddyIntents: [] };
    const pending = new Map();
    const publish = values => {
        Object.assign(store, structuredClone(values));
        listeners.forEach(listener => listener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local'));
    };
    globalThis.__climber = { store, requests: [], publish, pending, release: (key, success = true) => {
        const item = pending.get(key); if (!item) throw new Error(`No held ${key}`);
        pending.delete(key);
        if (!success) { item.resolve({ ok: false, error: { message: 'The change could not be saved. Your list is unchanged. Check the connection and try again. '.repeat(3) } }); return; }
        if (key === 'favorite') {
            const value = { schemaVersion: 1, entries: item.message.mutation.kind === 'add' ? [entry] : [] };
            publish({ bpbFavoriteClimbers: value }); item.resolve({ ok: true, favorites: value });
        } else if (key === 'ignore') {
            const list = { schemaVersion: 1, revision: store.bpbIgnoredClimbers.revision + 1,
                entries: item.message.mutation.kind === 'add' ? [entry] : [] };
            publish({ bpbIgnoredClimbers: list }); item.resolve({ ok: true, list });
        } else item.resolve({ ok: true, token: 'fixture-lease', checkOnly: item.message.checkOnly === true });
    } };
    const sendMessage = async message => {
        globalThis.__climber.requests.push(message);
        if (message.type === 'FAVORITES_MUTATE' || message.type === 'IGNORED_MUTATE') {
            const key = message.type === 'FAVORITES_MUTATE' ? 'favorite' : 'ignore';
            return new Promise(resolve => pending.set(key, { resolve, message }));
        }
        if (message.type === 'CLIMBER_BUDDY_ACTION') {
            if (message.phase === 'begin') return new Promise(resolve => pending.set('buddy', { resolve, message }));
            if (message.phase === 'complete') {
                publish({ bpbBuddyCache: { ownerCid: 900001, entries: message.buddy ? [entry] : [], fetchedAt: Date.now() }, bpbBuddyIntents: [] });
                return { ok: true, warning: globalThis.__climber.completeWarning || '' };
            }
            return { ok: true };
        }
        return { ok: true, token: 'fixture-token', grantToken: 'fixture-token' };
    };
    globalThis.chrome = { storage: { local: { get: async () => structuredClone(store), set: async values => publish(values) },
        sync: { get: async () => ({ bpbSettings: { theme, favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: false } }) },
        onChanged: { addListener: fn => listeners.push(fn), removeListener: fn => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } } },
    runtime: { id: 'transition-fixture', onMessage: { addListener() {}, removeListener() {} },
        getURL: file => new URL(`/dist/${file}`, location.origin).href, sendMessage } };
    document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.bpbTheme = theme;
        if (textScale === 2) {
            const style = document.createElement('style');
            style.textContent = '#TitleLabel h1{font-size:40pt !important}.bpb-ignore-actions{font-size:26px !important}#bpb-climber-profile-feedback{font-size:24px !important}#BuddyLabel,#AddBuddy,#RemoveBuddy{font-size:26px !important}';
            document.head.append(style);
        }
    });
}
const regions = ['#transition-title', '#TitleLabel h1', '#bpb-climber-favorite', '#bpb-climber-ignore', '#UpdatePanel1', '#transition-content', '#transition-next'];
async function frame(page, selectors = regions) {
    return page.evaluate(async selectors => {
        await new Promise(requestAnimationFrame);
        const boxes = {};
        for (const selector of selectors) {
            const r = document.querySelector(selector).getBoundingClientRect();
            boxes[selector] = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return { boxes, scroll: globalThis.scrollY };
    }, selectors);
}
function stable(before, after, label) {
    assert.equal(after.scroll, before.scroll, `${label}: document scroll moved`);
    for (const selector of Object.keys(before.boxes)) for (const key of ['x', 'y', 'width', 'height']) {
        const delta = after.boxes[selector][key] - before.boxes[selector][key];
        assert.ok(Math.abs(delta) <= 1, `${label}: ${selector} ${key} shifted ${delta}px`);
    }
}
async function sample(page, before, label, selectors) {
    for (let index = 0; index < 3; index++) stable(before, await frame(page, selectors), `${label} frame ${index}`);
}
async function capture(page, variant, state) {
    if (process.env.BPB_JITTER_ARTIFACTS && variant.textScale !== 2 && variant.width !== 768) {
        await page.screenshot({ path: path.join(process.env.BPB_JITTER_ARTIFACTS, `${variant.name}-${state}.png`) });
    }
}
async function boot(page, origin, variant) {
    await page.addInitScript(install, variant);
    let buddy = false; let posts = 0; let failPost = false; let failRead = false;
    page.__buddyPosts = () => posts;
    page.__failBuddyPost = () => { failPost = true; };
    page.__failBuddyRead = () => { failRead = true; };
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (/climber\.aspx$/i.test(url.pathname)) {
            if (route.request().method() === 'POST') {
                posts++;
                if (failPost) { failPost = false; return route.fulfill({ status: 503, body: 'Service unavailable' }); }
                buddy = new URLSearchParams(route.request().postData()).has('AddBuddy');
            }
            const body = variant.legacy ? serverBody(false).replaceAll('AddBuddy', 'BuddyButton').replace('type="submit" value="Add to your Buddy List"', 'type="button" value="Add to My Buddy List"') : serverBody(buddy);
            return route.fulfill({ contentType: 'text/html', body });
        }
        if (/report\.aspx$/i.test(url.pathname)) return route.fulfill(failRead ? { status: 429, body: 'Too many requests' }
            : { contentType: 'text/html', body: '<a href="/climber/climber.aspx?cid=900001">My Home Page</a><table id="RGridView"><tr><th>Climber</th></tr></table>' });
        return route.abort();
    });
    await page.goto(`${origin}/climber/climber.aspx?cid=900002`);
    assert.equal(await page.locator('#transition-content').count(), 1);
    await page.addScriptTag({ content: await asset('content/climber-favorite.js') });
    await page.waitForFunction(() => document.getElementById('bpb-climber-favorite')?.disabled === false && document.getElementById('bpb-climber-ignore')?.disabled === false);
}
export async function verifyBuddyPresentation(page, origin, variant) {
    await boot(page, origin, variant);
    const selectors = [...regions, '#AddBuddy, #RemoveBuddy', '#BuddyLabel'];
    const before = await frame(page, selectors);
    assert.equal(await page.locator('#AddBuddy').evaluate(element => getComputedStyle(element).color.replace(/\s/g, '')), 'rgba(0,0,0,0)',
        'only one visible caption; the dark repaint must not reveal underlying input text');
    assert.equal(await page.getByRole('button', { name: 'Add to your Buddy List', exact: true }).count(), 1, 'real native accessible name retained');
    if (variant.width >= 768) assert.ok(before.boxes['#AddBuddy, #RemoveBuddy'].width < variant.width / 2,
        'stable does not mean an unnecessarily stretched native action');
    for (const action of ['add', 'remove']) {
        const control = page.locator('#AddBuddy, #RemoveBuddy');
        await control.focus(); await page.keyboard.press(action === 'add' ? 'Enter' : 'Space');
        await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
        await sample(page, before, `buddy ${action} pending`, selectors);
        await page.evaluate(() => globalThis.__climber.release('buddy'));
        await page.waitForFunction(() => document.querySelector('#AddBuddy, #RemoveBuddy').disabled === false);
        await sample(page, before, `buddy ${action} completion`, selectors);
    }
    assert.equal(page.__buddyPosts(), 2);
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy', false));
    await page.waitForFunction(() => document.getElementById('AddBuddy').disabled === false);
    await sample(page, before, 'buddy failure', selectors);
    const check = page.locator('#bpb-climber-profile-retry');
    await check.filter({ hasText: 'Check status' }).waitFor();
    await check.click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    assert.equal(await page.evaluate(() => globalThis.__climber.pending.get('buddy').message.checkOnly), true);
    await sample(page, before, 'buddy check-only pending', selectors);
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(() => document.getElementById('AddBuddy').disabled === false);
    await sample(page, before, 'buddy check-only completion', selectors);
    assert.equal(page.__buddyPosts(), 2, 'recovery never repeats a POST');
    page.__failBuddyPost();
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(() => document.getElementById('AddBuddy').disabled === false);
    await check.waitFor({ state: 'visible' });
    await sample(page, before, 'buddy uncertain POST', selectors);
    await check.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(() => document.getElementById('AddBuddy').disabled === false);
    assert.equal(page.__buddyPosts(), 3, 'uncertain recovery does not replay the failed POST');
    await sample(page, before, 'buddy uncertainty reconciled', selectors);
    await page.evaluate(() => { globalThis.__climber.completeWarning = 'Buddy saved but the favorite could not be saved. Check the local list before trying again. '.repeat(3); });
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(() => document.getElementById('RemoveBuddy')?.disabled === false);
    await sample(page, before, 'buddy confirmed with warning', selectors);
    await capture(page, variant, 'buddy-warning');
    await capture(page, variant, 'buddy');
    const legacy = await page.context().newPage();
    try {
        await boot(legacy, origin, { ...variant, legacy: true });
        const legacyRegions = [...regions, '#BuddyButton', '#BuddyLabel'];
        const idle = await frame(legacy, legacyRegions);
        await legacy.locator('#BuddyButton').click();
        await legacy.waitForFunction(() => document.getElementById('BuddyButton').dataset.bpbBuddyPending === 'true');
        await sample(legacy, idle, 'legacy buddy pending', legacyRegions);
        legacy.__failBuddyRead();
        await legacy.evaluate(() => {
            document.getElementById('BuddyButton').value = 'Remove from My Buddy List';
            document.getElementById('BuddyLabel').textContent = 'This Climber is one of your buddies.';
        });
        await legacy.waitForFunction(() => !document.getElementById('BuddyButton').hasAttribute('data-bpb-buddy-pending'));
        await legacy.locator('#bpb-climber-membership-note').filter({ hasText: 'Unavailable.' }).waitFor();
        await sample(legacy, idle, 'legacy buddy membership change', legacyRegions);
        assert.equal(legacy.__buddyPosts(), 0);
    } finally { await legacy.close(); }
}
export async function verifyProfileFeedback(page, origin, variant) {
    await boot(page, origin, variant);
    const before = await frame(page);
    for (const key of ['favorite', 'ignore']) {
        const selector = `#bpb-climber-${key}`;
        for (const success of [false, true, true]) {
            await page.locator(selector).focus();
            await page.keyboard.press(success ? 'Space' : 'Enter');
            await page.waitForFunction(key => globalThis.__climber.pending.has(key), key);
            await sample(page, before, `${key} pending`);
            await page.evaluate(({ key, success }) => globalThis.__climber.release(key, success), { key, success });
            await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-busy') === 'false', selector);
            await sample(page, before, `${key} ${success ? 'success' : 'error'}`);
            if (!success) {
                await page.locator('#bpb-climber-profile-feedback').filter({ hasText: 'not saved' }).waitFor();
                const retry = page.locator('#bpb-climber-profile-retry');
                assert.equal(await retry.isVisible(), true, 'visible recovery, not tooltip-only');
                await page.evaluate(key => {
                    const entry = { cid: 900002, name: 'Damon Up', addedAt: 1, source: 'manual' };
                    globalThis.__climber.publish(key === 'favorite' ? { bpbIgnoredClimbers: { schemaVersion: 1, revision: 1, entries: [entry] } }
                        : { bpbFavoriteClimbers: { schemaVersion: 1, entries: [entry] } });
                }, key);
                await page.waitForFunction(() => document.getElementById('bpb-climber-profile-retry').disabled === true);
                await sample(page, before, `${key} stale recovery blocked`);
                await page.evaluate(key => globalThis.__climber.publish(key === 'favorite'
                    ? { bpbIgnoredClimbers: { schemaVersion: 1, revision: 2, entries: [] } }
                    : { bpbFavoriteClimbers: { schemaVersion: 1, entries: [] } }), key);
                await page.waitForFunction(() => document.getElementById('bpb-climber-profile-retry').disabled === false);
                await capture(page, variant, `${key}-error`);
                const details = page.locator('#bpb-climber-profile-feedback details');
                assert.equal(await details.evaluate(element => element.open), false, 'long errors never auto-expand');
                assert.ok((await details.locator('p').textContent()).length > 250, 'complete error retained');
                await details.locator('summary').click();
                assert.equal(await details.locator('p').isVisible(), true, 'full failure is explicitly readable');
                await details.locator('summary').click();
                await sample(page, before, `${key} detail collapsed`);
                await retry.click();
                await page.waitForFunction(key => globalThis.__climber.pending.has(key), key);
                await sample(page, before, `${key} recovery pending`);
                assert.equal(await retry.isDisabled(), true, 'pending Retry is unavailable');
                await page.evaluate(key => globalThis.__climber.release(key, false), key);
                await page.waitForFunction(() => document.getElementById('bpb-climber-profile-retry')?.disabled === false);
                await sample(page, before, `${key} repeated error`);
            }
        }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow');
    await capture(page, variant, 'profile');
}
export async function verifyPendingMembership(page, origin, variant) {
    await boot(page, origin, variant);
    const before = await frame(page);
    await page.evaluate(() => globalThis.__climber.publish({ bpbBuddyIntents: [{ cid: 900002, ownerCid: 900001, name: 'Damon Up', action: 'add',
        token: 'other-tab', tabId: 7, status: 'prepared', checkOnly: false, leaseUntil: Date.now() + 30000 }] }));
    await page.locator('#bpb-climber-membership-note').filter({ hasText: 'in progress' }).waitFor();
    assert.equal(await page.locator('#bpb-climber-ignore').isDisabled(), true);
    assert.equal(await page.locator('#AddBuddy').getAttribute('aria-disabled'), 'true');
    await sample(page, before, 'other-tab active lease');
    for (const status of ['dispatched', 'confirmed']) {
        await page.evaluate(status => globalThis.__climber.publish({ bpbBuddyIntents: globalThis.__climber.store.bpbBuddyIntents.map(entry => ({ ...entry, status })) }), status);
        await page.waitForFunction(() => document.getElementById('AddBuddy').getAttribute('aria-disabled') === 'true');
        await sample(page, before, `other-tab ${status} live lease`);
    }
    await page.evaluate(() => globalThis.__climber.publish({ bpbBuddyIntents: globalThis.__climber.store.bpbBuddyIntents.map(entry => ({ ...entry, status: 'dispatched', leaseUntil: 0 })) }));
    await page.locator('#bpb-climber-membership-note').filter({ hasText: 'Check buddy status.' }).waitFor();
    assert.equal(await page.locator('#bpb-climber-ignore').isDisabled(), true, 'expiry is not confirmed absence');
    await sample(page, before, 'other-tab unresolved');
    const check = page.locator('#bpb-climber-profile-retry');
    await check.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    assert.equal(await page.evaluate(() => globalThis.__climber.pending.get('buddy').message.checkOnly), true);
    await sample(page, before, 'other-tab status check pending');
    await page.evaluate(() => globalThis.__climber.release('buddy', false));
    await page.waitForFunction(() => document.getElementById('AddBuddy').disabled === false);
    await sample(page, before, 'other-tab failed confirmation');
    assert.equal(await page.locator('#bpb-climber-ignore').isDisabled(), true);
    await check.click(); await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(() => document.getElementById('bpb-climber-ignore').disabled === false);
    await sample(page, before, 'other-tab confirmation complete');
    assert.equal(page.__buddyPosts(), 0);
    await page.evaluate(() => globalThis.__climber.publish({ bpbBuddyIntents: [{ cid: 900002, ownerCid: 900003, name: 'Damon Up', action: 'add',
        token: 'wrong-owner', tabId: 7, status: 'dispatched', checkOnly: false, leaseUntil: 0 }] }));
    await page.locator('#bpb-climber-membership-note').filter({ hasText: 'original account' }).waitFor();
    assert.equal(await check.isVisible(), false);
    assert.equal(await page.locator('#bpb-climber-ignore').isDisabled(), true);
    assert.equal(await page.locator('#AddBuddy').getAttribute('aria-disabled'), 'true');
    await sample(page, before, 'other-account protection');
    await capture(page, variant, 'pending-membership');
    await page.addStyleTag({ content: await asset('css/climber-hover-card.css') });
    await page.addStyleTag({ content: '#transition-person{position:fixed;left:30px;top:250px}' });
    await page.addScriptTag({ content: await asset('content/climber-hover-card.js') });
    await page.locator('#transition-person + .bpb-climber-actions-trigger').click();
    const cardBuddy = page.locator('#bpb-climber-card-buddy');
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-buddy')?.disabled === true);
    await page.evaluate(() => globalThis.__climber.publish({ bpbBuddyIntents: [{ cid: 900002, ownerCid: 900001, name: 'Damon Up', action: 'add',
        token: 'card-other-tab', tabId: 7, status: 'prepared', checkOnly: false, leaseUntil: Date.now() + 30000 }] }));
    await cardBuddy.filter({ hasText: 'Saving…' }).waitFor();
    assert.equal(await cardBuddy.isDisabled(), true);
    await page.evaluate(() => globalThis.__climber.publish({ bpbBuddyIntents: globalThis.__climber.store.bpbBuddyIntents.map(entry => ({ ...entry, status: 'dispatched', leaseUntil: 0 })) }));
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-buddy').disabled === false);
    await cardBuddy.filter({ hasText: 'Check buddy status' }).waitFor();
    assert.equal(await page.locator('#bpb-climber-card-ignore').isDisabled(), true);
    await cardBuddy.click(); await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    assert.equal(await page.evaluate(() => globalThis.__climber.pending.get('buddy').message.checkOnly), true);
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-ignore').disabled === false);
    assert.equal(page.__buddyPosts(), 0, 'both surfaces reconcile without a POST');
}

async function run() {
    const resources = createResourceStack(); let failure;
    try {
        const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-climber-transitions-'));
        resources.defer('fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
        const fixture = await createBrowserFixtureServer({ temporaryRoot });
        resources.defer('HTTPS server', () => fixture.close());
        if (process.env.BPB_JITTER_ARTIFACTS) await mkdir(process.env.BPB_JITTER_ARTIFACTS, { recursive: true });
        const origin = `https://www.peakbagger.com:${fixture.port}`;
        for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
            if (engine === chromium) assertChromeLaunchAllowed();
            const browser = await engine.launch({ headless: true, ...(engine === chromium
                ? { channel: 'chromium', args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
                : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }) });
            try {
                for (const theme of ['light', 'dark']) for (const width of [390, 768, 1280]) for (const textScale of [1, 2]) {
                    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, colorScheme: theme });
                    try {
                        const page = await context.newPage(); page.setDefaultTimeout(10000);
                        const variant = { theme, width, textScale, name: `${name}-${theme}-${width}-${textScale}` };
                        const checks = process.argv.find(value => value.startsWith('--checks='))?.split('=')[1] || 'profile';
                        if (checks === 'profile' || checks === 'all') await verifyProfileFeedback(page, origin, variant);
                        if (checks === 'buddy' || checks === 'all') {
                            const buddyPage = await context.newPage(); buddyPage.setDefaultTimeout(10000);
                            await verifyBuddyPresentation(buddyPage, origin, variant);
                        }
                        if (checks === 'pending' || checks === 'all') {
                            const pendingPage = await context.newPage(); pendingPage.setDefaultTimeout(10000);
                            await verifyPendingMembership(pendingPage, origin, variant);
                        }
                        console.log(JSON.stringify({ ...variant, version: browser.version(), hidden: true, result: 'passed' }));
                    } finally { await context.close(); }
                }
            } finally { await browser.close(); }
        }
    } catch (error) { failure = error; }
    await resources.dispose(failure);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
