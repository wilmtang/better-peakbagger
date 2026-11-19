// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Static extension UI screenshots use a synthetic worker reply. Transaction
// behavior is covered separately; this check never contacts a GitHub repository.
/// <reference lib="dom" />
/// <reference types="chrome" />
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createResourceStack } from './resource-stack.mts';
import { createVerificationRoot, launchVerificationChrome } from './verification-launch.mts';

// Page-world fixture state; callbacks cast in place so the shared program keeps its globals.
interface IgnoredFixture { count: number; enabled: boolean; phase: string; error: string; hold?: boolean }
interface ClimberProbe { __ignoredFixture: IgnoredFixture; __releaseIgnoredFixture(): void; __releaseListMutation(): void }
type Field = HTMLInputElement & HTMLDetailsElement;
const resources = createResourceStack();
const profile = await createVerificationRoot(resources, 'bpb-climber-ui-', 'climber UI profile');
const output = process.env.BPB_VERIFY_IGNORED_SCREENSHOT_DIR || '/tmp/bpb-ignored-visual';
await mkdir(output, { recursive: true });
let failure: unknown = null;
try {
    const dist = path.resolve('dist');
    const context = await launchVerificationChrome(resources, 'climber UI browser', profile, {
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], extension: dist });
    const registry = await context.newPage(); await registry.goto('chrome://extensions-internals/');
    const id = await registry.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find((record: { name: string; id: string }) => record.name === 'Better Peakbagger')?.id; }
        catch { return false; }
    }).then(handle => handle.jsonValue());
    await registry.close();
    const page = await context.newPage();
    await page.addInitScript(() => {
        if (!globalThis.chrome?.storage) return;
        (globalThis as unknown as ClimberProbe).__ignoredFixture = { count: 1500, enabled: false, phase: 'local', error: '' };
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.permissions.contains = async () => true;
        chrome.runtime.sendMessage = (async (message: { type: string; action?: string }) => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: true, repo: { owner: 'example', name: 'backup' } };
            if (message.type !== 'GITHUB_IGNORED_LIST') return original(message);
            const fixture = (globalThis as unknown as ClimberProbe).__ignoredFixture;
            if (message.action === 'status' || message.action === 'check') return { ok: true, count: fixture.count, state: fixture };
            if (message.action === 'dismiss') return { ok: true, state: { phase: 'local' } };
            if (fixture.hold) return new Promise<unknown>(resolve => {
                (globalThis as unknown as ClimberProbe).__releaseIgnoredFixture = () => resolve({ ok: true, state: { phase: 'backed-up' } });
            });
            return { ok: true, preview: { id: 'fixture', kind: message.action === 'restore' ? 'restore' : 'setup',
                local: Array.from({ length: 1500 }, (_item, index) => ({ cid: index === 1499 ? 900002 : index + 1, name: 'Example', addedAt: 1 })),
                remote: [{ cid: 900002, name: 'GitHub name', addedAt: 2 }, { cid: 900003, name: 'Remote climber', addedAt: 1 }],
                conflicts: [{ cid: 900002,
                    device: { name: 'Alex Example with a long climber name that wraps without clipping', addedAt: 1759276800000 },
                    github: { name: 'Alex Example renamed on the other device', addedAt: 1759363200000 } },
                { cid: 900003, device: null, github: { name: 'Remote climber', addedAt: 1759363200000 } }],
                impacts: { device: { local: { added: 0, removed: 0 }, remote: { added: 1500, removed: 2 } },
                    github: { local: { added: 2, removed: 1500 }, remote: { added: 0, removed: 0 } },
                    merge: { local: { added: 2, removed: 0 }, remote: { added: 1500, removed: 0 } } } } };
        }) as typeof chrome.runtime.sendMessage;
    });
    await page.goto(`chrome-extension://${id}/options/options.html#github-favorites-backup`);
    await page.evaluate(async () => {
        const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
        await chrome.storage.sync.set({ bpbSettings: { ...(bpbSettings as object), enableGithubBackup: true } });
    });
    await page.locator('#ignored-backup').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !(document.getElementById('ignored-backup') as Field).disabled);
    await page.goto(`chrome-extension://${id}/options/options.html#favorites`);
    await page.waitForFunction(() => document.querySelector('a[href="#favorites"][aria-current]')
        && document.querySelector('a[href="#beta"].nav-parent-active'));
    assert.equal(await page.locator('#beta').evaluate(node => node.children[1].id), 'favorites', 'climber lists is not first under beta');
    for (const theme of ['light', 'dark']) {
        for (const [width, height] of [[1024,900], [390,844]]) {
            await page.setViewportSize({ width, height });
            await page.goto(`chrome-extension://${id}/options/options.html#beta`);
            await page.waitForFunction(() => {
                const content = document.querySelector('.content')!, beta = document.getElementById('beta')!;
                return Math.abs(beta.getBoundingClientRect().top - content.getBoundingClientRect().top - 24) < 2;
            });
            await page.locator('html').evaluate((node, value) => { (node as HTMLElement).dataset.bpbTheme = value; }, theme);
            const bounds = (await page.locator('#favorites .card').boundingBox())!;
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'climber list card overflowed');
            assert.ok(await page.locator('#open-favorites').isVisible(), 'manager action is not visible');
            await page.screenshot({ path: path.join(output, `climber-settings-${theme}-${width}.png`) });
        }
    }
    const capture = async (state: string) => {
        for (const theme of ['light', 'dark']) {
            await page.locator('html').evaluate((node, value) => { (node as HTMLElement).dataset.bpbTheme = value; }, theme);
            for (const [width, height] of [[1024,900], [390,844]]) {
                await page.setViewportSize({ width, height });
                await page.locator('#ignored-github').scrollIntoViewIfNeeded();
                const bounds = (await page.locator('#ignored-github').boundingBox())!;
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'ignored card overflowed');
                await page.screenshot({ path: path.join(output, `backup-${state}-${theme}-${width}.png`) });
            }
        }
    };
    await capture('idle');
    await page.locator('#ignored-backup').click(); await page.locator('#ignored-review').waitFor({ state: 'visible' });
    await capture('review');
    const protocol = await context.newCDPSession(page);
    await protocol.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
    await page.locator('#ignored-review-cancel').focus();
    await page.locator('#ignored-github').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'backup-review-dark-200percent.png') });
    await protocol.send('Emulation.clearDeviceMetricsOverride');
    await page.locator('#ignored-review-cancel').click(); await page.locator('#ignored-review').waitFor({ state: 'hidden' });
    const setState = async (state: Partial<IgnoredFixture> & { phase: string }) => {
        await page.evaluate(async value => {
            (globalThis as unknown as ClimberProbe).__ignoredFixture = { error: '', count: 1500, enabled: false, ...value };
            await chrome.storage.local.set({ bpbIgnoredSyncState: { fixture: value } });
        }, state);
    };
    await setState({ phase: 'local', count: 0 });
    await page.waitForFunction(() => (document.getElementById('ignored-github-status') as Field).textContent.includes('0 climbers'));
    await capture('empty');
    await setState({ phase: 'offline', enabled: true, error: 'Could not reach GitHub. Try again.' });
    await page.waitForFunction(() => (document.getElementById('ignored-github-status') as Field).textContent.includes('Offline'));
    await capture('offline');
    await setState({ phase: 'pending', enabled: true, hold: true });
    await page.waitForFunction(() => (document.getElementById('ignored-github-status') as Field).textContent === 'Pending changes');
    const before = (await page.locator('#ignored-backup').boundingBox())!;
    await page.locator('#ignored-backup').click();
    await page.waitForFunction(() => (document.getElementById('ignored-github') as Field).getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('#ignored-sync-enable').isEnabled(), true, 'busy sync cannot be cancelled');
    assert.equal((await page.locator('#ignored-backup').boundingBox())!.width, before.width, 'sync busy state changed button width');
    await capture('loading');
    await page.evaluate(() => { (globalThis as unknown as ClimberProbe).__ignoredFixture.phase = 'local'; (globalThis as unknown as ClimberProbe).__releaseIgnoredFixture(); });
    await page.waitForFunction(() => !(document.getElementById('ignored-github') as Field).hasAttribute('aria-busy'));
    await page.goto(`chrome-extension://${id}/options/favorites.html#ignored`);
    await page.evaluate(async () => {
        await chrome.storage.local.set({ bpbIgnoredClimbers: { schemaVersion: 1, revision: 1,
            entries: [1, 2].map(cid => ({ cid, name: `Example climber ${cid}`, addedAt: cid })) } });
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = ((message: { type: string }) => message.type === 'IGNORED_MUTATE'
            ? new Promise((resolve, reject) => {
                (globalThis as unknown as ClimberProbe).__releaseListMutation = () => send(message).then(resolve, reject);
            }) : send(message)) as typeof chrome.runtime.sendMessage;
    });
    await page.waitForFunction(() => document.querySelectorAll('#ignored-list li').length === 2);
    const removed = page.locator('#ignored-list [data-cid="2"] button');
    await removed.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#ignored-list [data-cid="2"] button')
        ?.getAttribute('aria-disabled') === 'true');
    assert.equal(await removed.evaluate(node => document.activeElement === node), true, 'pending removal lost focus');
    for (const theme of ['light', 'dark']) {
        await page.locator('html').evaluate((node, value) => { (node as HTMLElement).dataset.bpbTheme = value; }, theme);
        for (const [width, height] of [[1024,900], [390,844]]) {
            await page.setViewportSize({ width, height });
            await page.screenshot({ path: path.join(output, `ignored-pending-${theme}-${width}.png`) });
        }
    }
    await page.evaluate(() => (globalThis as unknown as ClimberProbe).__releaseListMutation());
    await page.waitForFunction(() => (document.getElementById('ignored-list') as Field).getAttribute('aria-busy') === 'false'
        && document.activeElement?.closest<HTMLElement>('[data-cid]')?.dataset.cid === '1');
    await page.locator('#ignored-undo-button').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.getElementById('ignored-list') as Field).getAttribute('aria-busy') === 'true');
    await page.evaluate(() => (globalThis as unknown as ClimberProbe).__releaseListMutation());
    await page.waitForFunction(() => (document.getElementById('ignored-undo') as Field).hidden
        && document.activeElement?.closest<HTMLElement>('[data-cid]')?.dataset.cid === '2');
    await page.screenshot({ path: path.join(output, 'ignored-restored-dark-390.png') });
    await page.evaluate(async () => {
        const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
        await chrome.storage.sync.set({ bpbSettings: { ...(bpbSettings as object), favoritesSource: 'custom' } });
    });
    await page.route('https://www.peakbagger.com/report/report.aspx*', async route => route.fulfill({
        contentType: 'text/html', body: await readFile('test/fixtures/pages/report-buddy-list.html', 'utf8'),
    }));
    await page.goto(`chrome-extension://${id}/options/favorites.html`);
    for (const state of ['empty', 'populated', 'long-name']) {
        await page.evaluate(async value => {
            await chrome.storage.local.set({ bpbFavoriteClimbers: { schemaVersion: 1,
                entries: value === 'empty' ? [] : [{ cid: 900099, addedAt: Date.now(), source: 'manual',
                    name: value === 'long-name' ? 'Alex Example with a long climber name that wraps without clipping' : 'Alex Example' }] } });
        }, state);
        await page.waitForFunction(empty => (document.getElementById('favorites-list') as Field).children.length === (empty ? 0 : 1), state === 'empty');
        for (const theme of ['light', 'dark']) {
            await page.locator('html').evaluate((node, value) => { (node as HTMLElement).dataset.bpbTheme = value; }, theme);
            for (const [width, height] of [[1024,900], [390,844]]) {
                await page.setViewportSize({ width, height });
                await page.evaluate(() => globalThis.scrollTo(0, 0));
                const searchBox = (await page.locator('#favorites-search').boundingBox())!;
                const resultBox = (await page.locator(state === 'empty' ? '#favorites-empty' : '#favorites-list li').boundingBox())!;
                assert.ok(searchBox.y > 0 && resultBox.y + resultBox.height <= height, `${state}: list is below the initial viewport`);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > globalThis.innerWidth), false, 'workspace overflows horizontally');
                await page.screenshot({ path: path.join(output, `favorites-${state}-${theme}-${width}.png`) });
            }
        }
    }
    const summary = page.locator('.favorites-buddy-options summary');
    await summary.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector<Field>('.favorites-buddy-options')!.open);
    await page.locator('#favorites-mirror-buddies').click();
    await page.locator('#favorites-mirror-confirmation').waitFor({ state: 'visible' });
    await summary.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector<Field>('.favorites-buddy-options')!.open);
    assert.equal(await page.locator('#favorites-mirror-confirmation').isVisible(), true, 'closing options concealed confirmation');
    await page.locator('#favorites-mirror-cancel').click();
    assert.equal(await summary.evaluate(node => document.activeElement === node), true, 'cancel focused a hidden import button');
    console.log(`Hidden ${context.browser()!.version()}; static extension UI, 1024x900 / 390x844, light/dark, climber-list workspace and settings, list focus/Undo, keyboard disclosure, loading/offline/empty/conflict/1500-entry states and a 200% equivalent CSS viewport (DPR 2). Synthetic worker replies; no GitHub network writes.`);
} catch (error) { failure = error; }
await resources.dispose(failure as null);
