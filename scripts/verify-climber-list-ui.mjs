// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Static extension UI screenshots use a synthetic worker reply. Transaction
// behavior is covered separately; this check never contacts a GitHub repository.
/* global chrome, document */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createResourceStack } from './resource-stack.mjs';
const resources = createResourceStack();
const profile = await mkdtemp(path.join(os.tmpdir(), 'bpb-climber-ui-'));
resources.defer('climber UI profile', () => rm(profile, { recursive: true, force: true }));
const output = process.env.BPB_VERIFY_IGNORED_SCREENSHOT_DIR || '/tmp/bpb-ignored-visual';
await mkdir(output, { recursive: true });
let failure;
try {
    const dist = path.resolve('dist');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
        args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
    resources.defer('climber UI browser', () => context.close());
    const registry = await context.newPage(); await registry.goto('chrome://extensions-internals/');
    const id = await registry.waitForFunction(() => {
        try { return JSON.parse(document.body.innerText).find(record => record.name === 'Better Peakbagger')?.id; }
        catch { return false; }
    }).then(handle => handle.jsonValue());
    await registry.close();
    const page = await context.newPage();
    await page.addInitScript(() => {
        if (!globalThis.chrome?.storage) return;
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.permissions.contains = async () => true;
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') return { connected: true, repo: { owner: 'example', name: 'backup' } };
            if (message.type !== 'GITHUB_IGNORED_LIST') return original(message);
            if (message.action === 'status') return { ok: true, count: 1500, state: { enabled: false, phase: 'local', error: '' } };
            if (message.action === 'dismiss') return { ok: true, state: { phase: 'local' } };
            return { ok: true, preview: { id: 'fixture', kind: message.action === 'restore' ? 'restore' : 'setup',
                local: [], remote: [], conflicts: [{ cid: 900002, device: { name: 'Alex Example with a long climber name that wraps without clipping' }, github: null }],
                impacts: { device: { local: { added: 0, removed: 0 }, remote: { added: 1500, removed: 2 } },
                    github: { local: { added: 2, removed: 1500 }, remote: { added: 0, removed: 0 } },
                    merge: { local: { added: 2, removed: 0 }, remote: { added: 1500, removed: 0 } } } } };
        };
    });
    await page.goto(`chrome-extension://${id}/options/options.html#github-favorites-backup`);
    await page.evaluate(async () => {
        const { bpbSettings = {} } = await chrome.storage.sync.get('bpbSettings');
        await chrome.storage.sync.set({ bpbSettings: { ...bpbSettings, enableGithubBackup: true } });
    });
    await page.locator('#ignored-backup').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('ignored-backup').disabled);
    for (const state of ['idle', 'review']) {
        if (state === 'review') { await page.locator('#ignored-backup').click(); await page.locator('#ignored-review').waitFor({ state: 'visible' }); }
        for (const theme of ['light', 'dark']) {
            await page.locator('html').evaluate((node, value) => node.dataset.bpbTheme = value, theme);
            for (const [width, height] of [[1024,900], [390,844]]) {
                await page.setViewportSize({ width, height });
                await page.locator('#ignored-github').scrollIntoViewIfNeeded();
                const bounds = await page.locator('#ignored-github').boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'ignored card overflowed');
                await page.screenshot({ path: path.join(output, `backup-${state}-${theme}-${width}.png`) });
            }
        }
    }
    const protocol = await context.newCDPSession(page);
    await protocol.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
    await page.locator('#ignored-review-cancel').focus();
    await page.locator('#ignored-github').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'backup-review-dark-200percent.png') });
    console.log(`Hidden ${context.browser().version()}; static extension UI, 1024x900 / 390x844, light/dark and a 200% equivalent CSS viewport (DPR 2). Synthetic worker replies; no GitHub network writes.`);
} catch (error) { failure = error; }
await resources.dispose(failure);
