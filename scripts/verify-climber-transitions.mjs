// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shipped UI, isolated HTTPS fixtures, held responses, no live list mutations.
/* global document, location, requestAnimationFrame, innerWidth, innerHeight, getComputedStyle */
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
import { auditedClimberAssets } from './climber-regression-baseline.mjs';

let historicalAssets = null;
const asset = name => historicalAssets?.has(name) ? historicalAssets.get(name) : readFile(path.join(projectRoot, 'dist', name), 'utf8');
export function climberCheckOptions(args) {
    const checks = args.find(value => value.startsWith('--checks='))?.slice('--checks='.length) || 'all';
    const onlyVariant = args.find(value => value.startsWith('--variant='))?.slice('--variant='.length);
    assert.ok(['all', 'profile', 'buddy', 'pending', 'card', 'card-retry', 'card-links', 'baseline', 'regressions'].includes(checks), `Unknown climber checks: ${checks}`);
    for (const argument of args) assert.match(argument, /^--(?:checks|variant)=.+$/, `Unknown argument: ${argument}`);
    if (onlyVariant) assert.match(onlyVariant, /^(chrome|firefox)-(light|dark)-(390|768|1280)-(1|2)$/, 'Unknown climber variant');
    assert.ok(!onlyVariant || !['baseline', 'regressions'].includes(checks), 'Regression contracts use their own explicit viewports');
    return { checks, onlyVariant };
}
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
    const reads = [];
    const read = (value, key) => globalThis.__climber?.holdReads ? new Promise((resolve, reject) => reads.push({ resolve, reject, value, key })) : Promise.resolve(value);
    const publish = values => {
        Object.assign(store, structuredClone(values));
        listeners.forEach(listener => listener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local'));
    };
    globalThis.__climber = { store, requests: [], publish, pending, releaseReads: failed => {
        globalThis.__climber.holdReads = false;
        for (const item of reads.splice(0)) { if (item.key === failed) item.reject(new Error('Read unavailable')); else item.resolve(item.value); }
    }, release: (key, success = true) => {
        const item = pending.get(key); if (!item) throw new Error(`No held ${key}`);
        pending.delete(key);
        if (!success) {
            if (key === 'buddy') publish({ bpbBuddyIntents: item.beforeIntents });
            item.resolve({ ok: false, error: { message: 'The change could not be saved. Your list is unchanged. Check the connection and try again. '.repeat(3) } }); return;
        }
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
        if (message.type === 'BUDDY_CACHE_UPDATE') {
            if (message.phase === 'begin') return { ok: true, snapshot: { version: null, observedAt: null } };
            publish({ bpbBuddyCache: message.cache });
            return { ok: true, written: true };
        }
        if (message.type === 'FAVORITES_MUTATE' || message.type === 'IGNORED_MUTATE') {
            const key = message.type === 'FAVORITES_MUTATE' ? 'favorite' : 'ignore';
            return new Promise(resolve => pending.set(key, { resolve, message }));
        }
        if (message.type === 'CLIMBER_BUDDY_ACTION') {
            if (message.phase === 'begin') {
                const beforeIntents = structuredClone(store.bpbBuddyIntents), previous = beforeIntents.find(entry => entry.cid === 900002);
                publish({ bpbBuddyIntents: [{ cid: 900002, ownerCid: 900001, name: 'Damon Up', action: previous?.action || message.action,
                    token: 'fixture-lease', tabId: 1, status: previous?.status || 'prepared',
                    checkOnly: !!message.checkOnly, leaseUntil: Date.now() + 60000 }] });
                return new Promise(resolve => pending.set('buddy', { resolve, message, beforeIntents }));
            }
            if (message.phase === 'failed') publish({ bpbBuddyIntents: store.bpbBuddyIntents.map(entry => ({ ...entry, status: 'dispatched', leaseUntil: 0 })) });
            if (message.phase === 'complete') {
                publish({ bpbBuddyCache: { ownerCid: 900001, entries: message.buddy ? [entry] : [], fetchedAt: Date.now() }, bpbBuddyIntents: [] });
                return { ok: true, warning: globalThis.__climber.completeWarning || '' };
            }
            return { ok: true };
        }
        return { ok: true, token: 'fixture-token', grantToken: 'fixture-token' };
    };
    globalThis.chrome = { storage: { local: { get: () => read(structuredClone(store), 'local'), set: async values => publish(values) },
        sync: { get: () => read({ bpbSettings: { theme, favoritesSource: 'custom', removeFavoriteWhenBuddyRemoved: false } }, 'settings') },
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
        const card = document.getElementById('bpb-climber-card'), main = document.querySelector('.bpb-climber-card-main');
        return { boxes, scroll: globalThis.scrollY, cardScroll: card?.scrollTop, mainScroll: main?.scrollTop,
            mainClient: main?.clientHeight, mainHeight: main?.scrollHeight, focus: document.activeElement.id };
    }, selectors);
}
function stable(before, after, label) {
    assert.equal(after.scroll, before.scroll, `${label}: document scroll moved`);
    for (const selector of Object.keys(before.boxes)) for (const key of ['x', 'y', 'width', 'height']) {
        const delta = after.boxes[selector][key] - before.boxes[selector][key];
        assert.ok(Math.abs(delta) <= 1, `${label}: ${selector} ${key} shifted ${delta}px; ${JSON.stringify({ before, after })}`);
    }
}
async function sample(page, before, label, selectors) {
    for (let index = 0; index < 3; index++) stable(before, await frame(page, selectors), `${label} frame ${index}`);
}
const nativeReady = () => {
    const control = document.querySelector('#AddBuddy, #RemoveBuddy');
    return !!control && !control.disabled && control.dataset.bpbBuddyPending !== 'true' && control.getAttribute('aria-disabled') !== 'true';
};
async function capture(page, variant, state) {
    if (process.env.BPB_JITTER_ARTIFACTS && variant.width !== 768) {
        await page.screenshot({ path: path.join(process.env.BPB_JITTER_ARTIFACTS, `${variant.name}-${state}.png`) });
    }
}
async function visibleProfileFeedback(page) {
    assert.equal(await page.locator('#bpb-climber-profile-feedback').evaluate(region => {
        const r = region.getBoundingClientRect(), note = region.querySelector('#bpb-climber-membership-note').getBoundingClientRect();
        return !region.hidden && getComputedStyle(region).position === 'fixed' && r.top >= 0 && r.left >= 0
            && r.bottom <= innerHeight && r.right <= innerWidth && note.top >= r.top && note.bottom <= r.bottom;
    }), true, 'profile feedback and its message are visible inside the viewport');
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
        assert.equal(await page.evaluate(() => document.activeElement.id), action === 'add' ? 'AddBuddy' : 'RemoveBuddy', 'pending native action retains focus');
        await sample(page, before, `buddy ${action} pending`, selectors);
        await page.evaluate(() => globalThis.__climber.release('buddy'));
        await page.waitForFunction(nativeReady);
        await sample(page, before, `buddy ${action} completion`, selectors);
    }
    assert.equal(page.__buddyPosts(), 2);
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy', false));
    await page.waitForFunction(nativeReady);
    await sample(page, before, 'buddy failure', selectors);
    const check = page.locator('#bpb-climber-profile-retry');
    await check.filter({ hasText: 'Check status' }).waitFor();
    await check.click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    assert.equal(await page.evaluate(() => globalThis.__climber.pending.get('buddy').message.checkOnly), true);
    await sample(page, before, 'buddy check-only pending', selectors);
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(nativeReady);
    await sample(page, before, 'buddy check-only completion', selectors);
    assert.equal(page.__buddyPosts(), 2, 'recovery never repeats a POST');
    page.__failBuddyPost();
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(nativeReady);
    await check.waitFor({ state: 'visible' });
    await sample(page, before, 'buddy uncertain POST', selectors);
    await check.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(nativeReady);
    assert.equal(page.__buddyPosts(), 3, 'uncertain recovery does not replay the failed POST');
    await sample(page, before, 'buddy uncertainty reconciled', selectors);
    await page.evaluate(() => { globalThis.__climber.completeWarning = 'Buddy saved but the favorite could not be saved. Check the local list before trying again. '.repeat(3); });
    await page.locator('#AddBuddy').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
    await page.evaluate(() => globalThis.__climber.release('buddy'));
    await page.waitForFunction(nativeReady);
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
    await capture(page, variant, 'idle');
    assert.equal(await page.locator('#bpb-climber-profile-feedback').isVisible(), false, 'idle profiles have no empty feedback panel');
    const header = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const ignore = rect('#bpb-climber-ignore'), favorite = rect('#bpb-climber-favorite');
        const label = document.querySelector('#bpb-climber-ignore > span:not([data-sizing-text])');
        const range = document.createRange(); range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const host = rect('#TitleLabel'), title = rect('#TitleLabel h1'), table = rect('#transition-title');
        return { labelOffset: text.y + text.height / 2 - (ignore.y + ignore.height / 2),
            controlOffset: favorite.y + favorite.height / 2 - (ignore.y + ignore.height / 2),
            sameRow: Math.abs(favorite.y - ignore.y) < Math.max(favorite.height, ignore.height),
            titleOffset: title.y + title.height / 2 - (ignore.y + ignore.height / 2),
            titleSameRow: Math.abs(title.y - ignore.y) < Math.max(title.height, ignore.height),
            emptySpace: table.height - host.height, gap: rect('#UpdatePanel1').top - host.bottom };
    });
    const defects = [];
    if (Math.abs(header.labelOffset) > 1) defects.push(`Ignore text is vertically off center by ${header.labelOffset}px`);
    if (header.sameRow && Math.abs(header.controlOffset) > 1) defects.push(`profile controls are vertically misaligned by ${header.controlOffset}px`);
    if (header.titleSameRow && Math.abs(header.titleOffset) > 1) defects.push(`title and controls are vertically misaligned by ${header.titleOffset}px`);
    if (header.emptySpace > 8) defects.push(`profile header reserves ${header.emptySpace}px of empty space`);
    if (header.gap > 12) defects.push(`Buddy row is separated from the header by ${header.gap}px`);
    assert.deepEqual(defects, [], `profile header layout: ${JSON.stringify(header)}`);
    for (const key of ['favorite', 'ignore']) {
        const selector = `#bpb-climber-${key}`;
        for (const success of [false, true, true]) {
            await page.locator(selector).focus();
            await page.keyboard.press(success ? 'Space' : 'Enter');
            await page.waitForFunction(key => globalThis.__climber.pending.has(key), key);
            assert.equal(await page.evaluate(() => document.activeElement.id), `bpb-climber-${key}`, 'pending profile action retains focus');
            await sample(page, before, `${key} pending`);
            await visibleProfileFeedback(page);
            await capture(page, variant, `${key}-pending`);
            if (!success) {
                await page.getByRole('button', { name: 'Dismiss message' }).focus();
                await page.keyboard.press('Enter');
                assert.equal(await page.locator('#bpb-climber-profile-feedback').isVisible(), false);
                assert.equal(await page.evaluate(() => document.activeElement.id), `bpb-climber-${key}`, 'dismissal returns focus to the current profile action');
                await page.evaluate(() => globalThis.__climber.publish({ bpbBuddyCache: globalThis.__climber.store.bpbBuddyCache }));
                await sample(page, before, `${key} dismissed pending feedback`);
                assert.equal(await page.locator('#bpb-climber-profile-feedback').isVisible(), false, 'an identical storage repaint does not undo dismissal');
                assert.equal(await page.evaluate(key => globalThis.__climber.pending.has(key), key), true, 'dismissal does not cancel the save');
            }
            await page.evaluate(({ key, success }) => globalThis.__climber.release(key, success), { key, success });
            await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-busy') === 'false', selector);
            await sample(page, before, `${key} ${success ? 'success' : 'error'}`);
            if (!success) {
                await page.locator('#bpb-climber-profile-feedback').filter({ hasText: 'not saved' }).waitFor();
                await visibleProfileFeedback(page);
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
                assert.equal(await details.locator('p').evaluate(element => getComputedStyle(element).fontSize),
                    await page.locator('#bpb-climber-membership-note').evaluate(element => getComputedStyle(element).fontSize),
                    'full error details respect enlarged feedback text');
                await sample(page, before, `${key} details expanded`);
                await capture(page, variant, `${key}-details`);
                await details.locator('summary').click();
                await sample(page, before, `${key} detail collapsed`);
                const retryBefore = await frame(page, ['#bpb-climber-profile-retry']);
                await retry.click();
                await page.waitForFunction(key => globalThis.__climber.pending.has(key), key);
                await sample(page, before, `${key} recovery pending`);
                await sample(page, retryBefore, `${key} recovery button pending`, ['#bpb-climber-profile-retry']);
                assert.equal(await retry.isDisabled(), true, 'pending Retry is unavailable');
                await page.evaluate(key => globalThis.__climber.release(key, false), key);
                await page.waitForFunction(() => document.getElementById('bpb-climber-profile-retry')?.getAttribute('aria-disabled') === 'false');
                await sample(page, before, `${key} repeated error`);
                await sample(page, retryBefore, `${key} recovery button repeated error`, ['#bpb-climber-profile-retry']);
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
    await page.waitForFunction(nativeReady);
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
export async function verifyCardFeedback(page, origin, variant, retryOnly = false, anchorTop = 720) {
    await boot(page, origin, variant);
    await page.addStyleTag({ content: await asset('css/climber-hover-card.css') });
    await page.addStyleTag({ content: `.bpb-climber-link:has(#transition-person){position:fixed;left:30px;top:${anchorTop}px}` + (variant.textScale === 2
        ? '#bpb-climber-card{font-size:28px}#bpb-climber-card .bpb-climber-card-name{font-size:34px}#bpb-climber-card :is(.bpb-climber-card-detail,.bpb-climber-card-feedback){font-size:24px}' : '') });
    await page.addScriptTag({ content: await asset('content/climber-hover-card.js') });
    await page.locator('#transition-person + .bpb-climber-actions-trigger').click();
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-favorite')?.disabled === false);
    await page.waitForFunction(() => document.getElementById('bpb-climber-card').getAnimations().every(animation => animation.playState === 'finished'));
    await page.locator('#bpb-climber-card-favorite').scrollIntoViewIfNeeded();
    const selectors = ['#bpb-climber-card', '.bpb-climber-card-heading', '.bpb-climber-card-links',
        '#bpb-climber-card-buddy', '#bpb-climber-card-favorite', '#bpb-climber-card-ignore',
        '#transition-title', '#transition-content', '#transition-next'];
    if (await page.locator('.bpb-climber-card-favorite-slot').count()) selectors.push('.bpb-climber-card-favorite-slot');
    const before = await frame(page, selectors);
    if (anchorTop === 20 || anchorTop === 820) {
        await page.locator('#bpb-climber-card-favorite').focus();
        await page.keyboard.press(anchorTop === 20 ? 'Enter' : 'Space');
    } else await page.locator('#bpb-climber-card-favorite').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('favorite'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'bpb-climber-card-favorite', 'pending card action retains keyboard focus');
    const writes = await page.evaluate(() => globalThis.__climber.requests.filter(message => message.type === 'FAVORITES_MUTATE').length);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => globalThis.__climber.requests.filter(message => message.type === 'FAVORITES_MUTATE').length), writes, 'repeat keys cannot queue another write');
    await page.evaluate(() => globalThis.__climber.release('favorite', false));
    const retry = page.locator('.bpb-climber-card-retry');
    await retry.waitFor({ state: 'visible' });
    const recoveryBefore = await frame(page, ['.bpb-climber-card-retry']);
    if (!retryOnly) {
        const visible = await page.locator('.bpb-climber-card-feedback').evaluate(element => {
            const r = element.getBoundingClientRect(), c = document.getElementById('bpb-climber-card').getBoundingClientRect();
            return r.top >= c.top && r.bottom <= c.bottom && r.top >= 0 && r.bottom <= innerHeight;
        });
        assert.equal(visible, true, 'the error/recovery region must be visible without scrolling to discover it');
        await sample(page, before, 'card visible error', selectors);
        await capture(page, variant, `card-error-${anchorTop}`);
        const details = page.locator('.bpb-climber-card-feedback-details');
        assert.ok((await details.locator('p').textContent()).length > 250);
        assert.equal(await details.evaluate(element => element.open), false);
        await details.locator('summary').click();
        await page.waitForFunction(() => {
            const p = document.querySelector('.bpb-climber-card-feedback-details p'), r = p.getBoundingClientRect();
            const c = document.getElementById('bpb-climber-card').getBoundingClientRect();
            return r.top >= c.top && r.bottom <= c.bottom && r.height >= parseFloat(getComputedStyle(p).lineHeight) + 16;
        });
        await capture(page, variant, `card-details-${anchorTop}`);
        await details.locator('summary').click();
        await sample(page, before, 'card details closed', selectors);
        await page.evaluate(() => { globalThis.__climber.holdReads = true; });
        await retry.click();
        await page.waitForFunction(() => document.getElementById('bpb-climber-card').getAttribute('aria-busy') === 'true');
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('bpb-climber-card-retry')), true, 'pending read check retains focus');
        assert.equal(await retry.isDisabled(), true);
        await sample(page, before, 'card read-only pending', selectors);
        await sample(page, recoveryBefore, 'card anchored recovery control', ['.bpb-climber-card-retry']);
        await page.evaluate(() => globalThis.__climber.releaseReads('settings'));
        await page.waitForFunction(() => document.getElementById('bpb-climber-card').getAttribute('aria-busy') === 'false');
        const readingRegions = selectors.filter(selector => selector !== '#bpb-climber-card-favorite');
        const readingBefore = { ...before, boxes: Object.fromEntries(Object.entries(before.boxes).filter(([selector]) => readingRegions.includes(selector))) };
        await sample(page, readingBefore, 'card settings failure with preserved slot', readingRegions);
        assert.equal(await page.locator('#bpb-climber-card-favorite').isVisible(), false, 'unknown source stays fail closed');
        await retry.click();
        await page.waitForFunction(() => document.getElementById('bpb-climber-card-favorite').disabled === false
            && document.getElementById('bpb-climber-card').getAttribute('aria-busy') === 'false');
        await sample(page, before, 'card settings recovery', selectors);
        await page.locator('#bpb-climber-card-favorite').click();
        await page.waitForFunction(() => globalThis.__climber.pending.has('favorite'));
        await page.evaluate(() => globalThis.__climber.release('favorite', false));
        await retry.waitFor({ state: 'visible' });
    }
    await page.locator('#bpb-climber-card-favorite').click();
    await page.waitForFunction(() => globalThis.__climber.pending.has('favorite'));
    assert.equal(await retry.isDisabled(), true, 'Retry must not advertise a click that the handler refuses');
    await sample(page, recoveryBefore, 'card disabled recovery target', ['.bpb-climber-card-retry']);
    await sample(page, before, 'card pending recovery', selectors);
    await page.evaluate(() => globalThis.__climber.release('favorite'));
    await page.waitForFunction(() => document.getElementById('bpb-climber-card').getAttribute('aria-busy') === 'false');
    await sample(page, before, 'card completion', selectors);
    await capture(page, variant, 'card');
    if (!retryOnly) {
        await page.evaluate(() => globalThis.__climber.publish({ bpbFavoriteClimbers: { schemaVersion: 1, entries: [] },
            bpbIgnoredClimbers: { schemaVersion: 1, revision: 3, entries: [{ cid: 900002, name: 'Damon Up', addedAt: 1 }] } }));
        await page.waitForFunction(() => document.getElementById('bpb-climber-card-ignore').textContent === 'Unignore climber');
        const scroll = await page.evaluate(() => globalThis.scrollY);
        await page.keyboard.press('Escape');
        await page.locator('#transition-person + .bpb-climber-actions-trigger').click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'bpb-climber-card-ignore');
        assert.equal(await page.evaluate(() => globalThis.scrollY), scroll, 'explicit focus reveals only the local body');
        assert.equal(await page.locator('#bpb-climber-card-ignore').evaluate(element => {
            const r = element.getBoundingClientRect(), b = element.closest('.bpb-climber-card-main').getBoundingClientRect();
            return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
        }), true, 'the chosen enabled keyboard action must actually be visible');
        // Wheel is an independent user gesture. Do not restore its scroll
        // while the compositor may still be processing that gesture, then
        // misreport its remaining motion as a save/recovery layout shift.
        const main = page.locator('.bpb-climber-card-main');
        if (await main.evaluate(element => element.scrollHeight > element.clientHeight + 2)) {
            await main.evaluate(element => { element.scrollTop = element.scrollHeight; });
            const box = await main.boundingBox(), scroll = await page.evaluate(() => globalThis.scrollY);
            await page.evaluate(() => { globalThis.__wheelDone = new Promise(resolve => globalThis.addEventListener('wheel', () =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true, passive: true })); });
            const hit = await page.evaluate(({ x, y }) => ({ target: document.elementFromPoint(x, y)?.outerHTML.slice(0, 180),
                overflow: getComputedStyle(document.querySelector('.bpb-climber-card-main')).overscrollBehaviorY,
                open: document.getElementById('bpb-climber-card').matches(':popover-open') }), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 600); await page.evaluate(() => globalThis.__wheelDone);
            assert.equal(await page.evaluate(() => globalThis.scrollY), scroll, `body boundary scrolling must not jump the page; ${JSON.stringify(hit)}`);
        }
    }
}

