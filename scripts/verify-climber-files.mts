/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, location */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import * as Files from '../src/favorites/climber-files.ts';

export interface ClimberFilesVariant {
    name: string;
    theme: string;
    [field: string]: unknown;
}

export interface VerifyClimberFilesOptions {
    capture: (page: Page, name: string) => Promise<unknown>;
}

interface ClimberFileEntry {
    cid: number;
    name: string;
    addedAt: number;
    source: string;
}

interface ClimberFileValues {
    bpbFavoriteClimbers: { schemaVersion: number; entries: ClimberFileEntry[] };
    bpbIgnoredClimbers: { schemaVersion: number; revision: number; entries: ClimberFileEntry[] };
}

interface ClimberFileMessage {
    type: string;
    mutation: {
        favorites?: ClimberFileValues['bpbFavoriteClimbers'];
        entries?: ClimberFileEntry[];
    };
}

interface ClimberFileGlobals {
    __calls: string[];
    __finish: ((response: { ok: boolean; error?: { code: string; message: string } }) => Promise<void> | void) | null;
    chrome: unknown;
}

type RectBox = { x: number; y: number; width: number; height: number };
type FilesSnapshot = Record<'action' | 'panel' | 'heading' | 'following', RectBox> & { scroll: number };

// Shipped manager and native file downloads; storage/worker replies are held
// fixtures. The store tests separately exercise the real mutation guards.
export async function verifyClimberFiles(
    page: Page,
    origin: string,
    variant: ClimberFilesVariant,
    { capture }: VerifyClimberFilesOptions,
): Promise<void> {
    await page.addInitScript(({ theme }: { theme: string }) => {
        const settings = { theme, favoritesSource: 'custom' };
        const entry = (cid: number): ClimberFileEntry => ({ cid, name: `Climber ${cid}`, addedAt: 1, source: 'manual' });
        const values: ClimberFileValues = {
            bpbFavoriteClimbers: { schemaVersion: 1, entries: [entry(1)] },
            bpbIgnoredClimbers: { schemaVersion: 1, revision: 0, entries: [entry(3)] },
        };
        const listeners: ((changes: Record<string, { newValue: unknown }>, areaName: string) => void)[] = [];
        const local = {
            get: async () => structuredClone(values),
            set: async (patch: Partial<ClimberFileValues>) => {
                Object.assign(values, patch);
                for (const listener of listeners) {
                    listener(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), 'local');
                }
            },
            remove: async () => {},
        };
        const globals = globalThis as unknown as ClimberFileGlobals;
        globals.__calls = [];
        globals.chrome = {
            storage: {
                local,
                sync: { get: async () => ({ bpbSettings: settings }) },
                onChanged: { addListener: (listener: (changes: Record<string, { newValue: unknown }>, areaName: string) => void) => listeners.push(listener), removeListener() {} },
            },
            runtime: {
                id: 'fixture',
                getManifest: () => ({ version: '4.0.2' }),
                getURL: (file: string) => new URL(`/dist/${file}`, location.origin).href,
                sendMessage: async (message: ClimberFileMessage) => {
                    globals.__calls.push(message.type);
                    if (['FAVORITES_MUTATE', 'IGNORED_MUTATE'].includes(message.type)) {
                        return new Promise(resolve => {
                            globals.__finish = async response => {
                                globals.__finish = null;
                                if (response.ok) {
                                    const key = message.type === 'FAVORITES_MUTATE' ? 'bpbFavoriteClimbers' : 'bpbIgnoredClimbers';
                                    await local.set({
                                        [key]: message.mutation.favorites
                                            || {
                                                schemaVersion: 1,
                                                revision: (values[key] as { revision: number }).revision + 1,
                                                entries: message.mutation.entries ?? [],
                                            },
                                    });
                                }
                                resolve(response);
                            };
                        });
                    }
                    return { ok: true };
                },
            },
        };
    }, variant);
    await page.goto(`${origin}/dist/options/favorites.html`);
    await page.locator('#favorites-count').filter({ hasText: '1 favorite' }).waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const settle = () => page.evaluate(() => new Promise<number>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    for (const kind of ['favorites', 'ignored'] as const) {
        await page.locator(`#${kind}-tab`).press('Enter');
        const root = page.locator(`[data-climber-files="${kind}"]`);
        const preview = root.locator('.climber-file-preview');
        const confirm = root.locator('[data-file-action="confirm"]');
        const exportButton = root.locator('[data-file-action="export"]');
        await root.scrollIntoViewIfNeeded();
        const downloadPromise = page.waitForEvent('download');
        await exportButton.press('Enter');
        const download = await downloadPromise;
        const exported = Files.parseListFile(kind, await readFile((await download.path())!, 'utf8'));
        assert.equal(exported.entries.length, 1);
        assert.match(download.suggestedFilename(), new RegExp(`better-peakbagger-${kind}-.*\\.json$`));
        await download.delete();
        for (const scale of [1, 2]) {
            await page.addStyleTag({ content: `[data-climber-files] button, [data-climber-files] p { font-size:${14 * scale}px !important; }` });
            const entries = [{ cid: kind === 'favorites' ? 2 : 4, name: 'A climber with a deliberately long display name', addedAt: 2, source: 'manual' }];
            const replacement = { schemaVersion: 1, revision: 0, entries };
            await page.evaluate(() => { (globalThis as unknown as ClimberFileGlobals).__calls = []; });
            const importButton = root.locator('[data-file-action=import]');
            await importButton.focus();
            const file = {
                name: `${kind}.json`,
                mimeType: 'application/json',
                buffer: Buffer.from(Files.serializeListFile(kind, replacement)),
            };
            await root.locator('input[type=file]').setInputFiles(file);
            await preview.waitFor();
            assert(await root.locator('[data-file-action=cancel]').evaluate(element => document.activeElement === element));
            await root.locator('[data-file-action=cancel]').press('Escape');
            assert(await preview.isHidden());
            assert(await importButton.evaluate(element => document.activeElement === element));
            await root.locator('input[type=file]').setInputFiles(file);
            await preview.waitFor();
            assert.deepEqual(
                await page.evaluate(() => (globalThis as unknown as ClimberFileGlobals).__calls),
                [],
                'file preview does not mutate or contact GitHub',
            );
            await confirm.scrollIntoViewIfNeeded();
            await confirm.focus();
            await settle();
            const snapshot = (): Promise<FilesSnapshot> => root.evaluate((element): FilesSnapshot => {
                const rect = (node: Element | null): RectBox => {
                    const { x, y, width, height } = node!.getBoundingClientRect();
                    return { x, y, width, height };
                };
                return {
                    action: rect(element.querySelector('[data-file-action=confirm]')),
                    panel: rect(element),
                    heading: rect(document.querySelector('.head')),
                    following: rect(document.querySelector('.status-dock')),
                    scroll: document.querySelector('.content')!.scrollTop,
                };
            });
            const before = await snapshot();
            const stable = async (label: string) => {
                await settle();
                const after = await snapshot();
                for (const name of ['action', 'panel', 'heading', 'following'] as const) {
                    for (const key of ['x', 'y', 'width', 'height'] as const) {
                        assert.ok(Math.abs(before[name][key] - after[name][key]) <= 1, `${kind} ${scale}x ${label}: ${name}.${key} shifted`);
                    }
                }
                assert.ok(Math.abs(before.scroll - after.scroll) <= 1, `${kind} ${scale}x ${label}: reading position`);
                assert.equal(await confirm.evaluate(element => document.activeElement === element), true, `${kind} ${scale}x ${label}: focus`);
            };
            for (const error of [
                { code: 'storage', message: 'A failed local write' },
                { code: 'list-conflict', message: `${'Long climber name '.repeat(20)}: Remove from favorites before ignoring.` },
                { code: 'stale', message: 'Changed elsewhere' },
            ]) {
                const previous = await page.evaluate(() => (globalThis as unknown as ClimberFileGlobals).__calls.length);
                await confirm.press('Enter');
                await page.waitForFunction(() => typeof (globalThis as unknown as ClimberFileGlobals).__finish === 'function');
                await page.keyboard.press('Enter');
                await page.keyboard.press('Space');
                assert.equal(await page.evaluate(() => (globalThis as unknown as ClimberFileGlobals).__calls.length), previous + 1);
                await stable('pending');
                await page.evaluate(pendingError => (globalThis as unknown as ClimberFileGlobals).__finish!({ ok: false, error: pendingError }), error);
                await root.locator('[role=status]').filter({ hasText: /Try again|Review your lists|Review the updated counts/ }).waitFor();
                await page.waitForFunction(targetKind => !document.querySelector(`[data-climber-files="${targetKind}"]`)!.hasAttribute('aria-busy'), kind);
                await stable(error.code);
            }
            await capture(page, `${variant.name}-${kind}-file-retry-${scale}`);
            await confirm.press('Enter');
            await page.waitForFunction(() => typeof (globalThis as unknown as ClimberFileGlobals).__finish === 'function');
            await page.evaluate(() => (globalThis as unknown as ClimberFileGlobals).__finish!({ ok: true }));
            await preview.waitFor({ state: 'hidden' });
            await root.locator('[role=status]').filter({ hasText: 'List imported.' }).waitFor();
            await page.locator(`#${kind}-list`).filter({ hasText: entries[0].name }).waitFor();
            assert.equal(await root.locator('[data-file-action=import]').evaluate(element => document.activeElement === element), true);
            assert.equal(await root.locator('[data-file-action=confirm]').isVisible(), false, 'hidden preview cannot expose a clickable confirmation');
            assert.ok(
                (await page.evaluate(() => (globalThis as unknown as ClimberFileGlobals).__calls))
                    .every(type => ['FAVORITES_MUTATE', 'IGNORED_MUTATE'].includes(type)),
            );
            await capture(page, `${variant.name}-${kind}-file-success-${scale}`);
        }
    }
}
