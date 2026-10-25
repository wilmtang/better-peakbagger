// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bound decoded dimensions before createImageBitmap allocates pixel memory.
export function validateCustomRaster(bytes, type, size) {
    const view = new DataView(bytes), data = new Uint8Array(bytes);
    const ascii = offset => String.fromCharCode(...data.slice(offset, offset + 4));
    const accept = (width, height) => { if (width !== height || ![size, size * 2].includes(width)) throw new Error('Unexpected tile dimensions.'); };
    if (/^image\/png(?:;|$)/i.test(type)) {
        if (data.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || ascii(12) !== 'IHDR') throw new Error('Invalid PNG tile.');
        accept(view.getUint32(16), view.getUint32(20)); return;
    }
    if (/^image\/jpeg(?:;|$)/i.test(type)) {
        if (data.length < 4 || view.getUint16(0) !== 0xffd8) throw new Error('Invalid JPEG tile.');
        for (let position = 2; position + 3 < data.length;) {
            if (data[position++] !== 255) break;
            while (data[position] === 255) position++;
            const marker = data[position++];
            if ([0xd9, 0xda].includes(marker)) break;
            if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue;
            if (position + 2 > data.length) break;
            const length = view.getUint16(position); if (length < 2 || position + length > data.length) break;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
                accept(view.getUint16(position + 5), view.getUint16(position + 3)); return;
            }
            position += length;
        }
        throw new Error('Invalid JPEG tile.');
    }
    if (!/^image\/webp(?:;|$)/i.test(type) || data.length < 20 || ascii(0) !== 'RIFF' || ascii(8) !== 'WEBP') throw new Error('Expected a PNG, JPEG or WebP tile.');
    let found = false;
    const uint24 = offset => data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
    for (let position = 12; position + 8 <= data.length;) {
        const chunk = ascii(position), length = view.getUint32(position + 4, true), offset = position + 8;
        if (offset + length > data.length) throw new Error('Invalid WebP tile.');
        if (chunk === 'ANIM' || chunk === 'ANMF') throw new Error('Animated tiles are unsupported.');
        if (chunk === 'VP8X' && length >= 10) accept(1 + uint24(offset + 4), 1 + uint24(offset + 7));
        if (chunk === 'VP8L' && length >= 5 && data[offset] === 0x2f) { const bits = view.getUint32(offset + 1, true); accept(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff)); found = true; }
        if (chunk === 'VP8 ' && length >= 10 && data[offset + 3] === 0x9d && data[offset + 4] === 1 && data[offset + 5] === 0x2a) { accept(view.getUint16(offset + 6, true) & 0x3fff, view.getUint16(offset + 8, true) & 0x3fff); found = true; }
        position = offset + length + (length % 2);
    }
    if (!found) throw new Error('Invalid WebP tile.');
}
