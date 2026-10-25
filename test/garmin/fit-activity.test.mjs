import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { fixtures, matches, crc } from '../../docs/plans/experiments/fit-decoders/fixtures.mjs';
import { readFitMessages } from '../../src/garmin/fit-message-reader.js';
import { projectRaw } from '../../docs/plans/experiments/fit-decoders/projection.mjs';
import { decodeFitActivity, decodeGarminRecording } from '../../src/garmin/fit-activity.js';

for (const fixture of fixtures()) test(`strict FIT: ${fixture.name}`, () => {
    const read = () => projectRaw(readFitMessages(fixture.bytes, { messageNumbers: [0, 18, 20, 21, 34], maxInputBytes: 8 * 1024 * 1024 }));
    if (fixture.reject) assert.throws(read);
    else assert(matches(read(), fixture.expected));
});
test('ZIP import projects only narrow fields and validates CRC', async () => {
    const fixture = fixtures().find(f => !f.reject && f.expected.length > 0);
    const expected = decodeFitActivity(fixture.bytes);
    const zip = new JSZip(); zip.file('nested/activity.fit', fixture.bytes);
    assert.deepEqual(await decodeGarminRecording(await zip.generateAsync({ type: 'uint8array' })), expected);
    assert.deepEqual(Object.keys(expected), ['segments', 'waypoints']);
    const corrupt = fixture.bytes.slice(); corrupt[corrupt.length - 3] ^= 1;
    assert.throws(() => decodeFitActivity(corrupt));
    zip.file('second.fit', fixture.bytes);
    await assert.rejects(decodeGarminRecording(await zip.generateAsync({ type: 'uint8array' })), /one supported/);
});
test('recording rejects oversized input and cancellation', async () => {
    await assert.rejects(decodeGarminRecording(new Uint8Array(8 * 1024 * 1024 + 1)));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(decodeGarminRecording(new Uint8Array(20), { signal: controller.signal }));
});

test('timer events break geometry, multisport is explicit, and ZIP CRC is checked independently', async () => {
    const fixture = fixtures().find(f => f.name === 'ordinary-enhanced-altitude');
    const { crc } = await import('../../docs/plans/experiments/fit-decoders/fixtures.mjs');
    const append = extra => {
        const source = fixture.bytes, header = source[0], end = source.length - 2;
        const out = new Uint8Array(source.length + extra.length); out.set(source.subarray(0, end)); out.set(extra, end);
        const view = new DataView(out.buffer); view.setUint32(4, out.length - header - 2, true);
        if (header === 14) view.setUint16(12, crc(out.subarray(0, 12)), true);
        view.setUint16(out.length - 2, crc(out.subarray(0, -2)), true); return out;
    };
    const lastRecord = fixture.bytes.slice(-21, -2);
    const event = [0x41, 0, 0, 21, 0, 2, 0, 1, 0, 1, 1, 0, 1, 0, 1];
    const route = decodeFitActivity(append([...event, ...lastRecord]));
    assert.equal(route.segments.length, 2, 'Timer stop cannot join the route across a pause');
    const session = [0x42, 0, 0, 18, 0, 1, 5, 1, 0, 2, 17];
    assert.throws(() => decodeFitActivity(append([...session, ...session])), /Multisport/);
    const zip = new JSZip(); zip.file('activity.fit', fixture.bytes);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const central = bytes.findIndex((value, i) => value === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2);
    bytes[central + 16] ^= 1;
    await assert.rejects(decodeGarminRecording(bytes), /damaged/);
});