export async function verifyCompactCard(page, origin, variant) {
    await boot(page, origin, variant);
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.addStyleTag({ content: await asset('css/climber-hover-card.css') });
    await page.addStyleTag({ content: '.bpb-climber-link:has(#transition-person){position:fixed;left:30px;top:720px}' + (variant.textScale === 2
        ? '#bpb-climber-card{font-size:28px}#bpb-climber-card .bpb-climber-card-name{font-size:34px}#bpb-climber-card :is(.bpb-climber-card-detail,.bpb-climber-card-feedback){font-size:24px}' : '') });
    await page.addScriptTag({ content: await asset('content/climber-hover-card.js') });
    await page.locator('#transition-person + .bpb-climber-actions-trigger').click();
    await page.waitForFunction(() => document.getElementById('bpb-climber-card-favorite')?.disabled === false
        && document.getElementById('bpb-climber-card').getAnimations().every(animation => animation.playState === 'finished'));
    const emptyTail = await page.evaluate(() => document.getElementById('bpb-climber-card').getBoundingClientRect().bottom
        - document.getElementById('bpb-climber-card-ignore').getBoundingClientRect().bottom);
    if (variant.textScale === 1) assert.ok(emptyTail <= 84,
        `idle card leaves ${emptyTail}px below Ignore; compact help and recovery must share space`);
    const links = page.locator('.bpb-climber-card-links a');
    assert.equal(await links.count(), 4);
    assert.equal(await links.nth(2).textContent(), 'Buddy list ↗');
    const ascents = new URL(await links.nth(1).getAttribute('href'));
    assert.equal(ascents.pathname, '/climber/ClimbListC.aspx');
    assert.deepEqual(Object.fromEntries(ascents.searchParams), { cid: '900002', sort: 'ascentdated', j: '-1', y: '9999' });
    assert.equal(new URL(await links.nth(2).getAttribute('href')).searchParams.get('r'), 'b');
    assert.equal(new URL(await links.nth(3).getAttribute('href')).searchParams.get('r'), 'rb');
    const inside = () => {
        const card = document.getElementById('bpb-climber-card'), c = card.getBoundingClientRect();
        return card.scrollWidth <= card.clientWidth + 1 && c.left >= 0 && c.right <= innerWidth
            && [...card.querySelectorAll('.bpb-climber-card-links a')].filter(link => !link.hidden).every(link => {
                const r = link.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom;
            });
    };
    assert.equal(await page.evaluate(inside), true, 'profile links must remain readable within the card');
    await capture(page, variant, 'compact-idle');
    if (process.env.BPB_JITTER_ARTIFACTS && variant.width !== 768) await page.locator('#bpb-climber-card').screenshot({
        path: path.join(process.env.BPB_JITTER_ARTIFACTS, `${variant.name}-compact-card.png`),
    });
    if (variant.width === 390) {
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 320, height: 900 });
        await page.locator('#transition-person + .bpb-climber-actions-trigger').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.getElementById('bpb-climber-card').hidden
            && document.getElementById('bpb-climber-card').getAnimations().every(animation => animation.playState === 'finished'));
        assert.equal(await page.evaluate(inside), true, 'links must wrap at 320px, including enlarged text');
        await capture(page, { ...variant, name: `${variant.name}-w320` }, 'compact-idle');
    }
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        const label = document.createElement('span'); label.id = 'ListLabel';
        label.innerHTML = '<h4>Social Networking</h4><p>Reports showing a climber\'s buddies and other climbers.</p><ul>'
            + '<li>No Buddy list created yet.</li><li><a href="/report/report.aspx?r=rb&cid=900002">Reverse Buddy List</a></li>'
            + '<li><a href="/climber/Compare.aspx?cid=900002">Compare Climbers</a></li></ul>';
        document.querySelector('main').append(label);
        document.getElementById('transition-person').textContent = 'Morgan Longlastname of the Eastern Cascades';
    });
    await page.locator('#transition-person + .bpb-climber-actions-trigger').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('bpb-climber-card').hidden
        && document.getElementById('bpb-climber-card').getAnimations().every(animation => animation.playState === 'finished'));
    assert.equal(await links.nth(2).isVisible(), false, 'existing native profile establishes absent buddy list');
    assert.equal(await links.nth(3).isVisible(), true);
    if (variant.textScale === 1) assert.equal(await links.nth(3).evaluate(link => link.getBoundingClientRect().height
        <= parseFloat(getComputedStyle(link).lineHeight) + 1), true, 'a lone reverse-list link should use the full row without wrapping');
    assert.equal(await page.evaluate(inside), true, 'long names cannot clip the navigation');
    await capture(page, variant, 'compact-no-buddies-long-name');
    assert.deepEqual(requests, [], 'opening and reading list availability must never fetch');
}

