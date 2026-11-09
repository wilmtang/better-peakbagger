// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { repeatVerification, verificationRepetitions } from '../../scripts/verification-repetitions.mjs';
import {
    extractArchive, packageArguments, prepareChromeArchive, verifyPackageRepetitions,
    type PackageVerificationOptions,
} from '../../scripts/verify-packaged-extensions.mts';

test('verification repetitions are bounded and every requested run must pass', async () => {
    for (const value of ['0', '6', '3.0', '', String(NaN)]) assert.throws(() => verificationRepetitions(value), /integer/);
    const calls: number[] = [];
    await repeatVerification(async (attempt: number) => { calls.push(attempt); }, 3);
    assert.deepEqual(calls, [1, 2, 3]);
    calls.length = 0;
    await assert.rejects(repeatVerification(async (attempt: number) => {
        calls.push(attempt);
        if (attempt === 2) throw new Error('real assertion failure');
    }, 3), /real assertion failure/);
    assert.deepEqual(calls, [1, 2], 'a failed repetition cannot be retried into a green result');
});

test('package CLI keeps the two-archive default and strictly selects one browser', () => {
    assert.deepEqual(packageArguments(['chrome.zip', 'firefox.zip']), {
        chromeArchive: path.resolve('chrome.zip'), firefoxArchive: path.resolve('firefox.zip'),
    });
    assert.equal(packageArguments(['chrome.zip', 'firefox.zip', '--browser', 'firefox']).browser, 'firefox');
    for (const args of [[], ['chrome.zip'], ['chrome.zip', 'firefox.zip', 'chrome'],
        ['chrome.zip', 'firefox.zip', '--browser', 'missing'],
        ['chrome.zip', 'firefox.zip', '--browser', 'chrome', '--browser', 'firefox'],
        ['chrome.zip', 'firefox.zip', '--browser'], ['--browser', 'chrome'],
        ['chrome.zip', 'firefox.zip', '--browsers', 'chrome']]) assert.throws(() => packageArguments(args), /Usage/);
});

test('selected-browser repetitions hash both archives and finish fresh extraction cleanup before passing', async () => {
    const calls: string[][] = [];
    let changed = false;
    let prepared = 0;
    let disposed = 0;
    const options: PackageVerificationOptions = {
        chromeArchive: 'chrome.zip', firefoxArchive: 'firefox.zip', count: 3,
        read: async file => `${file}:${changed ? 'changed' : 'original'}`,
        execute: async (script, source) => { calls.push([script, source]); },
        prepareChrome: async () => {
            assert.equal(prepared, disposed, 'last extraction cleanup must finish before another starts');
            const source = `extracted-${++prepared}`;
            return { source, dispose: async () => { disposed++; } };
        },
    };
    await verifyPackageRepetitions(options);
    assert.deepEqual(calls, Array.from({ length: 3 }, (_, index) => [
        ['verify-extension.mts', `extracted-${index + 1}`], ['verify-firefox-extension.mts', 'firefox.zip'],
    ]).flat());
    assert.equal(disposed, 3);
    calls.length = 0;
    await verifyPackageRepetitions({ ...options, browser: 'firefox' });
    assert.deepEqual(calls, Array.from({ length: 3 }, () => ['verify-firefox-extension.mts', 'firefox.zip']));
    assert.equal(prepared, 3, 'Firefox must not extract or launch Chrome');
    calls.length = 0;
    await verifyPackageRepetitions({ ...options, browser: 'chrome' });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(([script]) => script === 'verify-extension.mts'));
    assert.equal(disposed, 6);
    calls.length = 0;
    await assert.rejects(verifyPackageRepetitions({ ...options, execute: async script => {
        calls.push([script]); changed = true;
    } }), /bytes changed/);
    assert.equal(calls.length, 1, 'changed bytes must stop verification before the next browser');
    assert.equal(disposed, 7, 'a tampered run still cleans its extraction');
});

test('failure or cleanup failure stops at the first repetition without a passed marker', async t => {
    const markers: string[] = [];
    t.mock.method(console, 'log', (...values: unknown[]) => { markers.push(values.join(' ')); });
    for (const cleanupFailure of [false, true]) {
        let prepared = 0;
        let disposed = 0;
        const calls: string[] = [];
        await assert.rejects(verifyPackageRepetitions({
            chromeArchive: 'chrome.zip', firefoxArchive: 'firefox.zip', count: 3, browser: 'chrome',
            read: async file => file,
            prepareChrome: async () => ({ source: `root-${++prepared}`, dispose: async () => {
                disposed++;
                if (cleanupFailure) throw new Error('cleanup failure');
            } }),
            execute: async script => {
                calls.push(script);
                if (!cleanupFailure) throw new Error('assertion failure');
            },
        }), cleanupFailure ? /cleanup failure/ : /assertion failure/);
        assert.equal(prepared, 1);
        assert.equal(disposed, 1);
        assert.equal(calls.length, 1);
    }
    assert.equal(markers.filter(line => line.includes('started.')).length, 2);
    assert.equal(markers.some(line => line.includes('passed, including teardown.')), false);
    for (const count of [0, 6, NaN, 1.5]) await assert.rejects(verifyPackageRepetitions({
        chromeArchive: 'chrome.zip', firefoxArchive: 'firefox.zip', count,
    }), /integer/);
    await assert.rejects(verifyPackageRepetitions({ chromeArchive: 'chrome.zip', firefoxArchive: 'firefox.zip',
        browser: 'missing' as never }), /Unknown package browser/);
});

test('each Chrome repetition extracts original bytes into a new owned root and removes mutations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-package-extraction-test-'));
    const archivePath = path.join(root, 'chrome.zip');
    const firefoxArchive = path.join(root, 'firefox.zip');
    try {
        const archive = new JSZip();
        archive.file('manifest.json', '{"version":"4.1.0"}');
        archive.file('runtime.js', 'original packaged bytes');
        await writeFile(archivePath, await archive.generateAsync({ type: 'nodebuffer' }));
        await writeFile(firefoxArchive, 'Firefox package bytes');
        const sources: string[] = [];
        await verifyPackageRepetitions({ chromeArchive: archivePath, firefoxArchive, browser: 'chrome', count: 3,
            chromeSource: path.join(root, 'legacy-extraction'), execute: async (_script, source) => {
                sources.push(source);
                assert.equal(await readFile(path.join(source, 'runtime.js'), 'utf8'), 'original packaged bytes');
                await writeFile(path.join(source, 'runtime.js'), 'mutation inside extracted source');
            } });
        assert.equal(new Set(sources).size, 3);
        for (const source of sources) await assert.rejects(readdir(source), { code: 'ENOENT' });
        assert.deepEqual((await readdir(root)).sort(), ['chrome.zip', 'firefox.zip']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive extraction rejects unsafe original names and removes failed owned roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-unsafe-package-test-'));
    try {
        for (const name of ['../escape.js', '/absolute.js', 'nested\\escape.js', 'C:/escape.js']) {
            const archive = new JSZip();
            archive.file(name, 'unsafe');
            const archivePath = path.join(root, 'unsafe.zip');
            await writeFile(archivePath, await archive.generateAsync({ type: 'nodebuffer' }));
            await assert.rejects(prepareChromeArchive(archivePath, path.join(root, 'legacy-extraction')), /unsafe path/);
            assert.deepEqual(await readdir(root), ['unsafe.zip']);
        }
        const malformed = path.join(root, 'malformed.zip');
        await writeFile(malformed, 'not a zip');
        await assert.rejects(extractArchive(malformed, root));
    } finally { await rm(root, { recursive: true, force: true }); }
});
