import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { fixtures, matches } from '../../docs/plans/experiments/fit-decoders/fixtures.mjs';
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
