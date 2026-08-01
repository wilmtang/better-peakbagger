// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { evaluateAudit } from '../../scripts/check-npm-audit.mjs';

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

test('the npm audit gate passes only on a clean tree', () => {
    assert.deepEqual(evaluateAudit(auditWith({})), { status: 'clean' });
});

// The gate previously carried one dated acceptance. It is gone, and the point
// of removing it is that nothing is accepted now — not that the accepted thing
// changed. A finding of any severity, in any package, fails.
test('the npm audit gate rejects every finding, whatever it is', () => {
    assert.throws(() => evaluateAudit(auditWith({
        'brace-expansion': {
            severity: 'high',
            via: [{ source: 1130588, url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg' }],
            nodes: ['node_modules/brace-expansion'],
        },
    })), /Unowned npm audit findings: brace-expansion \(high\) — https:\/\/github\.com\/advisories\/GHSA-mh99-v99m-4gvg/);

    assert.throws(() => evaluateAudit(auditWith({
        'some-dev-tool': { severity: 'low', via: ['brace-expansion'], nodes: [] },
    }, { low: 1, high: 0 })), /Unowned npm audit findings: some-dev-tool \(low\)/);

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
    assert.deepEqual(packageJson.overrides['minimatch@^3.0.0'], { 'brace-expansion': '1.1.17' });

    const entry = lockfile.packages['node_modules/brace-expansion'];
    assert.equal(entry.version, '1.1.17');
    assert.equal(entry.dev, true, 'brace-expansion must never become a production dependency');
    for (const [packagePath, resolved] of Object.entries(lockfile.packages)) {
        if (!packagePath.endsWith('node_modules/brace-expansion')) continue;
        assert.equal(resolved.dev, true, `${packagePath} must stay development-only`);
        assert.ok(!/^1\.1\.(?:[0-9]|1[0-6])$/.test(resolved.version),
            `${packagePath} resolves ${resolved.version}, which the advisory covers`);
    }
});
