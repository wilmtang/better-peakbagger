// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// All previously accepted advisories now have patched development-tool releases.
// A clean functional suite is not a substitute for a clean dependency graph.
export function evaluateAudit(audit) {
    const counts = audit?.metadata?.vulnerabilities;
    if (!counts || !Number.isSafeInteger(counts.total) || counts.total < 0
        || !audit.vulnerabilities || typeof audit.vulnerabilities !== 'object'
        || Array.isArray(audit.vulnerabilities)) {
        throw new Error('npm audit reported no usable vulnerability metadata');
    }
    const names = Object.keys(audit.vulnerabilities).sort();
    if (counts.total !== 0 || names.length) {
        throw new Error(`Unowned npm audit findings: ${names.join(', ') || 'missing vulnerability detail'}`);
    }
    return { status: 'clean' };
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
