// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Forge is patched. One upstream deepmerge advisory remains in the development
// linter only. Review pins every package, edge and advisory; new releases or
// findings require a fresh review. The default and unknown graphs stay strict.
export const DEVELOPMENT_ADVISORY = Object.freeze({
    url: 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4',
    expiresAt: '2026-10-31T07:00:00Z',
});

function matchesDevelopmentAdvisory(audit, lockfile) {
    const expected = {
        'addons-linter': {
            version: '10.14.0', isDirect: false, via: ['deepmerge'], effects: ['web-ext'],
        },
        'deepmerge': {
            version: '4.3.1', isDirect: false, effects: ['addons-linter'],
        },
        'web-ext': {
            version: '10.8.0', isDirect: true, via: ['addons-linter'], effects: [],
        },
    };
    if (!isDeepStrictEqual(Object.keys(audit.vulnerabilities).sort(), Object.keys(expected).sort())) return false;
    const counts = audit.metadata.vulnerabilities;
    if (counts.total !== 3 || counts.low !== 3
        || ['info', 'moderate', 'high', 'critical'].some(key => counts[key] !== 0)) return false;
    for (const [name, policy] of Object.entries(expected)) {
        const nodePath = `node_modules/${name}`;
        const finding = audit.vulnerabilities[name];
        const resolved = lockfile?.packages?.[nodePath];
        if (finding?.name !== name || finding.severity !== 'low'
            || finding.isDirect !== policy.isDirect || !isDeepStrictEqual(finding.nodes, [nodePath])
            || !isDeepStrictEqual(finding.effects, policy.effects)
            || resolved?.version !== policy.version || resolved.dev !== true
            || Object.keys(lockfile.packages).filter(key => key.endsWith(nodePath)).length !== 1) return false;
        if (policy.via && !isDeepStrictEqual(finding.via, policy.via)) return false;
    }
    const sources = audit.vulnerabilities['deepmerge'].via;
    if (!Array.isArray(sources) || sources.length !== 1) return false;
    const source = sources[0];
    if (source?.source !== 1243505 || source.name !== 'deepmerge'
        || source.dependency !== 'deepmerge' || source.url !== DEVELOPMENT_ADVISORY.url
        || source.severity !== 'low' || source.range !== '>=4.2.0 <=4.3.1') return false;
    return lockfile.packages['node_modules/web-ext'].dependencies?.['addons-linter'] === '10.14.0'
        && lockfile.packages['node_modules/addons-linter'].dependencies?.deepmerge === '4.3.1';
}

export function evaluateAudit(audit, { allowReviewedDevelopmentAdvisory = false,
    lockfile, now = Date.now() } = {}) {
    const counts = audit?.metadata?.vulnerabilities;
    if (!counts || !Number.isSafeInteger(counts.total) || counts.total < 0
        || !audit.vulnerabilities || typeof audit.vulnerabilities !== 'object'
        || Array.isArray(audit.vulnerabilities)) {
        throw new Error('npm audit reported no usable vulnerability metadata');
    }
    const names = Object.keys(audit.vulnerabilities).sort();
    if (counts.total !== 0 || names.length) {
        if (allowReviewedDevelopmentAdvisory && Number.isFinite(now)
            && matchesDevelopmentAdvisory(audit, lockfile)) {
            if (now >= Date.parse(DEVELOPMENT_ADVISORY.expiresAt)) {
                throw new Error(`Reviewed development advisory expired at ${DEVELOPMENT_ADVISORY.expiresAt}: ${DEVELOPMENT_ADVISORY.url}`);
            }
            return { status: 'accepted-development-advisory', ...DEVELOPMENT_ADVISORY };
        }
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

    if (![0, 1].includes(auditRun.status)) {
        throw new Error(`npm audit failed: ${auditRun.stderr.trim() || `exit ${auditRun.status}`}`);
    }
    const allowReviewedDevelopmentAdvisory = process.argv.includes('--allow-reviewed-development-advisory');
    const lockfile = allowReviewedDevelopmentAdvisory
        ? JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')) : undefined;
    const result = evaluateAudit(JSON.parse(auditRun.stdout), { allowReviewedDevelopmentAdvisory, lockfile });
    if (result.status === 'clean') console.log('npm audit passed with no vulnerabilities.');
    else console.log(`Accepted development-only advisory ${result.url} until ${result.expiresAt}. Raw npm audit still reports three low affected packages; the default audit remains strict.`);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
