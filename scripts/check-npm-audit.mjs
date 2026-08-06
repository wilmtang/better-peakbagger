// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// No advisory is accepted. The one bounded exception this gate ever carried —
// GHSA-mh99-v99m-4gvg reaching brace-expansion 1.x through the dev-only
// web-ext/addons-linter/minimatch@3 chain — is gone. A scoped package override
// keeps that path on a patched release without changing the 5.x installs eslint
// resolves, and every finding fails. The later GHSA-rgw5-rvv9-x895 raised the
// patched floors again to 1.1.18 and 5.0.9; the lockfile guard pins both paths.
//
// Re-adding an exception means re-adding the machinery deliberately: an
// advisory id, the exact vulnerable install path, dev-only lock pins, and an
// expiry. Extending a date to unblock a release is not that.
export function evaluateAudit(audit) {
    const counts = audit.metadata?.vulnerabilities;
    if (!counts || typeof counts.total !== 'number') {
        throw new Error('npm audit reported no vulnerability metadata');
    }
    if (counts.total === 0) return { status: 'clean' };

    const names = Object.keys(audit.vulnerabilities || {}).sort();
    const detail = names.length
        ? names.map(name => {
            const finding = audit.vulnerabilities[name];
            const advisories = (finding.via || [])
                .filter(value => typeof value === 'object')
                .map(value => value.url || value.source)
                .join(', ');
            return `${name}${finding.severity ? ` (${finding.severity})` : ''}${advisories ? ` — ${advisories}` : ''}`;
        }).join('; ')
        : 'missing vulnerability detail';
    throw new Error(`Unowned npm audit findings: ${detail}`);
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

    evaluateAudit(JSON.parse(auditRun.stdout));
    console.log('npm audit passed with no vulnerabilities.');
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
