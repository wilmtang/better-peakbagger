// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import JSZip from 'jszip';
import { readFitMessages, fitTimestampToUnixMilliseconds } from './fit-message-reader.js';
import { MAX_GPX_TRACK_POINTS, MAX_GPX_TRACK_SEGMENTS } from '../capture/capture-resource-limits.js';

export const FIT_MAX_BYTES = 8 * 1024 * 1024;
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});
const fields = { 0: [0], 18: [5, 6], 20: [0, 1, 2, 78], 21: [0, 1], 34: [1] };
const failure = () => new Error('This recording is damaged or uses an unsupported FIT format. Try exporting GPX from Garmin.');
const scalar = (message, number, type, width, signed = false) => {
    const field = message.fields.find(f => f.fieldNumber === number);
    if (!field) return null;
    if ((field.baseType & 31) !== type || field.size !== width) throw failure();
    const view = new DataView(field.bytes.buffer, field.bytes.byteOffset, field.bytes.byteLength);
    const value = signed ? view.getInt32(0, message.littleEndian) : width === 1 ? view.getUint8(0)
        : width === 2 ? view.getUint16(0, message.littleEndian) : view.getUint32(0, message.littleEndian);
    return value === (signed ? 0x7fffffff : width === 1 ? 0xff : width === 2 ? 0xffff : 0xffffffff) ? null : value;
};

// Route order is wire order. Missing GPS and timer/session boundaries end a
// segment. Multisport recordings require explicit per-session handling first.
export function decodeFitActivity(bytes) {
    const segments = []; let segment = []; let count = 0; let sessions = 0; let activities = 0;
    const flush = () => { if (segment.length) segments.push(segment); segment = []; };
    readFitMessages(bytes, { maxInputBytes: FIT_MAX_BYTES, messageNumbers: Object.keys(fields).map(Number), fields,
        onMessage(message) {
            const n = message.globalMessageNumber;
            if (n === 0 && scalar(message, 0, 0, 1) !== 4) throw failure();
            if (n === 18) { if (++sessions > 1) throw new Error('Multisport recordings are not supported. Import each activity separately as GPX.'); flush(); }
            if (n === 34 && ++activities > 1) throw failure();
            if (n === 21 && scalar(message, 0, 0, 1) === 0) flush();
            if (n !== 20) return;
            if (++count > MAX_GPX_TRACK_POINTS) throw new Error('This recording exceeds 100,000 points. Split it into shorter tracks.');
            const lat = scalar(message, 0, 5, 4, true), lon = scalar(message, 1, 5, 4, true);
            if (lat === null || lon === null || Math.abs(lat * 180 / 2 ** 31) > 90 || Math.abs(lon * 180 / 2 ** 31) > 180) { flush(); return; }
            const altitude = scalar(message, 78, 6, 4) ?? scalar(message, 2, 4, 2);
            segment.push({ lat: lat * 180 / 2 ** 31, lon: lon * 180 / 2 ** 31,
                ele: altitude === null ? null : altitude / 5 - 500,
                time: message.timestamp === undefined ? null : fitTimestampToUnixMilliseconds(message.timestamp) });
            if (segments.length >= MAX_GPX_TRACK_SEGMENTS) throw new Error('This recording has too many separate route segments.');
        } });
    flush();
    return { segments, waypoints: [] };
}

// ZIP metadata and actual output have separate limits. Stream inflation rather
// than trusting advertised sizes; no archive path is ever written to disk.
export async function decodeGarminRecording(bytes, { signal } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length > FIT_MAX_BYTES) throw failure();
    signal?.throwIfAborted();
    if (bytes[8] === 46 && bytes[9] === 70 && bytes[10] === 73 && bytes[11] === 84) return decodeFitActivity(bytes);
    // Reject ZIP64, split archives and excessive directories before JSZip
    // allocates per-entry objects. An activity archive has one recording.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0 || end < bytes.length - 65557 || view.getUint16(end + 4, true) !== 0
        || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 10, true) > 4
        || end + 22 + view.getUint16(end + 20, true) !== bytes.length) throw failure();
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    if (entries.length !== 1 || !/\.fit$/i.test(entries[0].name)) throw new Error('This activity does not contain one supported FIT recording. Use Garmin’s GPX export instead.');
    const entry = entries[0];
    if (entry._data?.uncompressedSize > FIT_MAX_BYTES) throw failure();
    const chunks = []; let size = 0; let crc = 0xffffffff;
    await new Promise((resolve, reject) => {
        const stream = entry.internalStream('uint8array');
        const abort = () => { stream.pause(); signal?.removeEventListener('abort', abort); reject(failure()); };
        signal?.addEventListener('abort', abort, { once: true });
        stream.on('data', chunk => {
            size += chunk.length;
            if (size > FIT_MAX_BYTES || signal?.aborted) { abort(); return; }
            for (const byte of chunk) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 255];
            chunks.push(chunk);
        }).on('error', error => { signal?.removeEventListener('abort', abort); reject(error); })
            .on('end', () => { signal?.removeEventListener('abort', abort); resolve(); }).resume();
    });
    signal?.throwIfAborted();
    if (((crc ^ 0xffffffff) | 0) !== (entry._data.crc32 | 0)) throw failure();
    const fit = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { fit.set(chunk, offset); offset += chunk.length; }
    return decodeFitActivity(fit); // FIT framing/header/data CRC checked here.
}
