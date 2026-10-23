import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { patchJsZipCsp, jsZipCspPlugin } from '../../scripts/jszip-csp-patch.mjs';
import { fixtures } from '../../docs/plans/experiments/fit-decoders/fixtures.mjs';
import { decodeFitActivity } from '../../src/garmin/fit-activity.js';

test('browser ZIP decoding works with dynamic code disabled and rejects string callbacks', async () => {
    const built = await build({ entryPoints: ['src/garmin/fit-activity.js'], bundle: true, write: false,
        platform: 'browser', format: 'iife', globalName: 'Decoder', plugins: [jsZipCspPlugin()] });
    const code = built.outputFiles[0].text;
    assert(!/new Function\(/.test(code));
    const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, setTimeout, clearTimeout,
        performance, AbortController }, { codeGeneration: { strings: false, wasm: false } });
    context.self = context;
    vm.runInContext(code, context);
    const fixture = fixtures().find(item => item.name === 'ordinary-enhanced-altitude');
    const zip = new JSZip(); zip.file('activity.fit', fixture.bytes);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const actual = await context.Decoder.decodeGarminRecording(bytes);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), decodeFitActivity(fixture.bytes));
    assert.throws(() => context.setImmediate('throw new Error("must never run")'), /must be functions/);
});
test('scheduler patch fails closed on dependency drift', async () => {
    const source = await readFile('node_modules/jszip/dist/jszip.min.js', 'utf8');
    assert.throws(() => patchJsZipCsp(source, 'future'), /Review/);
    assert.throws(() => patchJsZipCsp(source + source, '3.10.2'), /Review/);
});
