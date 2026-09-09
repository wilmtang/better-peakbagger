// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
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
    }), /ps failed/);
});

test('a lingering Firefox process still fails teardown', async () => {
    await assert.rejects(quitFirefoxDriver(lostQuitResponse, '/tmp/owned-fixture', {
        readOwnedPids: () => [123],
    }), /Firefox processes owned by .* to exit after QUIT/);
});

test('confirmed browser exit cannot suppress a failed extension assertion', async () => {
    const resources = createResourceStack();
    resources.defer('Firefox', () => quitFirefoxDriver(lostQuitResponse, '/tmp/owned-fixture', {
        readOwnedPids: () => [],
    }));
    const assertionFailure = new Error('extension assertion failed');
    await assert.rejects(resources.dispose(assertionFailure), error => error === assertionFailure);
});
