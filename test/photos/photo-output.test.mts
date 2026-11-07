// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clipboardImageSupported, downloadBlob, exportFileName, finishState, FILE_NAME_MAX_BYTES,
    writeImageToClipboard, NOTES,
} from '../../src/photos/photo-output.ts';
import type { FinishInput } from '../../src/photos/photo-output.ts';

const state = (input: Partial<FinishInput>) => finishState({ context: 'standalone', keyMode: 'none', remoteState: 'draft', ...input });

test('the entry context, not the key, decides the primary action and the order', () => {
    for (const keyMode of ['none', 'device', 'tab'] as const) {
        const standalone = state({ keyMode });
        assert.equal(standalone.exportEmphasis, 'primary');
        assert.equal(standalone.slot.emphasis, 'quiet');
        assert.equal(standalone.uploadFirst, true);
        const report = state({ context: 'report-insert', keyMode });
        assert.equal(report.exportEmphasis, 'secondary');
        assert.equal(report.slot.emphasis, 'primary');
        assert.equal(report.uploadFirst, false);
    }
});

test('only a missing key adds the ellipsis, and the reserved width covers every label', () => {
    for (const context of ['standalone', 'report-insert', 'report-replace'] as const) {
        const without = state({ context });
        const withKey = state({ context, keyMode: 'device' });
        assert.equal(without.slot.label, `${withKey.slot.label}…`);
        assert.equal(without.slot.sizingLabel, withKey.slot.sizingLabel);
        for (const remoteState of ['draft', 'uploaded', 'outcome-unknown']) {
            for (const insertionConfirmed of [false, true]) {
                const { slot } = state({ context, remoteState, insertionConfirmed });
                assert.ok(slot.label.length <= slot.sizingLabel.length, `${context}/${remoteState}: ${slot.label}`);
            }
        }
    }
    assert.equal(state({ context: 'report-replace', keyMode: 'device' }).slot.label, 'Upload and replace');
    assert.equal(state({ pendingKey: true }).slot.label, 'Upload to ImgBB', 'a held key counts as available');
});

test('published photos offer the link, and Inserted appears only after a confirmed insertion', () => {
    assert.deepEqual(state({ remoteState: 'uploaded' }).slot.kind, 'copy-link');
    assert.equal(state({ context: 'report-insert', remoteState: 'uploaded' }).slot.label, 'Copy link');
    const inserted = state({ context: 'report-insert', remoteState: 'uploaded', insertionConfirmed: true });
    assert.equal(inserted.slot.kind, 'status');
    assert.equal(inserted.slot.label, 'Inserted');
    assert.equal(state({ remoteState: 'uploaded', insertionConfirmed: true }).slot.kind, 'copy-link',
        'a standalone session has no report to have inserted into');
});

test('a pasted report photo saves and returns, then reports that it did', () => {
    assert.equal(state({ context: 'local' }).slot.label, 'Save and return');
    const returned = state({ context: 'local', localReturned: true });
    assert.equal(returned.slot.kind, 'status');
    assert.equal(returned.slot.label, 'Saved to report');
    assert.equal(returned.note, null);
});

test('an unresolved upload demotes the slot and outranks every other note', () => {
    const unresolved = state({ context: 'report-insert', remoteState: 'outcome-unknown', keyMode: 'none', overGithubLimit: true });
    assert.equal(unresolved.slot.emphasis, 'secondary');
    assert.equal(unresolved.note?.kind, 'outcome-unknown');
    assert.equal(unresolved.note?.text, NOTES['outcome-unknown']);
    assert.equal(state({ context: 'report-insert', overGithubLimit: true }).note?.kind, 'needs-host');
    assert.equal(state({ context: 'report-insert', keyMode: 'device', overGithubLimit: true }).note?.kind, 'github-size');
    assert.equal(state({ keyMode: 'none', overGithubLimit: true }).note, null, 'the GitHub size warning is report-only');
    assert.equal(state({ keyMode: 'tab' }).note?.kind, 'tab-key');
    assert.equal(state({ keyMode: 'tab', pendingKey: true }).note, null, 'no tab-only note while a key waits to be saved');
    assert.equal(state({ remoteState: 'uploading', uploadInFlight: true }).note, null,
        "this tab's own upload in progress is not an unknown outcome");
    assert.equal(state({ remoteState: 'uploading' }).note?.kind, 'outcome-unknown',
        'an upload left running by another tab or a crash is');
    const ownUpload = state({ context: 'report-insert', keyMode: 'device', remoteState: 'uploading', uploadInFlight: true });
    assert.equal(ownUpload.slot.emphasis, 'primary', "this tab's own upload keeps the pressed button as it was");
    assert.equal(state({ context: 'report-insert', keyMode: 'device', remoteState: 'uploading' }).slot.emphasis, 'secondary');
});

