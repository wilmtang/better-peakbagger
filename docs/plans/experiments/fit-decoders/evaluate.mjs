// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Research harness. Dependencies/corpus/output live in a caller-owned temporary directory.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { crc, fixtures, matches } from './fixtures.mjs';
import { projectRaw, projectSemantic, summarize, compare } from './projection.mjs';

export const candidates = ['raw', 'full', 'decoder'];
export async function loadCandidate(root, candidate) {
    const modulePath = candidate === 'decoder' ? 'fit-decoder/dist/index.js'
        : candidate === 'raw' ? 'fit-file-parser/dist/raw-message-reader.js' : 'fit-file-parser/dist/fit-parser.js';
    const module = await import(pathToFileURL(path.join(root, 'node_modules', modulePath)));
    if (candidate === 'raw') return bytes => projectRaw(module.readFitMessages(bytes, {
        messageNumbers: [0, 18, 19, 20, 21, 34], maxInputBytes: 8 * 1024 * 1024,
    }));
    if (candidate === 'full') return async bytes => projectSemantic((await new module.default({ force: false, strict: true }).parseAsync(bytes)).records ?? []);
    return bytes => projectSemantic(module.default.parseRecords(module.default.fit2json(bytes)).records
        .filter(record => record.type === 'record').map(record => record.data));
}

if (!isMainThread) {
    // Keep candidate diagnostics out of logs, particularly for a later private in-memory probe.
    console.log = () => {};
    const decode = await loadCandidate(workerData.root, workerData.candidate);
    try {
        const start = performance.now();
        const points = await decode(workerData.bytes.buffer);
        parentPort.postMessage({ ok: true, points, ms: performance.now() - start });
    } catch (error) {
        parentPort.postMessage({ ok: false, error: String(error.message ?? error).slice(0, 180) });
    }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    assert.equal(process.argv.length, 3, 'Usage: node evaluate.mjs /absolute/temporary-evaluation-root');
    const root = path.resolve(process.argv[2]);
    assert.equal(crc(new TextEncoder().encode('123456789')), 0xbb3d, 'CRC-16 known check vector');
    const testCases = fixtures();
    assert.equal(testCases.length, 22);
    const report = { date: '2026-10-23', versions: {}, synthetic: [], corpus: [] };
    for (const name of ['fit-file-parser', 'fit-decoder']) {
        report.versions[name] = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'))).version;
    }
    assert.equal(report.versions['fit-file-parser'], '6.2.3');
    assert.equal(report.versions['fit-decoder'], '1.0.5');
    async function isolated(candidate, bytes) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { root, candidate, bytes },
            resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
        worker.stdout.resume(); worker.stderr.resume();
        let timer;
        try {
            return await new Promise(resolve => {
                timer = setTimeout(() => resolve({ ok: false, error: '5-second worker timeout' }), 5000);
                worker.once('message', resolve);
                worker.once('error', error => resolve({ ok: false, error: error.message }));
                worker.once('exit', code => resolve({ ok: false, error: `Worker exited before result: ${code}` }));
            });
        } finally { clearTimeout(timer); await worker.terminate(); }
    }
    for (const fixture of testCases) {
        const row = { name: fixture.name, expected: fixture.reject ? 'reject' : 'exact route values' };
        for (const candidate of candidates) {
            const result = await isolated(candidate, fixture.bytes);
            row[candidate] = { ok: result.ok, pass: fixture.reject ? !result.ok : result.ok && matches(result.points, fixture.expected),
                ...(result.ok ? { summary: summarize(result.points) } : { error: result.error }) };
        }
        report.synthetic.push(row);
        console.log(`${row.name}: ${candidates.map(c => `${c}=${row[c].pass ? 'PASS' : 'FAIL'}`).join(' ')}`);
    }
    const manifest = JSON.parse(await readFile(path.join(root, 'corpus-manifest.json')));
    assert(manifest.length > 0, 'No public corpus cases');
    for (const item of manifest) {
        const buffer = await readFile(path.join(root, 'corpus', item.file));
        const bytes = new Uint8Array(buffer); // exact, standalone allocation
        const row = { file: item.file, bytes: bytes.length };
        const results = {};
        for (const candidate of candidates) {
            results[candidate] = await isolated(candidate, bytes);
            const { points, ...result } = results[candidate];
            row[candidate] = { ...result, ...(points ? { summary: summarize(points) } : {}) };
        }
        if (results.raw.ok && results.full.ok) row.rawVsFull = compare(results.raw.points, results.full.points);
        if (results.raw.ok && results.decoder.ok) row.rawVsDecoder = compare(results.raw.points, results.decoder.points);
        report.corpus.push(row);
        console.log(`${item.file}: ${candidates.map(c => `${c}=${row[c].ok ? row[c].summary.records : row[c].error}`).join(' ')}`);
    }
    await writeFile(path.join(root, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log('Aggregate results saved; no coordinates or original FIT data included.');
}
