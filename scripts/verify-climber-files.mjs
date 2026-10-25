// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, location */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Files from '../src/favorites/climber-files.js';

// Shipped manager and native file downloads; storage/worker replies are held
// fixtures. The store tests separately exercise the real mutation guards.
export async function verifyClimberFiles(page, origin, variant, { capture }) {
    await page.addInitScript(({ theme }) => {
        const settings = { theme, favoritesSource: 'custom' };
        const entry = cid => ({ cid, name: `Climber ${cid}`, addedAt: 1, source: 'manual' });
        const values = { bpbFavoriteClimbers: { schemaVersion: 1, entries: [entry(1)] },
            bpbIgnoredClimbers: { schemaVersion: 1, revision: 0, entries: [entry(3)] } };
        const listeners = [];
        const local = { get: async () => structuredClone(values), set: async patch => {
            Object.assign(values, patch);
            for (const listener of listeners) listener(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), 'local');
        }, remove: async () => {} };
        globalThis.__calls = [];
        globalThis.chrome = {
            storage: { local, sync: { get: async () => ({ bpbSettings: settings }) },
                onChanged: { addListener: listener => listeners.push(listener), removeListener() {} } },
            runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.2' }),
                getURL: file => new URL(`/dist/${file}`, location.origin).href,
                sendMessage: async message => {
                    globalThis.__calls.push(message.type);
                    if (['FAVORITES_MUTATE', 'IGNORED_MUTATE'].includes(message.type)) return new Promise(resolve => {
                        globalThis.__finish = async response => {
                            globalThis.__finish = null;
                            if (response.ok) {
                                const key = message.type === 'FAVORITES_MUTATE' ? 'bpbFavoriteClimbers' : 'bpbIgnoredClimbers';
                                await local.set({ [key]: message.mutation.favorites
                                    || { schemaVersion: 1, revision: values[key].revision + 1, entries: message.mutation.entries } });
                            }
                            resolve(response);
                        };
                    });
                    return { ok: true };
                } },
        };
    }, variant);
    await page.goto(`${origin}/dist/options/favorites.html`);
    await page.locator('#favorites-count').filter({ hasText: '1 favorite' }).waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const settle = () => page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    for (const kind of ['favorites', 'ignored']) {
        await page.locator(`#${kind}-tab`).press('Enter');
        const root = page.locator(`[data-climber-files="${kind}"]`);
        const preview = root.locator('.climber-file-preview'), confirm = root.locator('[data-file-action="confirm"]');
        const exportButton = root.locator('[data-file-action="export"]');
        await root.scrollIntoViewIfNeeded();
        const downloadPromise = page.waitForEvent('download');
        await exportButton.press('Enter');
        const download = await downloadPromise;
        const exported = Files.parseListFile(kind, await readFile(await download.path(), 'utf8'));
        assert.equal(exported.entries.length, 1);
        assert.match(download.suggestedFilename(), new RegExp(`better-peakbagger-${kind}-.*\\.json$`));
        await download.delete();
        for (const scale of [1, 2]) {
            await page.addStyleTag({ content: `[data-climber-files] button, [data-climber-files] p { font-size:${14 * scale}px !important; }` });
            const entries = [{ cid: kind === 'favorites' ? 2 : 4, name: 'A climber with a deliberately long display name', addedAt: 2, source: 'manual' }];
            const replacement = { schemaVersion: 1, revision: 0, entries };
            await page.evaluate(() => { globalThis.__calls = []; });
            const importButton = root.locator('[data-file-action=import]'); await importButton.focus();
            const file = { name: `${kind}.json`, mimeType: 'application/json',
                buffer: Buffer.from(Files.serializeListFile(kind, replacement)) };
            await root.locator('input[type=file]').setInputFiles(file);
            await preview.waitFor();
            assert(await root.locator('[data-file-action=cancel]').evaluate(element => document.activeElement === element));
            await root.locator('[data-file-action=cancel]').press('Escape');
            assert(await preview.isHidden());
            assert(await importButton.evaluate(element => document.activeElement === element));
            await root.locator('input[type=file]').setInputFiles(file);
            await preview.waitFor();
            assert.deepEqual(await page.evaluate(() => globalThis.__calls), [], 'file preview does not mutate or contact GitHub');
            await confirm.scrollIntoViewIfNeeded();
            await confirm.focus();
            await settle();
            const snapshot = () => root.evaluate(element => {
                const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
                return { action: rect(element.querySelector('[data-file-action=confirm]')), panel: rect(element),
                    heading: rect(document.querySelector('.head')), following: rect(document.querySelector('.status-dock')),
                    scroll: document.querySelector('.content').scrollTop };
            });
            const before = await snapshot();
            const stable = async label => {
                await settle();
                const after = await snapshot();
                for (const name of ['action', 'panel', 'heading', 'following']) for (const key of ['x', 'y', 'width', 'height'])
                    assert.ok(Math.abs(before[name][key] - after[name][key]) <= 1, `${kind} ${scale}x ${label}: ${name}.${key} shifted`);
                assert.ok(Math.abs(before.scroll - after.scroll) <= 1, `${kind} ${label}: reading position`);
                assert.equal(await confirm.evaluate(element => document.activeElement === element), true, `${kind} ${label}: focus`);
            };
            for (const error of [{ code: 'storage', message: 'A failed local write' },
                { code: 'list-conflict', message: `${'Long climber name '.repeat(20)}: Remove from favorites before ignoring.` },
                { code: 'stale', message: 'Changed elsewhere' }]) {
                const previous = await page.evaluate(() => globalThis.__calls.length);
                await confirm.press('Enter');
                await page.waitForFunction(() => typeof globalThis.__finish === 'function');
                await page.keyboard.press('Enter'); await page.keyboard.press('Space');
                assert.equal(await page.evaluate(() => globalThis.__calls.length), previous + 1);
                await stable('pending');
                await page.evaluate(error => globalThis.__finish({ ok: false, error }), error);
                await root.locator('[role=status]').filter({ hasText: /Try again|Review your lists|Review the updated counts/ }).waitFor();
                await page.waitForFunction(kind => !document.querySelector(`[data-climber-files="${kind}"]`).hasAttribute('aria-busy'), kind);
                await stable(error.code);
            }
            await capture(page, `${variant.name}-${kind}-file-retry-${scale}`);
            await confirm.press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finish === 'function');
            await page.evaluate(() => globalThis.__finish({ ok: true }));
            await preview.waitFor({ state: 'hidden' });
            await root.locator('[role=status]').filter({ hasText: 'List imported.' }).waitFor();
            await page.locator(`#${kind}-list`).filter({ hasText: entries[0].name }).waitFor();
            assert.equal(await root.locator('[data-file-action=import]').evaluate(element => document.activeElement === element), true);
            assert.equal(await root.locator('[data-file-action=confirm]').isVisible(), false, 'hidden preview cannot expose a clickable confirmation');
            assert.ok((await page.evaluate(() => globalThis.__calls)).every(type => ['FAVORITES_MUTATE', 'IGNORED_MUTATE'].includes(type)));
            await capture(page, `${variant.name}-${kind}-file-success-${scale}`);
        }
    }
}
