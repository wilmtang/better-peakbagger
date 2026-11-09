// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { waitForCondition } from './browser-verification-fixtures.mjs';

export interface ImageDownloadIo {
    list(directory: string): Promise<string[]>;
    read(file: string): Promise<Buffer>;
}
const filesystem: ImageDownloadIo = { list: directory => readdir(directory), read: file => readFile(file) };
type DownloadState = { state: 'pending'; reason: string; name?: string; bytes?: number }
    | { state: 'error'; error: unknown } | { state: 'ready'; name: string; bytes: Buffer };
// The legacy JavaScript helper infers BooleanConstructor from its default;
// its runtime accepts the custom readiness predicate used here.
const pollDownload = waitForCondition as unknown as (read: () => Promise<DownloadState>, options: {
    timeoutMs: number; description: string; isReady(value: DownloadState): boolean;
}) => Promise<DownloadState>;

// Completion markers supplement the existing format/title assertions. They do
// not decode the image or establish full image integrity.
function terminalImage(bytes: Buffer) {
    return bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
        || bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
        && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

export async function probeImageDownload(directory: string, io = filesystem): Promise<DownloadState> {
    try {
        const names = await io.list(directory);
        // This is a fresh owned directory with one expected image export.
        if (names.some(name => name.endsWith('.part'))) return { state: 'pending', reason: 'partial file' };
        let pending: DownloadState = { state: 'pending', reason: 'missing image' };
        for (const name of names.filter(value => /-topo\.(png|jpg)$/.test(value))) {
            let bytes: Buffer;
            try { bytes = await io.read(path.join(directory, name)); }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
                throw error;
            }
            if (terminalImage(bytes)) return { state: 'ready', name, bytes };
            pending = { state: 'pending', reason: 'incomplete image', name, bytes: bytes.length };
        }
        return pending;
    } catch (error) { return { state: 'error', error }; }
}

export async function waitForImageDownload(directory: string, io = filesystem) {
    // Return fatal errors as settled data so the generic polling helper cannot
    // catch and retry permissions/directory failures until the timeout.
    const result = await pollDownload(() => probeImageDownload(directory, io), {
        timeoutMs: 15_000, description: 'the completed Firefox Export image download',
        isReady: (value: DownloadState) => value.state !== 'pending',
    });
    if (result.state === 'error') throw result.error;
    if (result.state !== 'ready') throw new Error('Image download did not settle');
    return result;
}
