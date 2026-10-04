// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { selectReleaseArtifact } from '../../scripts/select-release-artifact.mjs';

const artifact = (attempt, overrides = {}) => ({
    name: `browser-extension-v3.8.0${attempt ? `-${attempt}` : ''}`,
    expired: false,
    ...overrides,
});
const select = (pages, attempt = 2) => selectReleaseArtifact(pages, 'v3.8.0', attempt);

test('store-only reruns retain the earlier verified artifact across listing pages', () => {
    const pages = [{ artifacts: [artifact(2, { name: 'release-browser-failure-2' })] },
        { artifacts: [artifact(1)] }];
    assert.equal(select(pages), 'browser-extension-v3.8.0-1');
    const cli = spawnSync(process.execPath, ['scripts/select-release-artifact.mjs', 'v3.8.0', '2'], {
        input: JSON.stringify(pages), encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim(), 'browser-extension-v3.8.0-1');
});

test('selection prefers the latest available verified attempt within the release run', () => {
    const artifacts = [artifact(1), artifact(9), artifact(3), artifact(4, { expired: true }),
        artifact(12), artifact(2, { name: 'browser-extension-v3.8.1-2' })];
    assert.equal(select([{ artifacts }], 10), 'browser-extension-v3.8.0-9');
    assert.equal(select([{ artifacts }]), 'browser-extension-v3.8.0-1');
});

test('legacy artifact names are accepted only when no numbered package is available', () => {
    assert.equal(select([{ artifacts: [artifact(null)] }]), 'browser-extension-v3.8.0');
    assert.equal(select([{ artifacts: [artifact(null), artifact(1)] }]), 'browser-extension-v3.8.0-1');
    assert.equal(select([{ artifacts: [artifact(null), artifact(1, { expired: true })] }]),
        'browser-extension-v3.8.0');
});

test('missing, expired, malformed, future, and ambiguous artifacts fail closed', () => {
    for (const artifacts of [[], [artifact(1, { expired: true })], [artifact(3)],
        [artifact('01')], [artifact('1.zip')], [artifact('9007199254740993')],
        [artifact(1, { name: 'browser-extension-v3.8.1-1' })]]) {
        assert.throws(() => select([{ artifacts }]), /No unexpired verified package/);
    }
    for (const candidate of [artifact(1), artifact(null)]) {
        assert.throws(() => select([{ artifacts: [candidate, { ...candidate }] }]), /ambiguous/);
    }
    assert.throws(() => select({ artifacts: [] }), /paginated/);
    assert.throws(() => select([{}]), /paginated/);
    assert.throws(() => selectReleaseArtifact([], 'v3.8.0-extra', 2), /exact release tag/);
    for (const attempt of [0, '02', 'invalid', '9007199254740993']) {
        assert.throws(() => select([], attempt), /positive safe integer/);
    }
});
