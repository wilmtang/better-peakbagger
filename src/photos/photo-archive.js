// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — CSP-safe stored-ZIP writer and reader for project bundles.
//
// The reader is the return leg of Download project. It only understands what
// the writer produces — stored (uncompressed) ZIP32 entries — because accepting
// deflate would mean shipping a decompressor, and a bundle this extension did
// not write is not a bundle it can promise to reopen.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_UINT32 = 0xffffffff;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
// One original up to ImgBB's 32 MiB ceiling, plus its metadata and headers.
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 16;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ORIGINAL_MIMES = Object.freeze({
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
});

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

class ArchiveError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ArchiveError';
    }
}

// The end-of-central-directory record is the only fixed landmark in a ZIP, and
// it sits behind a comment of up to 64 KiB, so it is found by scanning back.
const findEndRecord = view => {
    const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
    for (let index = view.byteLength - 22; index >= earliest; index -= 1) {
        if (view.getUint32(index, true) === END_SIGNATURE) return index;
    }
    return -1;
};

const readStoredZip = async blob => {
    if (!(blob instanceof Blob)) throw new TypeError('photo archive reading requires a blob');
    if (blob.size === 0 || blob.size > MAX_ARCHIVE_BYTES) {
        throw new ArchiveError('That file is empty or larger than a project bundle can be.');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.byteLength < 22 ? -1 : findEndRecord(view);
    if (end < 0) throw new ArchiveError('That file is not a Better Peakbagger project bundle.');

    const count = view.getUint16(end + 10, true);
    if (count === 0 || count > MAX_ARCHIVE_ENTRIES) {
        throw new ArchiveError('That project bundle does not hold the expected files.');
    }
    let cursor = view.getUint32(end + 16, true);
    const entries = new Map();
    for (let index = 0; index < count; index += 1) {
        if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
            throw new ArchiveError('That project bundle is damaged.');
        }
        const method = view.getUint16(cursor + 10, true);
        const crc = view.getUint32(cursor + 16, true);
        const size = view.getUint32(cursor + 24, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);
        if (method !== 0) {
            throw new ArchiveError(
                'That project bundle is compressed. Import the .bpb-photo file '
                + 'Better Peakbagger downloaded, not a re-zipped copy.',
            );
        }
        let name;
        try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
        catch { throw new ArchiveError('That project bundle is damaged.'); }
        if (!SAFE_NAME.test(name) || entries.has(name)) {
            throw new ArchiveError('That project bundle names a file it should not.');
        }
        if (localOffset + 30 > bytes.byteLength
            || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
            throw new ArchiveError('That project bundle is damaged.');
        }
        const dataStart = localOffset + 30
            + view.getUint16(localOffset + 26, true)
            + view.getUint16(localOffset + 28, true);
        if (dataStart + size > bytes.byteLength) {
            throw new ArchiveError('That project bundle is damaged.');
        }
        const data = bytes.subarray(dataStart, dataStart + size);
        if (crc32(data) !== crc) throw new ArchiveError('That project bundle failed its checksum.');
        entries.set(name, data);
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
};

const readJsonEntry = (entries, name) => {
    const data = entries.get(name);
    if (!data) throw new ArchiveError(`That project bundle is missing ${name}.`);
    try { return JSON.parse(decoder.decode(data)); }
    catch { throw new ArchiveError(`That project bundle's ${name} is unreadable.`); }
};

// Returns the archive verbatim. Every field still has to survive the project
// and catalog cleaners before it reaches storage — this only gets it out of the
// container.
const readProjectArchive = async blob => {
    const entries = await readStoredZip(blob);
    const project = readJsonEntry(entries, 'project.json');
    const photo = readJsonEntry(entries, 'photo.json');
    const originalName = [...entries.keys()].find(name => /^original\.[a-z0-9]+$/.test(name));
    const extension = originalName?.split('.')[1];
    if (!originalName || !ORIGINAL_MIMES[extension]) {
        throw new ArchiveError('That project bundle is missing its original image.');
    }
    const declared = typeof photo?.source?.mime === 'string' && /^image\//.test(photo.source.mime)
        ? photo.source.mime
        : ORIGINAL_MIMES[extension];
    return {
        project,
        photo,
        original: new Blob([entries.get(originalName)], { type: declared }),
    };
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
    ArchiveError,
    MAX_ARCHIVE_BYTES,
    crc32,
    createStoredZip,
    createProjectArchive,
    readStoredZip,
    readProjectArchive,
};
