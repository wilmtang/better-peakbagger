// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// @browser-origin https://options.test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Files from '../../src/favorites/climber-files.ts';
import { FixtureDom } from '../helpers/fixture-dom.mts';
import { waitFor } from '../helpers/fixture-page.mts';
import { mountClimberFileTransfer } from '../../options/climber-files.ts';
import { createFavoritesStore } from '../../src/background/favorites-store.ts';
import { createIgnoredStore } from '../../src/background/ignored-store.ts';

const entry = (cid: number) => ({ cid, name: `Climber ${cid}`, addedAt: 1, source: 'manual' });
type ListKind = 'favorites' | 'ignored';
type Entry = ReturnType<typeof entry>;
const list = (kind: ListKind, entries: Entry[]) => ({ schemaVersion: 1, ...(kind === 'ignored' ? { revision: 0 } : {}), entries });
const settle = (predicate: () => unknown) => waitFor({ window }, predicate);

for (const kind of ['favorites', 'ignored'] as const) {
    test(`${kind} file round-trip is bounded, allowlisted, and rejects the other list even when empty`, () => {
        const original = list(kind, [entry(1)]);
        const text = Files.serializeListFile(kind, { ...original, token: 'excluded', device: 'excluded' });
        assert.equal(Files.parseListFile(kind, text).entries[0].cid, 1);
        assert.doesNotMatch(text, /excluded/);
        assert.throws(() => Files.parseListFile(kind, Files.serializeListFile(kind === 'favorites' ? 'ignored' : 'favorites', list(kind === 'favorites' ? 'ignored' : 'favorites', []))));
        assert.throws(() => Files.parseListFile(kind, ' '.repeat(Files.MAX_BYTES + 1)));
        assert.throws(() => Files.readStoredList(kind, { schemaVersion: 99, entries: [] }));
        const malformed = JSON.parse(text); malformed.entries.push(malformed.entries[0]);
        assert.throws(() => Files.parseListFile(kind, JSON.stringify(malformed)));
        malformed.entries = Array.from({ length: 1501 }, (_, index) => entry(index + 1));
        assert.throws(() => Files.parseListFile(kind, JSON.stringify(malformed)));
    });

    test(`${kind} import previews without writing and refreshes stale review before guarded replacement`, async t => {
        const dom = new FixtureDom('<div id="root"></div>', { url: 'https://options.test' }); t.after(() => dom.window.close());
        const root = dom.window.document.getElementById('root'), key = Files.listKey(kind)!;
        const values: Record<string, ReturnType<typeof list>> = { [key]: list(kind, [entry(1)]) };
        const storage = { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(name => [name, values[name]])),
            set: async (patch: Record<string, ReturnType<typeof list>>) => { Object.assign(values, patch); } };
        const store = kind === 'favorites' ? createFavoritesStore({ storage }) : createIgnoredStore({ storage });
        let messages = 0, held: Promise<void> | undefined;
        const api = { storage: { local: storage }, runtime: { sendMessage: async (message: { mutation: never }) => {
            messages++; if (held) await held;
            return store.mutate(message.mutation);
        } } };
        mountClimberFileTransfer({ root, kind, api });
        const input = root.querySelector('input'), confirm = root.querySelector('[data-file-action="confirm"]');
        Object.defineProperty(input, 'files', { value: [new Blob([Files.serializeListFile(kind, list(kind, [entry(2)]))])], configurable: true });
        input.dispatchEvent(new dom.window.Event('change'));
        await settle(() => !root.hasAttribute('aria-busy'));
        assert.equal(messages, 0); assert.equal(root.querySelector('.climber-file-preview').hidden, false);
        assert.match(root.textContent, /1 added, 1 removed/);
        values[key] = list(kind, [entry(1), entry(3)]);
        confirm.click(); await settle(() => !root.hasAttribute('aria-busy'));
        assert.match(root.textContent, /This list changed/);
        assert.equal(values[key]!.entries.length, 2);
        const other = kind === 'favorites' ? 'ignored' : 'favorites';
        values[Files.listKey(other)!] = list(other, [entry(2)]);
        confirm.click(); await settle(() => !root.hasAttribute('aria-busy'));
        assert.match(root.textContent, /Review your lists before importing/);
        assert.deepEqual(values[key]!.entries.map(item => item.cid), [1, 3], 'file import cannot bypass list membership rules');
        values[Files.listKey(other)!] = list(other, []);
        let release!: () => void; held = new Promise<void>(resolve => { release = resolve; });
        confirm.focus(); confirm.click(); confirm.click();
        assert.equal(messages, 3, 'busy confirmation cannot submit twice');
        assert.equal(dom.window.document.activeElement, confirm);
        release(); await settle(() => !root.hasAttribute('aria-busy'));
        assert.deepEqual(values[key]!.entries.map(item => item.cid), [2]);
        assert.equal(root.querySelector('.climber-file-preview').hidden, true);
        assert.match(root.textContent, /List imported/);
    });
}

test('legacy GitHub favorites files remain usable without a kind field', () => {
    assert.equal(Files.parseListFile('favorites', JSON.stringify(list('favorites', [entry(1)]))).entries.length, 1);
});

test('file replacement enters its confirmation so Escape cancels and restores the trigger', async t => {
    const dom = new FixtureDom('<div id="root"></div>', { url: 'https://options.test' }); t.after(() => dom.window.close());
    const root = dom.window.document.getElementById('root');
    mountClimberFileTransfer({ root, kind: 'favorites', api: {
        storage: { local: { get: async () => ({ bpbFavoriteClimbers: list('favorites', []) }) } },
        runtime: { sendMessage: async () => { throw new Error('No write expected'); } },
    } });
    const trigger = root.querySelector('[data-file-action="import"]'); trigger.focus();
    const input = root.querySelector('input');
    Object.defineProperty(input, 'files', { value: [new Blob([Files.serializeListFile('favorites', list('favorites', [entry(2)]))])] });
    input.dispatchEvent(new dom.window.Event('change'));
    await settle(() => !root.hasAttribute('aria-busy'));
    assert.equal(dom.window.document.activeElement.dataset.fileAction, 'cancel');
    dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(root.querySelector('.climber-file-preview').hidden, true);
    assert.equal(dom.window.document.activeElement, trigger);
});
