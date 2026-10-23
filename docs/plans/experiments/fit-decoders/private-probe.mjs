// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit, manual, read-only private probe. Key comes from stdin, never argv/a file.
// Original archives, FIT bytes, tokens and routes remain in process memory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadCandidate, candidates } from './evaluate.mjs';
import { compare, summarize } from './projection.mjs';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
assert.equal(process.argv.length, 3, 'Usage: node private-probe.mjs /temporary-evaluation-root (key on stdin)');
const root = path.resolve(process.argv[2]);
const base = 'https://personal.connectapi.garmin.com';
const limit = 8 * 1024 * 1024;
async function bounded(response) {
    if (!response.ok) throw new Error(`Garmin HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error('Response exceeds probe byte limit');
            chunks.push(value);
        }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks, size);
}
let key; let token;
try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write('Waiting for the authorized Garmin key on stdin; input echo is disabled.\n');
    key = await new Promise((resolve, reject) => {
        let input = '';
        const timer = setTimeout(() => finish(new Error('Key input timeout')), 60000);
        const onData = chunk => {
            input += chunk.toString();
            if (input.includes('\u0003') || input.length > 2048) finish(new Error('Input cancelled'));
            else if (/[\r\n]/.test(input)) finish(null, input.trim());
        };
        const finish = (error, value) => {
            clearTimeout(timer); process.stdin.off('data', onData); process.stdin.pause(); input = '';
            if (error) reject(error); else resolve(value);
        };
        process.stdin.on('data', onData); process.stdin.resume();
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    const exchange = await fetch(`${base}/personalapitoken-service/personal-api/personal-api-key/token`, {
        method: 'POST', headers: { Authorization: `ApiKey ${key}`, Accept: '*/*' },
        redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    key = null;
    token = (await bounded(exchange)).toString().trim();
    async function get(url) {
        return bounded(await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` },
            redirect: 'error', signal: AbortSignal.timeout(20000) }));
    }
    const report = [];
    for (const [sample, order] of [['recent', 'desc'], ['oldest', 'asc']]) {
        const list = JSON.parse((await get(`/activitylist-service/activities/search/activities?start=0&limit=1&sortOrder=${order}&sortBy=startLocal`)).toString());
        assert(Array.isArray(list) && list.length === 1, 'Expected one activity');
        const activityId = list[0].activityId;
        assert(Number.isSafeInteger(activityId) && activityId > 0, 'Expected numeric activity ID');
        const zipBytes = await get(`/download-service/files/activity/${activityId}`);
        const archive = await JSZip.loadAsync(zipBytes);
        const entries = Object.values(archive.files).filter(entry => !entry.dir);
        assert(entries.length === 1 && /\.fit$/i.test(entries[0].name), 'Expected one FIT file');
        // JSZip exposes ZIP advertised sizes in _data; actual streaming bytes are independently capped.
        assert(entries[0]._data.uncompressedSize <= limit, 'Inflated size exceeds probe limit');
        const chunks = []; let size = 0;
        await new Promise((resolve, reject) => {
            const stream = entries[0].internalStream('uint8array');
            stream.on('data', chunk => {
                size += chunk.length;
                if (size > limit) { stream.pause(); reject(new Error('Actual inflated bytes exceed limit')); }
                else chunks.push(chunk);
            }).on('error', reject).on('end', resolve).resume();
        });
        const fit = Buffer.concat(chunks, size);
        const bytes = fit.buffer.slice(fit.byteOffset, fit.byteOffset + fit.byteLength);
        const results = {}; const row = { sample, fitBytes: size };
        const log = console.log;
        console.log = () => {};
        try {
            for (const candidate of candidates) {
                const decode = await loadCandidate(root, candidate);
                try {
                    results[candidate] = await decode(bytes);
                    row[candidate] = { ok: true, summary: summarize(results[candidate]) };
                } catch { row[candidate] = { ok: false }; }
            }
        } finally { console.log = log; }
        if (results.raw && results.full) row.rawVsFull = compare(results.raw, results.full);
        if (results.raw && results.decoder) row.rawVsDecoder = compare(results.raw, results.decoder);
        report.push(row);
    }
    process.stdout.write(`${JSON.stringify({ privateSamples: report }, null, 2)}\n`);
} catch (error) {
    // Do not print URLs, response bodies, candidate records, or credential-bearing objects.
    process.stderr.write(`Private probe failed (${error.name}); no private payload was logged.\n`);
    process.exitCode = 1;
} finally {
    key = null; token = null;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
}
