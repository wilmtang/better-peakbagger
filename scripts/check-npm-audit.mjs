// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// All previously accepted advisories now have patched development-tool releases.
// A clean functional suite is not a substitute for a clean dependency graph.
// The owner-approved node-forge exception is explicit, development-only,
// exact-path and time-limited. The default stays strict; the 3.9.0 release
// explicitly opts into the same exception without changing its scope or expiry.
export const DEVELOPMENT_ADVISORY = Object.freeze({
    url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
    expiresAt: '2026-10-17T07:00:00Z',
});

function acceptsDevelopmentAdvisory(audit, lockfile, now) {
    const expires = Date.parse(DEVELOPMENT_ADVISORY.expiresAt);
    if (!Number.isFinite(now) || now >= expires) return false;
    const expected = {
        '@devicefarmer/adbkit': {
            version: '3.3.9', isDirect: false, via: ['node-forge'], effects: ['web-ext'],
        },
        'node-forge': {
            version: '1.4.0', isDirect: false, effects: ['@devicefarmer/adbkit'],
        },
        'web-ext': {
            version: '10.7.0', isDirect: true, via: ['@devicefarmer/adbkit'], effects: [],
        },
    };
    if (!isDeepStrictEqual(Object.keys(audit.vulnerabilities).sort(), Object.keys(expected).sort())) return false;
    const counts = audit.metadata.vulnerabilities;
    if (counts.total !== 3 || counts.high !== 3
        || ['info', 'low', 'moderate', 'critical'].some(key => counts[key] !== 0)) return false;
    for (const [name, policy] of Object.entries(expected)) {
        const nodePath = `node_modules/${name}`;
        const finding = audit.vulnerabilities[name];
        const resolved = lockfile?.packages?.[nodePath];
        if (finding?.name !== name || finding.severity !== 'high'
            || finding.isDirect !== policy.isDirect || !isDeepStrictEqual(finding.nodes, [nodePath])
            || !isDeepStrictEqual(finding.effects, policy.effects)
            || resolved?.version !== policy.version || resolved.dev !== true
            || Object.keys(lockfile.packages).filter(key => key.endsWith(nodePath)).length !== 1) return false;
        if (policy.via && !isDeepStrictEqual(finding.via, policy.via)) return false;
    }
    const sources = audit.vulnerabilities['node-forge'].via;
    if (!Array.isArray(sources) || sources.length !== 1) return false;
    const source = sources[0];
    if (source?.source !== 1240912 || source.name !== 'node-forge'
        || source.dependency !== 'node-forge' || source.url !== DEVELOPMENT_ADVISORY.url
        || source.severity !== 'high' || source.range !== '<=1.4.0') return false;
    return lockfile.packages['node_modules/web-ext'].dependencies?.['@devicefarmer/adbkit'] === '3.3.9'
        && lockfile.packages['node_modules/@devicefarmer/adbkit'].dependencies?.['node-forge'] === '^1.3.1';
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
        if (allowReviewedDevelopmentAdvisory && acceptsDevelopmentAdvisory(audit, lockfile, now)) {
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
    else console.log(`Accepted development-only advisory ${result.url} until ${result.expiresAt}. Raw npm audit still reports three high findings; the default audit remains strict.`);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
