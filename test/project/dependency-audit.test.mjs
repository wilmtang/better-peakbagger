// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AUDIT_ACCEPTANCE,
    evaluateAudit
} from '../../scripts/check-npm-audit.mjs';

const acceptedAudit = () => ({
    metadata: {
        vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 8,
            critical: 0,
            total: 8
        }
    },
    vulnerabilities: Object.fromEntries(AUDIT_ACCEPTANCE.vulnerablePackages.map(name => [name, {
        via: name === 'brace-expansion'
            ? [{
                source: AUDIT_ACCEPTANCE.source,
                url: `https://github.com/advisories/${AUDIT_ACCEPTANCE.advisory}`
            }]
            : ['brace-expansion'],
        nodes: name === 'brace-expansion' ? ['node_modules/brace-expansion'] : []
    }]))
});

const acceptedLock = () => ({
    packages: Object.fromEntries(Object.entries(AUDIT_ACCEPTANCE.lockedPackages)
        .map(([packagePath, version]) => [packagePath, { version, dev: true }]))
});

test('the npm audit gate permits only the time-bounded dev-tool advisory', () => {
    const result = evaluateAudit(acceptedAudit(), acceptedLock(), '2026-07-26');
    assert.equal(result.status, 'accepted');
    assert.match(result.message, /dev-only web-ext/);
    assert.match(result.message, new RegExp(AUDIT_ACCEPTANCE.expires));
});

test('the npm audit gate passes immediately when upstream clears the advisory', () => {
    assert.deepEqual(evaluateAudit({
        metadata: { vulnerabilities: { total: 0 } },
        vulnerabilities: {}
    }, acceptedLock()), { status: 'clean' });
});

test('the npm audit gate rejects new findings, drifted locks, and expiration', () => {
    const extra = acceptedAudit();
    extra.vulnerabilities['some-new-package'] = { via: [{ source: 999 }], nodes: [] };
    extra.metadata.vulnerabilities.high++;
    extra.metadata.vulnerabilities.total++;
    assert.throws(
        () => evaluateAudit(extra, acceptedLock(), '2026-07-26'),
        /Unowned npm audit findings/
    );

    const driftedLock = acceptedLock();
    driftedLock.packages['node_modules/eslint/node_modules/brace-expansion'].version = '5.0.7';
    assert.throws(
        () => evaluateAudit(acceptedAudit(), driftedLock, '2026-07-26'),
        /expected dev-only 5\.0\.8/
    );

    assert.throws(
        () => evaluateAudit(acceptedAudit(), acceptedLock(), '2026-08-10'),
        /expired on 2026-08-09/
    );
});
