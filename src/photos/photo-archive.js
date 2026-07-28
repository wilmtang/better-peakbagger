// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — CSP-safe stored-ZIP writer for downloadable projects.

const encoder = new TextEncoder();
const MAX_UINT32 = 0xffffffff;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

const crc32 = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};

const cleanDate = value => {
    const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
};

const bytesFrom = async value => {
    if (typeof value === 'string') return encoder.encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    throw new TypeError('photo archive entries must be text, bytes, or blobs');
};

const header = (size, fill) => {
    const bytes = new Uint8Array(size);
    fill(new DataView(bytes.buffer));
    return bytes;
};

const localHeader = entry => header(30, view => {
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, entry.time, true);
    view.setUint16(12, entry.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, entry.nameBytes.length, true);
    view.setUint16(28, 0, true);
});

const centralHeader = entry => header(46, view => {
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, entry.time, true);
    view.setUint16(14, entry.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.bytes.length, true);
    view.setUint32(24, entry.bytes.length, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, entry.offset, true);
});

const endRecord = ({ entries, centralSize, centralOffset }) => header(22, view => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entries, true);
    view.setUint16(10, entries, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
});

const createStoredZip = async (values, { modifiedAt = new Date() } = {}) => {
    if (!Array.isArray(values) || values.length === 0 || values.length > 0xffff) {
        throw new TypeError('photo archive requires a bounded entry list');
    }
    const timestamp = cleanDate(modifiedAt);
    const names = new Set();
    const entries = [];
    let offset = 0;
    for (const value of values) {
        const name = typeof value?.name === 'string' && SAFE_NAME.test(value.name)
            ? value.name
            : null;
        if (!name || names.has(name)) throw new TypeError('photo archive requires unique safe file names');
        names.add(name);
        const bytes = await bytesFrom(value.data);
        const nameBytes = encoder.encode(name);
        if (bytes.length > MAX_UINT32 || offset + 30 + nameBytes.length + bytes.length > MAX_UINT32) {
            throw new RangeError('photo archive exceeds the ZIP32 limit');
        }
        const entry = {
            nameBytes,
            bytes,
            crc: crc32(bytes),
            offset,
            ...timestamp,
        };
        entries.push(entry);
        offset += 30 + nameBytes.length + bytes.length;
    }

    const localParts = entries.flatMap(entry => [localHeader(entry), entry.nameBytes, entry.bytes]);
    const centralParts = entries.flatMap(entry => [centralHeader(entry), entry.nameBytes]);
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    if (offset + centralSize + 22 > MAX_UINT32) {
        throw new RangeError('photo archive exceeds the ZIP32 limit');
    }
    return new Blob([
        ...localParts,
        ...centralParts,
        endRecord({ entries: entries.length, centralSize, centralOffset: offset }),
    ], { type: 'application/zip' });
};

const projectExtension = mime => mime === 'image/png' ? 'png'
    : mime === 'image/webp' ? 'webp'
        : 'jpg';

const createProjectArchive = ({ project, photo, original, modifiedAt } = {}) => {
    if (!project || typeof project !== 'object' || !photo || typeof photo !== 'object'
        || !(original instanceof Blob)) {
        throw new TypeError('photo project archive requires project, photo, and original');
    }
    return createStoredZip([
        { name: 'project.json', data: `${JSON.stringify(project, null, 2)}\n` },
        { name: 'photo.json', data: `${JSON.stringify(photo, null, 2)}\n` },
        { name: `original.${projectExtension(original.type)}`, data: original },
    ], { modifiedAt });
};

export const photoArchive = {
    crc32,
    createStoredZip,
    createProjectArchive,
};
