// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent, tiny wire fixtures; does not use either candidate's encoder.
export const epoch = 631065600000;
export function crc(bytes) {
    let value = 0;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xa001 : 0);
    }
    return value;
}
const join = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
const word = (value, size, little = true) => {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (size === 1) view.setUint8(0, value);
    else if (size === 2) view.setUint16(0, value, little);
    else view.setUint32(0, value, little);
    return bytes;
};
const fields = [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84], [78, 4, 0x86]];
function definition(local, message, layout, little = true, developer = false) {
    return join([0x40 | local | (developer ? 0x20 : 0), 0, little ? 0 : 1],
        word(message, 2, little), [layout.length], layout.flat(), developer ? [1, 0, 3, 0] : []);
}
function record(local, values, layout = fields, little = true, developer = false) {
    return join([local], ...values.map((value, i) => word(value, layout[i][1], little)), developer ? [7, 8, 9] : []);
}
const fileId = join(definition(15, 0, [[0, 1, 0]]), [15, 4]);
function file(body, headerSize = 14, zeroHeaderCrc = false) {
    body = join(fileId, body);
    const header = join([headerSize, 0x20], word(2147, 2), word(body.length, 4), [46, 70, 73, 84]);
    const prefix = headerSize === 14 ? join(header, word(zeroHeaderCrc ? 0 : crc(header), 2), body) : join(header, body);
    return join(prefix, word(crc(prefix), 2));
}
function repair(bytes) {
    const out = bytes.slice();
    const view = new DataView(out.buffer);
    if (out[0] === 14) view.setUint16(12, crc(out.subarray(0, 12)), true);
    view.setUint16(out.length - 2, crc(out.subarray(0, -2)), true);
    return out;
}
// Exact integer semicircles, predictable times and disagreeing ordinary/enhanced altitude.
const values = [1000000030, 0x20000000, -0x40000000, 3000, 7500];
const point = { lat: 45, lon: -90, ele: 1000, time: epoch + values[0] * 1000 };
const normalBody = join(definition(0, 20, fields), record(0, values));
export function fixtures() {
    const base = file(normalBody);
    const cases = [];
    const good = (name, bytes, expected) => cases.push({ name, bytes, expected });
    const bad = (name, bytes) => cases.push({ name, bytes, reject: true });
    good('ordinary-enhanced-altitude', base, [point]);
    good('12-byte-header', file(normalBody, 12), [point]);
    good('zero-header-crc', file(normalBody, 14, true), [point]);
    good('big-endian', file(join(definition(0, 20, fields, false), record(0, values, fields, false))), [point]);
    good('mixed-endian-definitions', file(join(definition(0, 20, fields),
        definition(1, 20, fields, false), record(0, values), record(1, values, fields, false))), [point, point]);
    good('developer-and-unknown-fields', file(join(definition(0, 20, [...fields, [99, 2, 0x84]], true, true),
        record(0, [...values, 1234], [...fields, [99, 2, 0x84]], true, true))), [point]);
    good('invalid-enhanced-falls-back', file(join(definition(0, 20, fields),
        record(0, [...values.slice(0, 4), 0xffffffff]))), [{ ...point, ele: 100 }]);
    good('invalid-gps-keeps-gap', file(join(definition(0, 20, fields), record(0, values),
        record(0, [values[0] + 1, 0x7fffffff, 0x7fffffff, 0xffff, 0xffffffff]), record(0, values))),
    [point, { lat: null, lon: null, ele: null, time: point.time + 1000 }, point]);
    good('indoor-no-gps', file(join(definition(0, 20, [fields[0]]), record(0, [values[0]], [fields[0]]))),
        [{ lat: null, lon: null, ele: null, time: point.time }]);
    good('invalid-timestamp', file(join(definition(0, 20, fields), record(0, [0xffffffff, ...values.slice(1)]))),
        [{ ...point, time: null }]);
    good('compressed-declared-rollover', file(join(normalBody, record(0x80 | 1, values.slice(1), fields.slice(1)))),
        [point, { ...point, time: point.time + 3000 }]);
    // Garmin's online protocol Figure 10 also documents a separate definition without timestamp.
    good('compressed-omitted-rollover', file(join(normalBody, definition(1, 20, fields.slice(1)),
        record(0xa0 | 1, values.slice(1), fields.slice(1)))), [point, { ...point, time: point.time + 3000 }]);
    const corrupted = base.slice(); corrupted[corrupted.length - 3] ^= 1;
    bad('bad-data-crc', corrupted);
    const badHeader = base.slice(); badHeader[12] ^= 1;
    new DataView(badHeader.buffer).setUint16(badHeader.length - 2, crc(badHeader.subarray(0, -2)), true);
    bad('bad-header-crc', badHeader);
    bad('truncated-crc', base.slice(0, -1));
    const signature = base.slice(); signature[8] = 33;
    bad('wrong-signature-valid-crc', repair(signature));
    const length = base.slice(); new DataView(length.buffer).setUint32(4, length.length + 100, true);
    bad('declared-length-too-large', repair(length));
    bad('undefined-local-message', file([1, 1, 2, 3]));
    bad('invalid-field-width', file(join(definition(0, 20, [[0, 3, 0x85]]), [0, 1, 2, 3])));
    bad('reserved-header-bit', file(join(definition(0, 20, fields), record(0x10, values))));
    bad('concatenated-files-policy', join(base, base));
    bad('trailing-byte', join(base, [0]));
    return cases;
}

export function matches(actual, expected) {
    return actual.length === expected.length && expected.every((point, i) =>
        Object.keys(point).every(key => point[key] === null ? actual[i][key] === null
            : Number.isFinite(actual[i][key]) && Math.abs(actual[i][key] - point[key]) < 1e-7));
}
