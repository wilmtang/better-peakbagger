// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, location */
import assert from 'node:assert/strict';
import { settingsTransfer } from '../src/settings/settings-transfer.js';

// Real shipped Settings with held worker replies; no credentials or remote writes.
export async function verifySettingsActions(page, origin, variant, { capture }) {
    await page.addInitScript(({ theme }) => {
        const settings = { theme, enableGithubBackup: true, enableReportEditor: true };
        const area = { get: async () => ({ bpbSettings: settings }), set: async () => {}, remove: async () => {} };
        const repo = { owner: 'fixture', name: 'backup', fullName: 'fixture/backup' };
        globalThis.__calls = 0;
        globalThis.chrome = {
            storage: { sync: area, local: area, session: area, onChanged: { addListener() {}, removeListener() {} } },
            permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
            runtime: { id: 'fixture', getManifest: () => ({ version: '4.0.2' }),
                getURL: file => new URL(`/dist/${file}`, location.origin).href,
                sendMessage: async message => {
                    const key = message.type + (message.action ? `:${message.action}` : '');
                    if (key === globalThis.__hold) {
                        globalThis.__calls++;
                        return new Promise(resolve => { globalThis.__finish = response => { globalThis.__finish = null; resolve(response); }; });
                    }
                    if (message.type === 'GITHUB_AUTH_STATUS') return { connected: true, hasToken: true, repo, account: { login: 'fixture' } };
                    if (message.type === 'GITHUB_IGNORED_LIST') return { ok: true, state: { enabled: false, phase: 'idle' }, count: 0 };
                    if (message.type === 'GITHUB_PHOTOS_STATUS') return { ok: true, connected: true, repo, state: null };
                    if (message.type === 'PHOTO_IMGBB_STATUS') return { ok: true, configured: true, permissionGranted: true };
                    if (message.type === 'SETTINGS_PATCH') { Object.assign(settings, message.patch); return { ok: true, settings }; }
                    return { ok: true, count: 0 };
                } },
        };
    }, variant);
    await page.goto(`${origin}/dist/options/options.html#github`);
    await page.locator('#photos-github-status').filter({ hasText: 'No photo-library backup' }).waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const cases = [
        ['#settings-backup-github-backup', 'GITHUB_SETTINGS_BACKUP'],
        ['#settings-backup-github-restore', 'GITHUB_SETTINGS_RESTORE'],
        ['#favorites-backup', 'GITHUB_FAVORITES_BACKUP'],
        ['#favorites-restore', 'GITHUB_FAVORITES_RESTORE'],
        ['#photos-backup', 'GITHUB_PHOTOS_BACKUP'],
        ['#photos-restore', 'GITHUB_PHOTOS_RESTORE_PREVIEW'],
        ['#ignored-backup', 'GITHUB_IGNORED_LIST:backup'],
        ['#ignored-restore', 'GITHUB_IGNORED_LIST:restore'],
        ['#imgbb-key-save', 'PHOTO_IMGBB_SAVE_KEY'],
        ['.github-history button', 'PEAKBAGGER_MY_ASCENTS'],
    ];
    const failures = [];
    const focus = async (selector, label) => {
        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        const active = await page.locator(selector).first().evaluate(element => document.activeElement === element);
        if (!active) failures.push(label);
    };
    for (const textScale of [1, 2]) {
        // Enlarged control text is additional coverage, not native browser zoom.
        await page.addStyleTag({ content: `button, input, select { font-size: ${14 * textScale}px !important; }` });
        for (const [selector, type] of cases) {
            await page.locator('#imgbb-key').fill('0123456789abcdef0123456789abcdef');
            const action = page.locator(selector);
            await action.scrollIntoViewIfNeeded();
            await page.evaluate(type => { globalThis.__hold = type; globalThis.__calls = 0; globalThis.__finish = null; }, type);
            await action.focus();
            const before = await action.boundingBox();
            const scroll = await page.locator('.content').evaluate(element => element.scrollTop);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finish === 'function');
            await focus(selector, `${selector} pending at ${textScale}x`);
            await page.keyboard.press('Enter');
            await page.keyboard.press('Space');
            assert.equal(await page.evaluate(() => globalThis.__calls), 1, `${selector}: no duplicate work`);
            const pending = await action.boundingBox();
            for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - pending[key]) <= 1, `${selector}: pending ${key}`);
            await page.evaluate(() => globalThis.__finish({ ok: false, error: { code: 'network', message: 'Connection unavailable. Try again.' } }));
            await page.waitForFunction(selector => !document.querySelector(selector).disabled
                && document.querySelector(selector).getAttribute('aria-disabled') !== 'true', selector);
            await focus(selector, `${selector} failed at ${textScale}x`);
            if (Math.abs(scroll - await page.locator('.content').evaluate(element => element.scrollTop)) > 1) failures.push(`${selector}: error reading position`);
            await page.locator('#status-error-dismiss').evaluate(button => { if (!button.closest('[hidden]')) button.click(); });
            // Retry while deliberately moving to another visible control. A
            // late completion may update status, but may not reclaim focus.
            await action.focus();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finish === 'function');
            const outside = page.locator('.nav-item').first();
            await outside.focus();
            await page.evaluate(() => globalThis.__finish({ ok: true, result: { repo: 'fixture/backup', signature: 'fixture' }, state: { enabled: false, phase: 'backed-up' } }));
            await page.waitForFunction(selector => !document.querySelector(selector).disabled
                && document.querySelector(selector).getAttribute('aria-disabled') !== 'true', selector);
            await focus('.nav-item', `${selector} completion respects moved focus at ${textScale}x`);
            await action.scrollIntoViewIfNeeded();
            if (selector === '#ignored-backup' || selector === '#imgbb-key-save') await capture(page, `${variant.name}-settings-${selector.slice(1)}-${textScale}`);
        }
    }
    // Removing a key intentionally removes its own action; continue at Save.
    await page.evaluate(() => { globalThis.__hold = 'PHOTO_IMGBB_REMOVE_KEY'; globalThis.__finish = null; });
    await page.locator('#imgbb-key-remove').press('Enter');
    await page.waitForFunction(() => typeof globalThis.__finish === 'function');
    await focus('#imgbb-key-remove', 'remove key pending focus');
    await page.evaluate(() => globalThis.__finish({ ok: true }));
    await page.locator('#imgbb-key-remove').waitFor({ state: 'hidden' });
    await focus('#imgbb-key-save', 'remove key continues at Save');
    const settings = { theme: variant.theme, enableGithubBackup: true, enableReportEditor: true };
    const restores = [
        { trigger: '#settings-backup-github-restore', read: 'GITHUB_SETTINGS_RESTORE',
            reply: { ok: true, content: settingsTransfer.serialize(settingsTransfer.buildPayload(settings,
                { extensionVersion: '4.0.2', exportedAt: '2026-10-22T12:00:00Z' })) },
            panel: '#settings-backup-confirmation', confirm: '#settings-backup-confirm', write: 'SETTINGS_PATCH',
            result: { ok: true, settings } },
        { trigger: '#photos-restore', read: 'GITHUB_PHOTOS_RESTORE_PREVIEW',
            reply: { ok: true, signature: 'fixture', remotePhotos: 1, remoteTombstones: 0, counts: { update: 1 }, conflicts: [] },
            panel: '#photos-restore-confirmation', confirm: '#photos-restore-confirm', write: 'GITHUB_PHOTOS_RESTORE', result: { ok: true } },
        { trigger: '#favorites-restore', read: 'GITHUB_FAVORITES_RESTORE',
            reply: { ok: true, content: JSON.stringify({ schemaVersion: 1, exportedAt: '2026-10-22T12:00:00Z', entries: [] }) },
            panel: '#favorites-restore-confirmation', confirm: '#favorites-restore-confirm', write: 'FAVORITES_MUTATE',
            result: { ok: true, favorites: { schemaVersion: 1, entries: [] }, signature: 'fixture' } },
        { trigger: '#ignored-restore', read: 'GITHUB_IGNORED_LIST:restore',
            reply: { ok: true, preview: { id: 'fixture', kind: 'restore', local: [], remote: [], base: [], conflicts: [] } },
            panel: '#ignored-review', confirm: '#ignored-review-confirm', write: 'GITHUB_IGNORED_LIST:confirm',
            result: { ok: true, state: { enabled: false, phase: 'restored' } } },
    ];
    for (const item of restores) {
        await page.evaluate(type => { globalThis.__hold = type; globalThis.__finish = null; }, item.read);
        await page.locator(item.trigger).press('Enter');
        await page.waitForFunction(() => typeof globalThis.__finish === 'function');
        await page.evaluate(reply => globalThis.__finish(reply), item.reply);
        await page.locator(item.panel).waitFor();
        for (const success of [false, true]) {
            await page.evaluate(type => { globalThis.__hold = type; globalThis.__calls = 0; globalThis.__finish = null; }, item.write);
            await page.locator(item.confirm).press('Enter');
            await page.waitForFunction(() => typeof globalThis.__finish === 'function');
            await focus(item.confirm, `${item.confirm}: pending confirmation focus`);
            await page.keyboard.press('Enter');
            await page.keyboard.press('Space');
            assert.equal(await page.evaluate(() => globalThis.__calls), 1, `${item.confirm}: one confirmed write`);
            if (success) await page.locator('.nav-item').first().focus();
            await page.evaluate(reply => globalThis.__finish(reply), success ? item.result : { ok: false, error: { code: 'network' } });
            if (success) {
                await page.locator(item.panel).waitFor({ state: 'hidden' });
                await focus('.nav-item', `${item.confirm}: completion respects moved focus`);
            } else {
                await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-busy') !== 'true', item.panel);
                await focus(item.confirm, `${item.confirm}: error retains retry focus`);
            }
        }
    }
    assert.deepEqual(failures, [], 'settings async focus defects');
}
