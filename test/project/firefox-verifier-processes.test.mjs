// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { quitFirefoxDriver } from '../../scripts/firefox-verifier-processes.mjs';
import { createResourceStack } from '../../scripts/resource-stack.mjs';

const lostQuitResponse = {
    quit: async () => { throw new Error('Failed to decode response from marionette'); },
};

test('a lost Firefox QUIT response succeeds only after owned processes exit', async () => {
    let probes = 0;
    await quitFirefoxDriver(lostQuitResponse, '/tmp/owned-fixture', {
        readOwnedPids: root => {
            assert.equal(root, '/tmp/owned-fixture');
            return ++probes === 1 ? [123] : [];
        },
    });
    assert.equal(probes, 2);
});

test('unknown teardown errors and failed process inspection remain failures', async () => {
    await assert.rejects(quitFirefoxDriver({ quit: async () => {
        throw new Error('unrelated transport failure');
    } }, '/tmp/owned-fixture', {
        readOwnedPids: () => assert.fail('unknown errors must not use the exit exception'),
    }), /unrelated transport failure/);
    await assert.rejects(quitFirefoxDriver(lostQuitResponse, '/tmp/owned-fixture', {
        readOwnedPids: () => { throw new Error('ps failed'); },
        timeoutMs: 40,
    }), /ps failed/);
});

test('a lingering Firefox process still fails teardown', async () => {
    await assert.rejects(quitFirefoxDriver(lostQuitResponse, '/tmp/owned-fixture', {
        readOwnedPids: () => [123],
        timeoutMs: 40,
    }), /Firefox processes owned by .* to exit after QUIT/);
});

test('successful QUIT still waits for owned process exit and rejects a leaked browser', async () => {
    let probes = 0;
    await quitFirefoxDriver({ quit: async () => {} }, '/tmp/owned-fixture', {
        readOwnedPids: () => ++probes === 1 ? [123] : [],
    });
    assert.equal(probes, 2);
    await assert.rejects(quitFirefoxDriver({ quit: async () => {} }, '/tmp/owned-fixture', {
        readOwnedPids: () => [123], timeoutMs: 40,
    }), /to exit after QUIT/);
});

test('a disconnected session is not treated as a successful lost QUIT response', async () => {
    await assert.rejects(quitFirefoxDriver({ quit: async () => {
        throw new Error('Tried to run command without establishing a connection');
    } }, '/tmp/owned-fixture', {
        readOwnedPids: () => [],
    }), /without establishing a connection/);
});

test('disposable-profile verification avoids uninstall and reports success only after teardown', async () => {
    const source = await readFile(new URL('../../scripts/verify-firefox-extension.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.uninstallAddon\(/);
    assert.ok(source.indexOf('await resources.dispose(primaryError)')
        < source.indexOf('Firefox extension verification and owned-process teardown passed.'));
});

test('confirmed browser exit cannot suppress a failed extension assertion', async () => {
    const resources = createResourceStack();
    resources.defer('Firefox', () => quitFirefoxDriver(lostQuitResponse, '/tmp/owned-fixture', {
        readOwnedPids: () => [],
    }));
    const assertionFailure = new Error('extension assertion failed');
    await assert.rejects(resources.dispose(assertionFailure), error => error === assertionFailure);
});
