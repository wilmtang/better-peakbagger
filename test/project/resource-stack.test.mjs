// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixtureCertificate } from '../../scripts/browser-verification-fixtures.mjs';
import {
    closeServer,
    createResourceStack,
    listenServer,
    manageChildProcess,
} from '../../scripts/resource-stack.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('verifier resources clean up LIFO and one rejection cannot skip the rest', async () => {
    const order = [];
    const resources = createResourceStack();
    resources.defer('first', () => { order.push('first'); });
    resources.defer('rejecting', () => {
        order.push('rejecting');
        throw new Error('blocked');
    });
    resources.defer('last', () => { order.push('last'); });

    await assert.rejects(resources.dispose(), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /rejecting/);
        return true;
    });
    assert.deepEqual(order, ['last', 'rejecting', 'first']);
});

test('cleanup failures annotate but never replace the primary verifier failure', async () => {
    const primary = new Error('assertion failed');
    const resources = createResourceStack();
    resources.defer('broken finalizer', async () => { throw new Error('cleanup failed'); });

    await assert.rejects(resources.dispose(primary), error => {
        assert.equal(error, primary);
        assert.match(error.message, /^assertion failed/);
        assert.equal(error.cleanupErrors.length, 1);
        return true;
    });
});

test('a hanging finalizer times out without blocking later cleanup', async () => {
    const order = [];
    const resources = createResourceStack({ finalizerTimeoutMs: 20 });
    resources.defer('later', () => { order.push('later'); });
    resources.defer('hung', () => new Promise(() => {}));
    resources.defer('earlier', () => { order.push('earlier'); });

    await assert.rejects(resources.dispose(), error => {
        assert.match(error.errors[0].message, /hung cleanup did not finish/);
        return true;
    });
    assert.deepEqual(order, ['earlier', 'later']);
});

test('an invalid child path is contained and leaves other resources cleanable', async () => {
    const resources = createResourceStack();
    const order = [];
    resources.defer('outer', () => { order.push('outer'); });
    const child = spawn('/definitely-not-a-better-peakbagger-browser');
    const childState = manageChildProcess(resources, child, 'invalid browser');
    await new Promise(resolve => child.once('close', resolve));

    assert.match(childState.error?.message || '', /ENOENT/);
    await resources.dispose();
    assert.deepEqual(order, ['outer']);
});

test('a child that ignores termination cannot skip later cleanup', async () => {
    const resources = createResourceStack();
    const order = [];
    resources.defer('outer', () => { order.push('outer'); });
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 12345;
    child.kill = signal => {
        order.push(signal);
        return true;
    };
    manageChildProcess(resources, child, 'hung browser', { graceMs: 5 });

    await assert.rejects(resources.dispose(), error => {
        assert.match(error.errors[0].message, /did not exit after SIGKILL/);
        return true;
    });
    assert.deepEqual(order, ['SIGTERM', 'SIGKILL', 'outer']);
});

test('invalid OpenSSL and certificate reads leave no key material behind', async t => {
    await t.test('owned directory after invalid OpenSSL path', async () => {
        const label = `resource-stack-${process.pid}-${Date.now()}`;
        await assert.rejects(createFixtureCertificate({
            label,
            opensslPath: '/definitely-not-openssl',
        }), /Could not create/);
        const leftovers = (await readdir(tmpdir()))
            .filter(name => name.startsWith(`better-peakbagger-${label}-cert-`));
        assert.deepEqual(leftovers, []);
    });

    await t.test('invalid OpenSSL path', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'bpb-cert-open-'));
        try {
            await assert.rejects(createFixtureCertificate({
                directory,
                opensslPath: '/definitely-not-openssl',
            }), /Could not create/);
            assert.deepEqual(await readdir(directory), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    await t.test('certificate read failure', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'bpb-cert-read-'));
        try {
            await assert.rejects(createFixtureCertificate({
                directory,
                readCertificate: async () => { throw new Error('injected read failure'); },
            }), /injected read failure/);
            assert.deepEqual(await readdir(directory), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

test('a listen failure is observable and the failed server remains cleanable', async () => {
    const server = createServer();
    await assert.rejects(listenServer(server, 0, 'not-a-real-bpb-host.invalid'));
    await closeServer(server);
    assert.equal(server.listening, false);
});

test('browser verifiers use the shared resource stack and condition-based analyzer readiness', async () => {
    const verifierPaths = [
        'scripts/verify-extension.mjs',
        'scripts/verify-firefox-extension.mjs',
        'scripts/verify-firefox-terrain.mjs',
        'scripts/verify-terrain-lod.mjs',
        'scripts/verify-terrain-visual.mjs',
        'scripts/render-showcase.mjs',
    ];
    const sources = await Promise.all(verifierPaths.map(async verifierPath => ({
        verifierPath,
        source: await readFile(path.join(projectRoot, verifierPath), 'utf8'),
    })));
    for (const { verifierPath, source } of sources) {
        assert.match(source, /createResourceStack\(/, `${verifierPath} must own resources through the shared stack`);
    }

    const chromeVerifier = sources.find(entry => entry.verifierPath === 'scripts/verify-extension.mjs').source;
    assert.doesNotMatch(chromeVerifier, /waitForTimeout\(2_?000\)/);
    assert.match(chromeVerifier, /waitForFunction\([\s\S]*Interactive Stats:/);
    assert.match(chromeVerifier, /current value:/);

    for (const verifierPath of ['scripts/verify-terrain-lod.mjs', 'scripts/verify-terrain-visual.mjs']) {
        const source = sources.find(entry => entry.verifierPath === verifierPath).source;
        assert.match(source, /manageChildProcess\(resources, chrome/,
            `${verifierPath} must attach a child error boundary before awaiting startup`);
    }
});
