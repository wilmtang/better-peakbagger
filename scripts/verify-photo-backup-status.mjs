// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shipped extension pages with synthetic GitHub replies; no remote writes.
/* global window, document, chrome, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyPhotoBackupStatus({ context, extensionId, screenshots }) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let checked = 0;
    try {
        await page.addInitScript(() => {
            window.backupFixture = {
                state: { generation: 4, catalogGeneration: 4, confirmedGeneration: 4,
                    syncedAt: '2026-10-17T18:10:00Z' },
                repository: 'better-peakbagger-backup',
                calls: 0,
            };
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.permissions.contains = async () => true;
            chrome.runtime.sendMessage = (message, callback) => {
                const repo = { owner: 'wilmtang', name: window.backupFixture.repository,
                    fullName: `wilmtang/${window.backupFixture.repository}` };
                let result;
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    result = { connected: true, account: { login: 'wilmtang' }, repo };
                } else if (message.type === 'GITHUB_PHOTOS_STATUS') {
                    result = { ok: true, connected: true, repo, auto: true, state: window.backupFixture.state };
                } else if (message.type === 'GITHUB_PHOTOS_BACKUP') {
                    window.backupFixture.calls += 1;
                    return new Promise(resolve => { window.backupFixture.finish = resolve; });
                } else return send(message, callback);
                if (callback) queueMicrotask(() => callback(result));
                return Promise.resolve(result);
            };
        });
        const syncedAt = '2026-10-17T18:10:00Z';
        const states = [
            ['current', { generation: 4, catalogGeneration: 4, confirmedGeneration: 4, syncedAt }, 'Up to date in'],
            ['changes', { generation: 4, catalogGeneration: 5, confirmedGeneration: 4,
                syncedAt, reconciliationPending: true }, 'Photo-library changes are not yet backed up'],
            ['local-status', { generation: 4, catalogGeneration: 4, confirmedGeneration: 3,
                syncedAt, reconciliationPending: true }, 'local backup status needs updating'],
            ['unconfirmed', { syncedAt, reconciliationPending: true }, 'Latest photo-library backup is not yet confirmed'],
            ['no-history', null, 'No photo-library backup confirmed yet'],
        ];
        for (const surface of [
            { name: 'settings', url: 'options/options.html#github-photos-backup',
                status: '#photos-github-status', panel: '#github-photos-backup',
                button: '#photos-backup', heading: '#github-photos-backup-heading' },
            { name: 'library', url: 'photos/photos.html?mode=library',
                status: '#photo-backup-status', panel: '.backup-card',
                button: '#backup-library', heading: '#photo-backup-heading' },
        ]) {
            await page.goto(`chrome-extension://${extensionId}/${surface.url}`);
            await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Up to date'), surface.status);
            const geometry = () => page.evaluate(surface => {
                const rect = node => {
                    const box = node.getBoundingClientRect();
                    return { x: box.x, y: box.y, width: box.width, height: box.height };
                };
                const panel = document.querySelector(surface.panel);
                const following = panel.nextElementSibling
                    || panel.parentElement.nextElementSibling;
                const status = document.querySelector(surface.status);
                return {
                    button: rect(document.querySelector(surface.button)),
                    heading: rect(document.querySelector(surface.heading)),
                    panel: rect(panel),
                    following: following ? rect(following) : null,
                    scroll: document.querySelector('.content')?.scrollTop ?? document.scrollingElement.scrollTop,
                    scrollHeight: document.querySelector('.content')?.scrollHeight,
                    clientHeight: document.querySelector('.content')?.clientHeight,
                    focused: document.activeElement.id,
                    dock: document.querySelector('.status-dock') && rect(document.querySelector('.status-dock')),
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    reservationsHidden: [...status.querySelectorAll('[aria-hidden]')].every(node =>
                        getComputedStyle(node).visibility === 'hidden' && node.tabIndex === -1),
                };
            }, surface);
            const stable = (before, after, label) => {
                assert.equal(after.overflow, false, `${label}: page fits`);
                assert.equal(after.reservationsHidden, true, `${label}: sizing labels are unpainted and unfocusable`);
                for (const key of ['button', 'heading', 'panel', 'following']) {
                    if (!before[key]) continue;
                    for (const dimension of ['x', 'y', 'width', 'height']) {
                        assert.ok(Math.abs(before[key][dimension] - after[key][dimension]) <= 0.5,
                            `${label}: ${key}.${dimension} changed: ${JSON.stringify({ before, after })}`);
                    }
                }
                assert.ok(Math.abs(before.scroll - after.scroll) <= 0.5, `${label}: reading position stays fixed`);
                checked += 1;
            };
            for (const theme of ['light', 'dark']) {
                await page.locator('html').evaluate((html, theme) => { html.dataset.bpbTheme = theme; }, theme);
                for (const [width, zoom] of [[1440, 1], [390, 1], [320, 1], [780, 2]]) {
                    await page.setViewportSize({ width, height: 1100 });
                    await page.locator('body').evaluate((body, zoom) => { body.style.zoom = zoom; }, zoom);
                    for (const repository of ['better-peakbagger-backup', 'long-photo-backup-repository-name-'.repeat(3)]) {
                        let before;
                        for (const [name, state, expected] of states) {
                            await page.evaluate(async ({ state, repository }) => {
                                Object.assign(window.backupFixture, { state, repository });
                                await chrome.storage.local.set({ bpbPhotoLibraryBackupState: { serial: crypto.randomUUID() } });
                            }, { state, repository });
                            await page.waitForFunction(({ selector, expected, repository }) => {
                                const text = document.querySelector(selector)?.textContent;
                                return text?.includes(expected) && text.includes(`wilmtang/${repository}`);
                            }, { selector: surface.status, expected, repository });
                            if (!before) {
                                await page.locator(surface.button).scrollIntoViewIfNeeded();
                                before = await geometry();
                            }
                            const label = `${surface.name}/${theme}/${width}/${zoom}/${repository}/${name}`;
                            stable(before, await geometry(), label);
                            if (screenshots && repository === 'better-peakbagger-backup'
                                && zoom === 1 && ['current', 'local-status'].includes(name)) {
                                // A locator screenshot scrolls its target into view,
                                // which would itself change the measured reading position.
                                await page.screenshot({ path: path.join(screenshots,
                                    `backup-${surface.name}-${theme}-${width}-${name}.png`) });
                            }
                        }
                        // Hold the worker reply while keyboard activation exposes the
                        // real pending state, then complete and retry after an error.
                        const button = page.locator(surface.button);
                        for (const failure of [true, false]) {
                            const calls = await page.evaluate(() => window.backupFixture.calls);
                            await button.evaluate(button => button.focus({ preventScroll: true }));
                            await page.keyboard.press('Enter');
                            await page.waitForFunction(selector =>
                                document.querySelector(selector)?.textContent.startsWith('Backing up'), surface.status);
                            stable(before, await geometry(), `${surface.name}: pending`);
                            assert.equal(await button.isDisabled(), true);
                            await button.evaluate(button => button.click());
                            assert.equal(await page.evaluate(() => window.backupFixture.calls), calls + 1);
                            await page.evaluate(({ failure, state }) => {
                                window.backupFixture.state = state;
                                window.backupFixture.finish(failure
                                    ? { ok: false, error: { message: 'The photo-library backup failed. Try again.' } }
                                    : { ok: true });
                            }, { failure, state: states[0][1] });
                            await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, surface.button);
                            await page.waitForFunction(({ selector, failure, library }) => {
                                const text = document.querySelector(selector)?.textContent;
                                return failure ? library ? text.includes('failed') : !text.startsWith('Backing up')
                                    : text.includes('Up to date');
                            }, { selector: surface.status, failure, library: surface.name === 'library' });
                            stable(before, await geometry(), `${surface.name}/${theme}/${width}/${zoom}/${repository}: ${failure ? 'error' : 'success'}`);
                            if (!failure && surface.name === 'settings') {
                                await page.waitForFunction(() => !document.getElementById('status').classList.contains('show'));
                                stable(before, await geometry(), `${surface.name}: success feedback fades`);
                            }
                        }
                    }
                }
            }
        }
        assert.ok(checked > 0, 'backup status verification must execute cases');
        assert.deepEqual(errors, []);
        return { checked, widths: [1440, 390, 320, 780], cssZoom: [1, 2], themes: ['light', 'dark'] };
    } finally { await page.close(); }
}
