// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    evaluateAudit,
} from '../../scripts/check-npm-audit.mjs';

const auditWith = (vulnerabilities, counts = {}) => ({
    metadata: {
        vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: Object.keys(vulnerabilities).length,
            critical: 0,
            total: Object.keys(vulnerabilities).length,
            ...counts,
        },
    },
    vulnerabilities,
});

test('the npm audit gate passes a clean tree', () => {
    assert.deepEqual(evaluateAudit(auditWith({})), { status: 'clean' });
});

test('the npm audit gate rejects every finding, including the former exception', () => {
    for (const name of ['image-size', 'some-dev-tool']) {
        assert.throws(() => evaluateAudit(auditWith({ [name]: { severity: 'high' } })),
            /Unowned npm audit findings/);
    }
    assert.throws(() => evaluateAudit(auditWith({}, { total: 3 })), /missing vulnerability detail/);
    assert.throws(() => evaluateAudit(auditWith({ unexpected: {} }, { total: 0 })), /unexpected/);
});

test('the npm audit gate fails closed on unusable audit output', () => {
    for (const audit of [null, {}, { metadata: {} }, { metadata: { vulnerabilities: {} } },
        auditWith({}, { total: -1 }), auditWith({}, { total: NaN })]) {
        assert.throws(() => evaluateAudit(audit), /no usable vulnerability metadata/);
    }
});

// The override that removed the last accepted advisory. Scoped to minimatch@^3
// so it cannot reach the brace-expansion 5.x that eslint resolves; dropping it
// would silently reintroduce a vulnerable dev-only install path.
test('the vulnerable dev-only brace-expansion path stays pinned to a patched release', async () => {
    const [packageJson, lockfile] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    assert.deepEqual(packageJson.overrides['minimatch@^3.0.0'], { 'brace-expansion': '1.1.18' });

    const entry = lockfile.packages['node_modules/brace-expansion'];
    assert.equal(entry.version, '1.1.18');
    assert.equal(entry.dev, true, 'brace-expansion must never become a production dependency');
    const patchedVersions = new Set(['1.1.18', '5.0.9']);
    for (const [packagePath, resolved] of Object.entries(lockfile.packages)) {
        if (!packagePath.endsWith('node_modules/brace-expansion')) continue;
        assert.equal(resolved.dev, true, `${packagePath} must stay development-only`);
        assert.ok(patchedVersions.has(resolved.version),
            `${packagePath} resolves ${resolved.version}, not a reviewed patched version`);
    }
});

test('patched lint dependencies stay dev-only and pinned', async () => {
    const [packageJson, lockfile] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    assert.equal(packageJson.devDependencies['web-ext'], '^10.7.0');
    assert.equal(packageJson.overrides['firefox-profile'], undefined,
        'firefox-profile must resolve patched adm-zip releases through its maintained range');
    for (const [packagePath, version] of Object.entries({ 'node_modules/web-ext': '10.7.0', 'node_modules/addons-linter': '10.13.0', 'node_modules/image-size': '2.0.4' })) {
        const entry = lockfile.packages[packagePath];
        assert.equal(entry.version, version);
        assert.equal(entry.dev, true, `${packagePath} must stay development-only`);
    }
    const admZip = lockfile.packages['node_modules/adm-zip'];
    assert.equal(admZip.version, '0.6.1', 'symlink-safe extraction requires adm-zip 0.6.1 or later');
    assert.equal(admZip.dev, true, 'adm-zip must stay development-only');
    const jsYaml = lockfile.packages['node_modules/js-yaml'];
    assert.equal(jsYaml.version, '4.3.2', 'empty merge sources must use the patched CPU limit');
    assert.equal(jsYaml.dev, true, 'js-yaml must stay development-only');
    const fastUri = lockfile.packages['node_modules/fast-uri'];
    assert.equal(fastUri.version, '3.1.8');
    assert.equal(fastUri.dev, true, 'fast-uri must stay development-only');
});

test('maintained release guidance requires zero advisories', async () => {
    for (const relative of ['../../.github/workflows/release.yml', '../../docs/architecture.md',
        '../../docs/development.md', '../../docs/releasing.md']) {
        const source = await readFile(new URL(relative, import.meta.url), 'utf8');
        assert.match(source, /zero advisories/i, relative);
        assert.doesNotMatch(source, /2026-09-21|permits two exact high|accepts two exact high/i);
    }
});
