// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    AUDIT_ACCEPTANCE,
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

const acceptedAudit = () => auditWith({
    'addons-linter': {
        severity: 'high',
        via: ['image-size'],
        nodes: ['node_modules/addons-linter'],
    },
    'image-size': {
        severity: 'high',
        via: [
            { source: 1138808, url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr' },
            { source: 1138809, url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq' },
        ],
        nodes: ['node_modules/image-size'],
    },
    'web-ext': {
        severity: 'high',
        via: ['addons-linter'],
        nodes: ['node_modules/web-ext'],
    },
});

const acceptedLock = () => ({
    packages: Object.fromEntries(Object.entries(AUDIT_ACCEPTANCE.lockedPackages)
        .map(([packagePath, version]) => [packagePath, { version, dev: true }])),
});

test('the npm audit gate accepts only the reviewed image-size lint path before expiry', () => {
    assert.deepEqual(
        evaluateAudit(acceptedAudit(), acceptedLock(), '2026-08-22'),
        {
            status: 'accepted',
            message: 'Accepted two image-size advisories only in the dev-only web-ext lint path through 2026-09-21.',
        },
    );

    assert.throws(
        () => evaluateAudit(acceptedAudit(), acceptedLock(), '2026-09-22'),
        /expired on 2026-09-21/,
    );
});

test('the npm audit gate rejects advisory, path, package, severity, and lock drift', () => {
    const unknownAdvisory = acceptedAudit();
    unknownAdvisory.vulnerabilities['image-size'].via[0] = {
        source: 9999999,
        url: 'https://github.com/advisories/GHSA-unknown',
    };
    assert.throws(
        () => evaluateAudit(unknownAdvisory, acceptedLock(), '2026-08-07'),
        /advisories or vulnerable install path changed/,
    );

    const pathDrift = acceptedAudit();
    pathDrift.vulnerabilities['addons-linter'].via = ['some-other-package'];
    assert.throws(
        () => evaluateAudit(pathDrift, acceptedLock(), '2026-08-07'),
        /Audit path for addons-linter changed/,
    );

    assert.throws(() => evaluateAudit(auditWith({
        'some-dev-tool': {
            severity: 'high',
            via: [{ source: 9999999, url: 'https://github.com/advisories/GHSA-unknown' }],
            nodes: ['node_modules/some-dev-tool'],
        },
    }), acceptedLock(), '2026-08-07'), /Unowned npm audit findings: some-dev-tool/);

    const severityDrift = acceptedAudit();
    severityDrift.metadata.vulnerabilities.moderate = 1;
    severityDrift.metadata.vulnerabilities.high = 2;
    assert.throws(
        () => evaluateAudit(severityDrift, acceptedLock(), '2026-08-07'),
        /severity\/counts changed/,
    );

    const lockDrift = acceptedLock();
    lockDrift.packages['node_modules/image-size'].version = '2.0.3';
    assert.throws(
        () => evaluateAudit(acceptedAudit(), lockDrift, '2026-08-07'),
        /Audit acceptance lock changed at node_modules\/image-size/,
    );

    // A count with no detail is still a failure, not a pass with a blank list.
    assert.throws(
        () => evaluateAudit({ metadata: { vulnerabilities: { total: 3 } }, vulnerabilities: {} }),
        /missing vulnerability detail/
    );
});

// npm changing its report shape must not read as "nothing found".
test('the npm audit gate fails closed on unusable audit output', () => {
    for (const audit of [{}, { metadata: {} }, { metadata: { vulnerabilities: {} } }]) {
        assert.throws(() => evaluateAudit(audit), /no vulnerability metadata/);
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

test('the accepted image-size path and patched transitive packages stay dev-only and pinned', async () => {
    const [packageJson, lockfile] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    assert.equal(packageJson.devDependencies['web-ext'], '^10.6.0');
    for (const [packagePath, version] of Object.entries(AUDIT_ACCEPTANCE.lockedPackages)) {
        const entry = lockfile.packages[packagePath];
        assert.equal(entry.version, version);
        assert.equal(entry.dev, true, `${packagePath} must stay development-only`);
    }
    const jsYaml = lockfile.packages['node_modules/js-yaml'];
    assert.equal(jsYaml.version, '4.3.1');
    assert.equal(jsYaml.dev, true, 'js-yaml must stay development-only');
    const fastUri = lockfile.packages['node_modules/fast-uri'];
    assert.equal(fastUri.version, '3.1.7');
    assert.equal(fastUri.dev, true, 'fast-uri must stay development-only');
});

test('maintained release guidance names the live expiring audit acceptance', async () => {
    const maintainedSources = await Promise.all([
        '../../.github/workflows/release.yml',
        '../../docs/architecture.md',
        '../../docs/development.md',
        '../../docs/releasing.md',
    ].map(async relative => ({
        relative,
        source: await readFile(new URL(relative, import.meta.url), 'utf8'),
    })));

    assert.equal(Object.keys(AUDIT_ACCEPTANCE.advisories).length, 2);
    for (const { relative, source } of maintainedSources) {
        assert.match(source, /two exact high\s+[`]?image-size[`]?\s+advisories/i,
            `${relative} must name the bounded acceptance count and package`);
        assert.match(source, /web-ext/);
        assert.match(source, /addons-linter/);
        assert.match(source, new RegExp(AUDIT_ACCEPTANCE.expires));
        assert.doesNotMatch(source, /accepts no advisories|no accepted exceptions|accepts no finding/i);
    }
});
