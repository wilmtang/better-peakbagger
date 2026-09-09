// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Re-reviewed 2026-08-22: image-size 2.0.2 remains the registry's latest
// release and GitHub lists no patched release for either accepted advisory.
// The package is reachable only through web-ext's development-time
// addons-linter, which reads this repository's own packaged icons and theme
// images; it is never shipped. Keep the exception exact and short-lived so a
// changed advisory, install path, tool version, severity, or expiry fails
// closed instead of becoming a blanket release bypass.
// Reviewed 2026-09-08: adm-zip 0.6.0 is also latest and has no symlink fix.
// web-ext's own installExtension copies an XPI or writes a proxy; it does not
// call firefox-profile's vulnerable extraction API. The installed-tool boundary
// is exercised in test/project/web-ext-installation.test.mjs. Keep this separate
// from the image parser acceptance and use the same short expiry.
export const AUDIT_ACCEPTANCE = Object.freeze({
    advisories: Object.freeze({
        'GHSA-w3rx-r6r6-pgpr': 1138808,
        'GHSA-5p2g-fcmc-qvqq': 1138809,
    }),
    admZipAdvisories: Object.freeze({
        'GHSA-vwc7-r8mq-g2x9': 1193734,
    }),
    expires: '2026-09-21',
    vulnerablePackages: Object.freeze([
        'addons-linter',
        'adm-zip',
        'firefox-profile',
        'image-size',
        'web-ext',
    ]),
    lockedPackages: Object.freeze({
        'node_modules/web-ext': '10.6.0',
        'node_modules/addons-linter': '10.10.0',
        'node_modules/image-size': '2.0.2',
        'node_modules/firefox-profile': '4.7.1',
        'node_modules/adm-zip': '0.6.0',
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
        || counts.high !== 3
        || counts.critical !== 0
        || counts.info !== 0
        || counts.low !== 0
        || counts.moderate !== 2) {
        throw new Error('npm audit severity/counts changed outside the accepted findings');
    }

    for (const [name, acceptedAdvisories, severity] of [
        ['image-size', AUDIT_ACCEPTANCE.advisories, 'high'],
        ['adm-zip', AUDIT_ACCEPTANCE.admZipAdvisories, 'moderate'],
    ]) {
        const rootFinding = audit.vulnerabilities[name];
        const advisories = (rootFinding?.via || [])
            .filter(value => typeof value === 'object')
            .map(value => ({
                id: String(value.url || '').split('/').at(-1),
                source: value.source,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
        const expectedAdvisories = Object.entries(acceptedAdvisories)
            .map(([id, source]) => ({ id, source }))
            .sort((left, right) => left.id.localeCompare(right.id));
        if (JSON.stringify(advisories) !== JSON.stringify(expectedAdvisories)
            || rootFinding?.via?.length !== advisories.length
            || rootFinding?.severity !== severity
            || !exactMembers(rootFinding?.nodes || [], [`node_modules/${name}`])) {
            throw new Error(`The accepted ${name} advisories or vulnerable install path changed`);
        }
    }

    const expectedPaths = {
        'addons-linter': { via: ['image-size'], nodes: ['node_modules/addons-linter'], severity: 'high' },
        'firefox-profile': { via: ['adm-zip'], nodes: ['node_modules/firefox-profile'], severity: 'moderate' },
        'web-ext': { via: ['addons-linter', 'firefox-profile'], nodes: ['node_modules/web-ext'], severity: 'high' },
    };
    for (const [name, expected] of Object.entries(expectedPaths)) {
        const finding = audit.vulnerabilities[name];
        if (finding?.severity !== expected.severity
            || !exactMembers(finding?.via || [], expected.via)
            || !exactMembers(finding?.nodes || [], expected.nodes)) {
            throw new Error(`Audit path for ${name} changed outside the accepted findings`);
        }
    }

    requireKnownLock(lockfile);
    return {
        status: 'accepted',
        message: `Accepted two image-size lint advisories and one unused adm-zip extraction advisory only in the pinned dev-only web-ext paths through ${AUDIT_ACCEPTANCE.expires}.`,
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
