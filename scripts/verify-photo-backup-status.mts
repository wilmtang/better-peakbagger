/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shipped extension pages with synthetic GitHub replies; no remote writes.
/* global window, document, chrome, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

interface BackupBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface BackupSurface {
    name: string;
    url: string;
    status: string;
    panel: string;
    button: string;
    heading: string;
}

interface BackupGeometry {
    button: BackupBox;
    heading: BackupBox;
    panel: BackupBox;
    following: BackupBox | null;
    scroll: number;
    scrollHeight: number | undefined;
    clientHeight: number | undefined;
    focused: string;
    dock: BackupBox | null;
    overflow: boolean;
    reservationsHidden: boolean;
}

interface BackupFixtureState {
    state: Record<string, unknown> | null;
    repository: string;
    calls: number;
    finish?: (response: unknown) => void;
}

interface BackupFixtureWindow extends Window {
    backupFixture?: BackupFixtureState;
}

export interface VerifyPhotoBackupStatusOptions {
    context: BrowserContext;
    extensionId: string;
    screenshots?: string;
}

export async function verifyPhotoBackupStatus({ context, extensionId, screenshots }: VerifyPhotoBackupStatusOptions) {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    let checked = 0;
    try {
        await page.addInitScript(() => {
            (window as BackupFixtureWindow).backupFixture = {
                state: { generation: 4, catalogGeneration: 4, confirmedGeneration: 4,
                    syncedAt: '2026-10-17T18:10:00Z' },
                repository: 'better-peakbagger-backup',
                calls: 0,
            };
            const runtime = chrome.runtime as unknown as {
                sendMessage(message: { type?: string }, callback?: (response: unknown) => void): Promise<unknown>;
            };
            const send = runtime.sendMessage.bind(chrome.runtime);
            (chrome.permissions as unknown as { contains: () => Promise<boolean> }).contains = async () => true;
            runtime.sendMessage = (message, callback) => {
                const fixture = (window as BackupFixtureWindow).backupFixture!;
                const repo = { owner: 'wilmtang', name: fixture.repository,
                    fullName: `wilmtang/${fixture.repository}` };
                let result: unknown;
                if (message.type === 'GITHUB_AUTH_STATUS') {
                    result = { connected: true, account: { login: 'wilmtang' }, repo };
                } else if (message.type === 'GITHUB_PHOTOS_STATUS') {
                    result = { ok: true, connected: true, repo, auto: true, state: fixture.state };
                } else if (message.type === 'GITHUB_PHOTOS_BACKUP') {
                    fixture.calls += 1;
                    return new Promise(resolve => { fixture.finish = resolve; });
                } else return send(message, callback);
                if (callback) queueMicrotask(() => callback(result));
                return Promise.resolve(result);
            };
        });
        const syncedAt = '2026-10-17T18:10:00Z';
        const states: readonly [string, Record<string, unknown> | null, string][] = [
            ['current', { generation: 4, catalogGeneration: 4, confirmedGeneration: 4, syncedAt }, 'Up to date in'],
            ['changes', { generation: 4, catalogGeneration: 5, confirmedGeneration: 4,
                syncedAt, reconciliationPending: true }, 'Photo-library changes are not yet backed up'],
            ['local-status', { generation: 4, catalogGeneration: 4, confirmedGeneration: 3,
                syncedAt, reconciliationPending: true }, 'local backup status needs updating'],
            ['unconfirmed', { syncedAt, reconciliationPending: true }, 'Latest photo-library backup is not yet confirmed'],
            ['no-history', null, 'No photo-library backup confirmed yet'],
        ];
        const surfaces: readonly BackupSurface[] = [
            { name: 'settings', url: 'options/options.html#github-photos-backup',
                status: '#photos-github-status', panel: '#github-photos-backup',
                button: '#photos-backup', heading: '#github-photos-backup-heading' },
            { name: 'library', url: 'photos/photos.html?mode=library',
                status: '#photo-backup-status', panel: '.backup-card',
                button: '#backup-library', heading: '#photo-backup-heading' },
        ];
        for (const surface of surfaces) {
            await page.goto(`chrome-extension://${extensionId}/${surface.url}`);
            await page.waitForFunction(selector => Boolean(document.querySelector(selector)?.textContent?.includes('Up to date')), surface.status);
            const geometry = () => page.evaluate((targetSurface: BackupSurface): BackupGeometry => {
                const rect = (node: Element): BackupBox => {
                    const box = node.getBoundingClientRect();
                    return { x: box.x, y: box.y, width: box.width, height: box.height };
                };
                const panel = document.querySelector(targetSurface.panel)!;
                const following = panel.nextElementSibling
                    || panel.parentElement!.nextElementSibling;
                const status = document.querySelector(targetSurface.status)!;
                const dockNode = document.querySelector('.status-dock');
                return {
                    button: rect(document.querySelector(targetSurface.button)!),
                    heading: rect(document.querySelector(targetSurface.heading)!),
                    panel: rect(panel),
                    following: following ? rect(following) : null,
                    scroll: document.querySelector('.content')?.scrollTop ?? document.scrollingElement!.scrollTop,
                    scrollHeight: document.querySelector('.content')?.scrollHeight,
                    clientHeight: document.querySelector('.content')?.clientHeight,
                    focused: document.activeElement!.id,
                    dock: dockNode && rect(dockNode),
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    reservationsHidden: [...status.querySelectorAll('[aria-hidden]')].every(node =>
                        getComputedStyle(node).visibility === 'hidden' && (node as HTMLElement).tabIndex === -1),
                };
            }, surface);
            const stable = (before: BackupGeometry, after: BackupGeometry, label: string) => {
                assert.equal(after.overflow, false, `${label}: page fits`);
                assert.equal(after.reservationsHidden, true, `${label}: sizing labels are unpainted and unfocusable`);
                for (const key of ['button', 'heading', 'panel', 'following'] as const) {
                    const beforeBox = before[key], afterBox = after[key];
                    if (!beforeBox) continue;
                    assert.ok(afterBox, `${label}: missing ${key}`);
                    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
                        assert.ok(Math.abs(beforeBox[dimension] - afterBox[dimension]) <= 0.5,
                            `${label}: ${key}.${dimension} changed: ${JSON.stringify({ before, after })}`);
                    }
                }
                assert.ok(Math.abs(before.scroll - after.scroll) <= 0.5, `${label}: reading position stays fixed`);
                checked += 1;
            };
            for (const theme of ['light', 'dark']) {
                await page.locator('html').evaluate((html, nextTheme) => { (html as HTMLElement).dataset.bpbTheme = nextTheme; }, theme);
                for (const [width, zoom] of [[1440, 1], [390, 1], [320, 1], [780, 2]] as const) {
                    await page.setViewportSize({ width, height: 1100 });
                    await page.locator('body').evaluate((body, zoomScale) => { (body as HTMLElement).style.zoom = String(zoomScale); }, zoom);
                    for (const repository of ['better-peakbagger-backup', 'long-photo-backup-repository-name-'.repeat(3)]) {
                        let before: BackupGeometry | undefined;
                        for (const [name, state, expected] of states) {
                            await page.evaluate(async ({ nextState, nextRepository }) => {
                                Object.assign((window as BackupFixtureWindow).backupFixture!, { state: nextState, repository: nextRepository });
                                await chrome.storage.local.set({ bpbPhotoLibraryBackupState: { serial: crypto.randomUUID() } });
                            }, { nextState: state, nextRepository: repository });
                            await page.waitForFunction(({ selector, expectedText, repoName }) => {
                                const text = document.querySelector(selector)?.textContent;
                                return Boolean(text?.includes(expectedText) && text.includes(`wilmtang/${repoName}`));
                            }, { selector: surface.status, expectedText: expected, repoName: repository });
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
                            const calls = await page.evaluate(() => (window as BackupFixtureWindow).backupFixture!.calls);
                            await button.evaluate(element => (element as HTMLButtonElement).focus({ preventScroll: true }));
                            await page.keyboard.press('Enter');
                            await page.waitForFunction(selector =>
                                Boolean(document.querySelector(selector)?.textContent?.startsWith('Backing up')), surface.status);
                            stable(before!, await geometry(), `${surface.name}: pending`);
                            assert.equal(await button.isDisabled(), true);
                            await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
                            assert.equal(await button.evaluate(element => (element as HTMLButtonElement).disabled), false, 'temporary unavailability remains focusable');
                            assert.equal((await geometry()).focused, surface.button.slice(1));
                            await button.evaluate(element => (element as HTMLButtonElement).click());
                            assert.equal(await page.evaluate(() => (window as BackupFixtureWindow).backupFixture!.calls), calls + 1);
                            await page.evaluate(({ isFailure, nextState }) => {
                                const fixture = (window as BackupFixtureWindow).backupFixture!;
                                fixture.state = nextState;
                                fixture.finish!(isFailure
                                    ? { ok: false, error: { message: 'The photo-library backup failed. Try again.' } }
                                    : { ok: true });
                            }, { isFailure: failure, nextState: states[0][1] });
                            await page.waitForFunction(selector => !document.querySelector<HTMLButtonElement>(selector)?.disabled
                                && document.querySelector(selector)!.getAttribute('aria-busy') !== 'true', surface.button);
                            await page.waitForFunction(({ selector, isFailure, library }) => {
                                const text = document.querySelector(selector)?.textContent;
                                return Boolean(text && (isFailure ? (library ? text.includes('failed') : !text.startsWith('Backing up'))
                                    : text.includes('Up to date')));
                            }, { selector: surface.status, isFailure: failure, library: surface.name === 'library' });
                            stable(before!, await geometry(), `${surface.name}/${theme}/${width}/${zoom}/${repository}: ${failure ? 'error' : 'success'}`);
                            if (!failure && surface.name === 'settings') {
                                await page.waitForFunction(() => !document.getElementById('status')!.classList.contains('show'));
                                stable(before!, await geometry(), `${surface.name}: success feedback fades`);
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