test('FIT course points retain only permitted waypoint fields and respect opt-out', async () => {
    const fixture = fixtures().find(f => f.name === 'ordinary-enhanced-altitude');
    const { crc } = await import('../../docs/plans/experiments/fit-decoders/fixtures.mjs');
    // Independent wire definition: timestamp, semicircle lat/lon, type, name.
    const extra = Uint8Array.from([0x43, 0, 0, 32, 0, 5, 1, 4, 0x86, 2, 4, 0x85, 3, 4, 0x85, 5, 1, 0, 6, 6, 7,
        3, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 80, 101, 97, 107, 0, 0]);
    const bytes = new Uint8Array(fixture.bytes.length + extra.length);
    bytes.set(fixture.bytes.subarray(0, -2)); bytes.set(extra, fixture.bytes.length - 2);
    const view = new DataView(bytes.buffer); view.setUint32(4, bytes.length - bytes[0] - 2, true);
    if (bytes[0] === 14) view.setUint16(12, crc(bytes.subarray(0, 12)), true);
    view.setUint16(bytes.length - 2, crc(bytes.subarray(0, -2)), true);
    assert.deepEqual(decodeFitActivity(bytes).waypoints, [{ lat: 0, lon: 0, name: 'Peak' }]);
    assert.deepEqual(decodeFitActivity(bytes, { retainWaypoints: false }).waypoints, []);
    assert.equal(decodeFitActivity(bytes).segments.flat().length, 1, 'Course points do not become track points');
});

const reframe = body => {
    const source = fixtures().find(f => f.name === 'ordinary-enhanced-altitude').bytes;
    const out = new Uint8Array(source[0] + body.length + 2); out.set(source.subarray(0, source[0])); out.set(body, source[0]);
    const view = new DataView(out.buffer); view.setUint32(4, body.length, true);
    view.setUint16(12, crc(out.subarray(0, 12)), true);
    view.setUint16(out.length - 2, crc(out.subarray(0, -2)), true); return out;
};
test('activity projection requires a file_id even when record geometry and CRCs are valid', () => {
    const source = fixtures().find(f => f.name === 'ordinary-enhanced-altitude').bytes;
    // Independent fixture starts with the 9-byte file_id definition and 2-byte data.
    assert.throws(() => decodeFitActivity(reframe(source.subarray(source[0] + 11, -2))), /damaged/);
});
test('compressed waypoint timestamps do not discard an otherwise valid activity', () => {
    const source = fixtures().find(f => f.name === 'ordinary-enhanced-altitude').bytes;
    const waypoint = [0x41, 0, 0, 32, 0, 3, 2, 4, 0x85, 3, 4, 0x85, 6, 6, 7,
        0xa1, 0, 0, 0, 0, 0, 0, 0, 0, 80, 101, 97, 107, 0, 0];
    const bytes = reframe(Uint8Array.from([...source.subarray(source[0], -2), ...waypoint]));
    const result = decodeFitActivity(bytes);
    assert.equal(result.segments.flat().length, 1);
    assert.deepEqual(result.waypoints, [{ lat: 0, lon: 0, name: 'Peak' }]);
    assert.deepEqual(decodeFitActivity(bytes, { retainWaypoints: false }).waypoints, []);
});
test('cancellation during ZIP inflation preserves the caller abort reason', async () => {
    const fixture = fixtures().find(f => f.name === 'ordinary-enhanced-altitude');
    const zip = new JSZip(); zip.file('activity.fit', fixture.bytes);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const controller = new AbortController(), reason = new DOMException('Import cancelled', 'AbortError');
    const load = JSZip.loadAsync; let chunks = 0;
    JSZip.loadAsync = async (...args) => {
        const archive = await load(...args), entry = archive.files['activity.fit'];
        const internalStream = entry.internalStream.bind(entry);
        entry.internalStream = (...options) => {
            const stream = internalStream(...options);
            stream.on('data', () => { chunks++; controller.abort(reason); });
            return stream;
        };
        return archive;
    };
    try {
        await assert.rejects(decodeGarminRecording(bytes, { signal: controller.signal }), error => error === reason);
        assert.equal(chunks, 1, 'Cancellation occurs after actual decompression starts');
    } finally { JSZip.loadAsync = load; }
});
