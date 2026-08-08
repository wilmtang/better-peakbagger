// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// image-size has no patched release for either accepted advisory. The package
// is reachable only through web-ext's development-time addons-linter, which
// reads this repository's own packaged icons; it is never shipped. Keep the
// exception exact and short-lived so a changed advisory, install path, tool
// version, severity, or expiry fails closed instead of becoming a blanket
// release bypass.
export const AUDIT_ACCEPTANCE = Object.freeze({
    advisories: Object.freeze({
        'GHSA-w3rx-r6r6-pgpr': 1138808,
        'GHSA-5p2g-fcmc-qvqq': 1138809,
    }),
    expires: '2026-08-21',
    vulnerablePackages: Object.freeze([
        'addons-linter',
        'image-size',
        'web-ext',
    ]),
    lockedPackages: Object.freeze({
        'node_modules/web-ext': '10.6.0',
        'node_modules/addons-linter': '10.10.0',
        'node_modules/image-size': '2.0.2',
    }),
});

const exactMembers = (actual, expected) =>
    actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);

const requireKnownLock = lockfile => {
    for (const [packagePath, version] of Object.entries(AUDIT_ACCEPTANCE.lockedPackages)) {
        const entry = lockfile?.packages?.[packagePath];
        if (entry?.version !== version || entry.dev !== true) {
            throw new Error(`Audit acceptance lock changed at ${packagePath}; expected dev-only ${version}`);
        }
    }
};

export function evaluateAudit(audit, lockfile, today = new Date().toISOString().slice(0, 10)) {
    const counts = audit.metadata?.vulnerabilities;
    if (!counts || typeof counts.total !== 'number') {
        throw new Error('npm audit reported no vulnerability metadata');
    }
    if (counts.total === 0) return { status: 'clean' };

    const names = Object.keys(audit.vulnerabilities || {}).sort();
    const expectedNames = [...AUDIT_ACCEPTANCE.vulnerablePackages].sort();
    if (!exactMembers(names, expectedNames)) {
        throw new Error(`Unowned npm audit findings: ${names.join(', ') || 'missing vulnerability detail'}`);
    }
    if (today > AUDIT_ACCEPTANCE.expires) {
        throw new Error(`Audit acceptance expired on ${AUDIT_ACCEPTANCE.expires}`);
    }
    if (counts.total !== expectedNames.length
        || counts.high !== expectedNames.length
        || counts.critical !== 0
        || counts.info !== 0
        || counts.low !== 0
        || counts.moderate !== 0) {
        throw new Error('npm audit severity/counts changed outside the accepted findings');
    }

    const rootFinding = audit.vulnerabilities['image-size'];
    const advisories = (rootFinding?.via || [])
        .filter(value => typeof value === 'object')
        .map(value => ({
            id: String(value.url || '').split('/').at(-1),
            source: value.source,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const expectedAdvisories = Object.entries(AUDIT_ACCEPTANCE.advisories)
        .map(([id, source]) => ({ id, source }))
        .sort((left, right) => left.id.localeCompare(right.id));
    if (JSON.stringify(advisories) !== JSON.stringify(expectedAdvisories)
        || !exactMembers(rootFinding?.nodes || [], ['node_modules/image-size'])) {
        throw new Error('The accepted image-size advisories or vulnerable install path changed');
    }

    const expectedPaths = {
        'addons-linter': { via: ['image-size'], nodes: ['node_modules/addons-linter'] },
        'web-ext': { via: ['addons-linter'], nodes: ['node_modules/web-ext'] },
    };
    for (const [name, expected] of Object.entries(expectedPaths)) {
        const finding = audit.vulnerabilities[name];
        if (!exactMembers(finding?.via || [], expected.via)
            || !exactMembers(finding?.nodes || [], expected.nodes)) {
            throw new Error(`Audit path for ${name} changed outside the accepted findings`);
        }
    }

    requireKnownLock(lockfile);
    return {
        status: 'accepted',
        message: `Accepted two image-size advisories only in the dev-only web-ext lint path through ${AUDIT_ACCEPTANCE.expires}.`,
    };
}

async function main() {
    const auditRun = spawnSync('npm', ['audit', '--json'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (auditRun.error) throw auditRun.error;
    if (!auditRun.stdout.trim()) {
        throw new Error(`npm audit produced no JSON: ${auditRun.stderr.trim() || `exit ${auditRun.status}`}`);
    }

    const [audit, lockfile] = await Promise.all([
        Promise.resolve(JSON.parse(auditRun.stdout)),
        readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
    ]);
    const result = evaluateAudit(audit, lockfile);
    console.log(result.status === 'clean' ? 'npm audit passed with no vulnerabilities.' : result.message);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
