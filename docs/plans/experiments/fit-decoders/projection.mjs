// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Evaluation projection only: not a complete activity/segment adapter.
const epoch = 631065600000;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function projectRaw(result) {
    return result.messages.filter(message => message.globalMessageNumber === 20).map(message => {
        const scalar = (number, type, width, signed = false) => {
            const field = message.fields.find(field => field.fieldNumber === number);
            if (!field) return null;
            if ((field.baseType & 31) !== type || field.size !== width) throw new Error('Unexpected route field shape');
            const view = new DataView(field.bytes.buffer, field.bytes.byteOffset, field.bytes.byteLength);
            const value = signed ? view.getInt32(0, message.littleEndian)
                : width === 2 ? view.getUint16(0, message.littleEndian) : view.getUint32(0, message.littleEndian);
            return value === (signed ? 0x7fffffff : width === 2 ? 0xffff : 0xffffffff) ? null : value;
        };
        const lat = scalar(0, 5, 4, true);
        const lon = scalar(1, 5, 4, true);
        const altitude = scalar(78, 6, 4) ?? scalar(2, 4, 2);
        return { lat: lat === null ? null : lat * 180 / 2 ** 31,
            lon: lon === null ? null : lon * 180 / 2 ** 31,
            ele: altitude === null ? null : altitude / 5 - 500,
            time: message.timestamp === undefined ? null : epoch + message.timestamp * 1000 };
    });
}
export function projectSemantic(records) {
    return records.map(record => ({ lat: finite(record.position_lat), lon: finite(record.position_long),
        ele: finite(record.enhanced_altitude) ?? finite(record.altitude),
        time: record.timestamp instanceof Date && Number.isFinite(+record.timestamp) ? +record.timestamp : null }));
}
export function summarize(points) {
    return { records: points.length,
        gps: points.filter(p => p.lat !== null && p.lon !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180).length,
        elevation: points.filter(p => p.ele !== null).length, timestamps: points.filter(p => p.time !== null).length };
}
export function compare(a, b) {
    if (a.length !== b.length) return { lengthMismatch: [a.length, b.length] };
    const mismatches = { lat: 0, lon: 0, ele: 0, time: 0 };
    const maxDifference = { lat: 0, lon: 0, ele: 0, time: 0 };
    for (let i = 0; i < a.length; i++) for (const key of Object.keys(mismatches)) {
        const x = a[i][key]; const y = b[i][key];
        if (x === null || y === null) { if (x !== y) mismatches[key]++; }
        else {
            const difference = Math.abs(x - y);
            maxDifference[key] = Math.max(maxDifference[key], difference);
            if (difference > (key === 'lat' || key === 'lon' ? 1e-7 : 1e-6)) mismatches[key]++;
        }
    }
    return { mismatches, maxDifference };
}
