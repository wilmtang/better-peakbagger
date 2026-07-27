// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const AUDIT_ACCEPTANCE = Object.freeze({
    advisory: 'GHSA-mh99-v99m-4gvg',
    source: 1124334,
    expires: '2026-08-09',
    vulnerablePackages: Object.freeze([
        '@eslint/config-array',
        '@eslint/eslintrc',
        'addons-linter',
        'brace-expansion',
        'eslint',
        'minimatch',
        'multimatch',
        'web-ext'
    ]),
    lockedPackages: Object.freeze({
        'node_modules/web-ext': '10.5.0',
        'node_modules/addons-linter': '10.8.0',
        'node_modules/multimatch': '6.0.0',
        'node_modules/minimatch': '3.1.5',
        'node_modules/brace-expansion': '1.1.16',
        'node_modules/@eslint/config-array/node_modules/brace-expansion': '5.0.8',
        'node_modules/eslint/node_modules/brace-expansion': '5.0.8'
    })
});

const exactMembers = (actual, expected) =>
    actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);

const requireKnownLock = lockfile => {
    for (const [packagePath, version] of Object.entries(AUDIT_ACCEPTANCE.lockedPackages)) {
        const entry = lockfile.packages?.[packagePath];
        if (entry?.version !== version || entry.dev !== true) {
            throw new Error(`Audit acceptance lock changed at ${packagePath}; expected dev-only ${version}`);
        }
    }
};

export function evaluateAudit(audit, lockfile, today = new Date().toISOString().slice(0, 10)) {
    const total = audit.metadata?.vulnerabilities?.total;
    if (total === 0) return { status: 'clean' };

    if (today > AUDIT_ACCEPTANCE.expires) {
        throw new Error(
            `Audit acceptance for ${AUDIT_ACCEPTANCE.advisory} expired on ${AUDIT_ACCEPTANCE.expires}`
        );
    }

    const names = Object.keys(audit.vulnerabilities || {}).sort();
    if (!exactMembers(names, [...AUDIT_ACCEPTANCE.vulnerablePackages].sort())) {
        throw new Error(`Unowned npm audit findings: ${names.join(', ') || 'missing vulnerability detail'}`);
    }
    if (total !== names.length
        || audit.metadata.vulnerabilities.high !== names.length
        || audit.metadata.vulnerabilities.critical !== 0) {
        throw new Error('npm audit severity/counts changed outside the accepted finding');
    }

    const rootFinding = audit.vulnerabilities['brace-expansion'];
    const advisories = rootFinding?.via?.filter(value => typeof value === 'object') || [];
    if (advisories.length !== 1
        || advisories[0].source !== AUDIT_ACCEPTANCE.source
        || !String(advisories[0].url || '').endsWith(`/${AUDIT_ACCEPTANCE.advisory}`)
        || !exactMembers(rootFinding.nodes || [], ['node_modules/brace-expansion'])) {
        throw new Error('The accepted brace-expansion advisory or vulnerable install path changed');
    }

    for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
        if (name === 'brace-expansion') continue;
        const nestedAdvisory = (finding.via || []).some(value => typeof value === 'object');
        const unknownDependency = (finding.via || []).some(value =>
            typeof value === 'string' && !AUDIT_ACCEPTANCE.vulnerablePackages.includes(value));
        if (nestedAdvisory || unknownDependency) {
            throw new Error(`Audit path for ${name} no longer resolves solely to the accepted advisory`);
        }
    }

    requireKnownLock(lockfile);
    return {
        status: 'accepted',
        message: `${AUDIT_ACCEPTANCE.advisory} remains only in the dev-only web-ext 1.x compatibility path; `
            + `compatible 5.x installs are patched. Acceptance expires ${AUDIT_ACCEPTANCE.expires}.`
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
        readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse)
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