test('export names keep the title readable and safe on every file system', () => {
    assert.equal(exportFileName('Mount Hood — North Face', 'image/png'), 'Mount-Hood-—-North-Face-topo.png');
    assert.equal(exportFileName('雪山 / 北壁', 'image/jpeg'), '雪山-北壁-topo.jpg');
    assert.equal(exportFileName('  ', 'image/png'), 'photo-topo.png');
    assert.equal(exportFileName(null, 'image/jpeg'), 'photo-topo.jpg');
    assert.equal(exportFileName('CON', 'image/png'), 'CON-topo.png', 'CON-topo is not a device name');
    assert.equal(exportFileName('con.x', 'image/png'), 'photo-topo.png', 'Windows reads the part before the first dot');
    assert.equal(exportFileName('aux', 'image/png'), 'aux-topo.png');
    assert.equal(exportFileName('trailing dots...', 'image/png'), 'trailing-dots-topo.png');
    assert.equal(exportFileName('a:b*c?"d<e>f|g\u0001h', 'image/png'), 'a-b-c-d-e-f-g-h-topo.png');
    const long = exportFileName('山'.repeat(300), 'image/png');
    assert.ok(new TextEncoder().encode(long).length <= FILE_NAME_MAX_BYTES);
    assert.match(long, /^山+-topo\.png$/, 'clamping never splits a character');
});

test('the clipboard write starts before the encode settles', async () => {
    let resolveEncode!: (blob: Blob) => void;
    const writes: unknown[] = [];
    class FakeItem { items: Record<string, Promise<Blob> | Blob>; constructor(items: Record<string, Promise<Blob> | Blob>) { this.items = items; } }
    const written = writeImageToClipboard({
        encode: () => new Promise<Blob>(resolve => { resolveEncode = resolve; }),
        clipboard: { write: async items => { writes.push(items); } },
        ClipboardItemCtor: FakeItem as unknown as new (items: Record<string, Promise<Blob> | Blob>) => ClipboardItem,
    });
    assert.equal(writes.length, 1, 'write() ran synchronously, inside the click');
    const [[item]] = writes as FakeItem[][];
    assert.deepEqual(Object.keys(item.items), ['image/png']);
    resolveEncode(new Blob(['png'], { type: 'image/png' }));
    await written;
    assert.equal((await item.items['image/png']).type, 'image/png');
});

test('a failed encode rejects the write without an unhandled rejection', async () => {
    class FakeItem { items: Record<string, Promise<Blob>>; constructor(items: Record<string, Promise<Blob>>) { this.items = items; } }
    const failure = writeImageToClipboard({
        encode: () => Promise.reject(new Error('encode failed')),
        clipboard: { write: async ([item]) => { await (item as unknown as FakeItem).items['image/png']; } },
        ClipboardItemCtor: FakeItem as unknown as new (items: Record<string, Promise<Blob> | Blob>) => ClipboardItem,
    });
    await assert.rejects(failure, /encode failed/);
});

test('clipboard support needs both ClipboardItem and clipboard.write', () => {
    const Item = class {} as unknown as new (items: Record<string, Promise<Blob> | Blob>) => ClipboardItem;
    assert.equal(clipboardImageSupported({ clipboard: { write: async () => {} }, ClipboardItemCtor: Item }), true);
    assert.equal(clipboardImageSupported({ clipboard: { write: async () => {} }, ClipboardItemCtor: undefined }), false);
    assert.equal(clipboardImageSupported({ clipboard: undefined, ClipboardItemCtor: Item }), false);
});

test('a download clicks a detached link and revokes its URL later', () => {
    const events: string[] = [];
    let scheduled: (() => void) | null = null;
    const link = {
        href: '', download: '', rel: '', hidden: false,
        click: () => events.push(`click ${link.download}`),
        remove: () => events.push('remove'),
    };
    downloadBlob({
        blob: new Blob(['x']), fileName: 'peak-topo.png',
        documentImpl: { createElement: () => link, body: { append: () => events.push('append') } } as unknown as Document,
        URLImpl: { createObjectURL: () => 'blob:1', revokeObjectURL: (url: string) => events.push(`revoke ${url}`) } as unknown as typeof URL,
        setTimeoutImpl: ((callback: () => void) => { scheduled = callback; return 0; }) as unknown as typeof setTimeout,
    });
    assert.deepEqual(events, ['append', 'click peak-topo.png', 'remove']);
    assert.equal(link.href, 'blob:1');
    (scheduled as unknown as () => void)();
    assert.deepEqual(events.at(-1), 'revoke blob:1');
});