export async function verifyRegressionContracts(context, origin, expectBroken = false) {
    const contracts = [
        ['C01', 390, /C01 pending profile.*shifted/, async page => {
            const before = await frame(page);
            await page.locator('#bpb-climber-favorite').click();
            await page.waitForFunction(() => globalThis.__climber.pending.has('favorite'));
            await sample(page, before, 'C01 pending profile');
        }],
        ['C02', 1280, /C02 error shifted the centered title/, async page => {
            const before = await frame(page);
            await page.locator('#bpb-climber-ignore').click();
            await page.waitForFunction(() => globalThis.__climber.pending.has('ignore'));
            await page.evaluate(() => globalThis.__climber.release('ignore', false));
            await page.waitForFunction(() => document.getElementById('bpb-climber-ignore').getAttribute('aria-busy') === 'false');
            const after = await frame(page);
            for (const selector of ['#TitleLabel h1', '#bpb-climber-favorite', '#bpb-climber-ignore'])
                assert.ok(Math.abs(after.boxes[selector].x - before.boxes[selector].x) <= 1, 'C02 error shifted the centered title');
        }],
        ['C03', 390, /C03 native pending.*shifted/, async page => {
            const selectors = [...regions, '#AddBuddy', '#BuddyLabel'], before = await frame(page, selectors);
            await page.locator('#AddBuddy').click();
            await page.waitForFunction(() => globalThis.__climber.pending.has('buddy'));
            await sample(page, before, 'C03 native pending', selectors);
        }],
        ['C06', 1280, /C06 error must be visible without scrolling/, async page => {
            const feedback = page.locator('.bpb-climber-card-feedback');
            assert.equal(await feedback.evaluate(element => {
                const r = element.getBoundingClientRect(), c = document.getElementById('bpb-climber-card').getBoundingClientRect();
                return r.height > 0 && r.top >= c.top && r.bottom <= c.bottom && r.top >= 0 && r.bottom <= innerHeight;
            }), true, 'C06 error must be visible without scrolling');
        }],
        ['C07', 1280, /C07 pending recovery must be unavailable/, async page => {
            await page.locator('#bpb-climber-card-favorite').click();
            await page.waitForFunction(() => globalThis.__climber.pending.has('favorite'));
            assert.equal(await page.locator('.bpb-climber-card-retry').isDisabled(), true, 'C07 pending recovery must be unavailable');
        }],
    ];
    for (const [id, width, failure, check] of contracts) {
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        try {
            await page.setViewportSize({ width, height: 900 });
            await boot(page, origin, { theme: 'dark', width, textScale: 1 });
            if (id === 'C06' || id === 'C07') {
                await page.addStyleTag({ content: await asset('css/climber-hover-card.css') });
                await page.addStyleTag({ content: '.bpb-climber-link:has(#transition-person){position:fixed;left:30px;top:720px}' });
                await page.addScriptTag({ content: await asset('content/climber-hover-card.js') });
                await page.locator('#transition-person + .bpb-climber-actions-trigger').click();
                await page.waitForFunction(() => document.getElementById('bpb-climber-card-favorite')?.disabled === false);
                await page.waitForFunction(() => document.getElementById('bpb-climber-card').getAnimations().every(animation => animation.playState === 'finished'));
                await page.locator('#bpb-climber-card-favorite').click();
                await page.waitForFunction(() => globalThis.__climber.pending.has('favorite'));
                await page.evaluate(() => globalThis.__climber.release('favorite', false));
                await page.locator('.bpb-climber-card-retry').waitFor({ state: 'visible' });
            }
            if (expectBroken) await assert.rejects(() => check(page), failure, `${id}: must fail on the measured UX invariant, not setup`);
            else await check(page);
            console.log(JSON.stringify({ contract: id, auditedBaseline: expectBroken, result: expectBroken ? 'expected regression reproduced' : 'passed' }));
        } finally { await page.close(); }
    }
}

