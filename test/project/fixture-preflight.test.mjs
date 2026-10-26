// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { fixturePreflightCommands, runFixturePreflight } from '../../scripts/verify-fixture-preflight.mjs';

test('preflight exercises real locale, evidence, worker authorization and production fixtures', async () => {
    for (const browser of ['chrome', 'firefox']) {
        const calls = [];
        await runFixturePreflight([`--${browser}-only`], async (...call) => calls.push(call));
        assert.equal(calls.length, 3);
        assert.match(calls[0][1].join(' '), /formatting-locale.*browser-verification-evidence/);
        assert.match(calls[1][1].join(' '), /capture controls reject\|privileged extension routes reject/);
        assert.deepEqual(calls[2][1], ['scripts/verify-layout-stability.mjs', `--${browser}-only`, '--preflight']);
    }
});

test('unknown preflight selections and any failing phase stop before later launches', async () => {
    for (const args of [[], ['--missing'], ['--chrome-only', '--firefox-only']]) assert.throws(() => fixturePreflightCommands(args));
    const failure = new Error('fixture failed');
    let calls = 0;
    await assert.rejects(runFixturePreflight(['--chrome-only'], async () => { calls++; throw failure; }), error => error === failure);
    assert.equal(calls, 1);
});