async function run() {
    const resources = createResourceStack(); let failure;
    const { checks, onlyVariant } = climberCheckOptions(process.argv.slice(2));
    let checked = 0;
    try {
        if (checks === 'baseline') historicalAssets = await auditedClimberAssets();
        const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'bpb-climber-transitions-'));
        resources.defer('fixture directory', () => rm(temporaryRoot, { recursive: true, force: true }));
        const fixture = await createBrowserFixtureServer({ temporaryRoot });
        resources.defer('HTTPS server', () => fixture.close());
        if (process.env.BPB_JITTER_ARTIFACTS) await mkdir(process.env.BPB_JITTER_ARTIFACTS, { recursive: true });
        const origin = `https://www.peakbagger.com:${fixture.port}`;
        for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
            if (checks === 'baseline' && name !== 'chrome') continue;
            if (engine === chromium) assertChromeLaunchAllowed();
            const browser = await engine.launch({ headless: true, ...(engine === chromium
                ? { channel: 'chromium', args: [...fixture.chromeTrustArgs, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'] }
                : { firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } }) });
            try {
                if (checks === 'baseline' || checks === 'regressions') {
                    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
                    try { await verifyRegressionContracts(context, origin, checks === 'baseline'); checked += 5; }
                    finally { await context.close(); }
                    continue;
                }
                for (const theme of ['light', 'dark']) for (const width of [390, 768, 1280]) for (const textScale of [1, 2]) {
                    if (onlyVariant && onlyVariant !== `${name}-${theme}-${width}-${textScale}`) continue;
                    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, colorScheme: theme });
                    try {
                        const page = await context.newPage(); page.setDefaultTimeout(10000);
                        const variant = { theme, width, textScale, name: `${name}-${theme}-${width}-${textScale}` };
                        if (checks === 'profile' || checks === 'all') await verifyProfileFeedback(page, origin, variant);
                        if (checks === 'buddy' || checks === 'all') {
                            const buddyPage = await context.newPage(); buddyPage.setDefaultTimeout(10000);
                            await verifyBuddyPresentation(buddyPage, origin, variant);
                        }
                        if (checks === 'pending' || checks === 'all') {
                            const pendingPage = await context.newPage(); pendingPage.setDefaultTimeout(10000);
                            await verifyPendingMembership(pendingPage, origin, variant);
                        }
                        if (checks === 'card-links' || checks === 'all') {
                            await verifyCompactCard(page, origin, variant);
                            if (checks === 'card-links') {
                                const cardPage = await context.newPage(); cardPage.setDefaultTimeout(10000);
                                await verifyCardFeedback(cardPage, origin, variant, false, 720);
                                await cardPage.close();
                            }
                        }
                        if (checks === 'card' || checks === 'card-retry' || checks === 'all') {
                            for (const anchor of checks === 'card-retry' ? [720] : [20, 440, 820]) {
                                const cardPage = await context.newPage(); cardPage.setDefaultTimeout(10000);
                                await verifyCardFeedback(cardPage, origin, variant, checks === 'card-retry', anchor);
                                await cardPage.close();
                            }
                            if (checks !== 'card-retry') for (const anchor of [20, 270, 500]) {
                                const cardPage = await context.newPage(); cardPage.setDefaultTimeout(10000);
                                await cardPage.setViewportSize({ width, height: 540 });
                                await verifyCardFeedback(cardPage, origin, { ...variant, name: `${variant.name}-h540` }, false, anchor);
                                await cardPage.close();
                            }
                        }
                        console.log(JSON.stringify({ ...variant, version: browser.version(), hidden: true, result: 'passed' }));
                        checked++;
                    } finally { await context.close(); }
                }
            } finally { await browser.close(); }
        }
        assert.ok(checked > 0, 'No climber checks ran');
    } catch (error) { failure = error; }
    historicalAssets = null;
    await resources.dispose(failure);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
