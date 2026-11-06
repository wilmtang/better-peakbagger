// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Advisories in build and test tooling are reported but do not fail the gate,
// which requires zero advisories only in code that can reach a user. npm's own
// dev flag cannot draw that line here: package.json lists shipped libraries such
// as TipTap and MapLibre under devDependencies, so `--omit=dev` would stop
// auditing them. Every direct dependency not named below therefore counts as
// shipped, including new ones, and so does anything those packages depend on.
export const DEVELOPMENT_TOOLS: ReadonlySet<string> = new Set([
    '@types/chrome', '@types/node', '@types/selenium-webdriver', 'esbuild', 'eslint', 'fake-indexeddb',
    'globals', 'jiti', 'jsdom', 'playwright', 'selenium-webdriver', 'semver', 'typescript',
    'typescript-eslint', 'web-ext',
]);

type AuditFinding = { severity?: string; nodes?: string[] };
export type AuditReport = {
    metadata?: { vulnerabilities?: Record<string, number> };
    vulnerabilities?: Record<string, AuditFinding>;
};
type Dependencies = Record<string, string>;
export type PackageManifest = {
    dependencies?: Dependencies;
    devDependencies?: Dependencies;
    optionalDependencies?: Dependencies;
    peerDependencies?: Dependencies;
};
export type Lockfile = { packages?: Record<string, PackageManifest> };
type AuditGraph = { lockfile?: Lockfile; packageJson?: PackageManifest };
type AuditResult = { status: 'clean' } | { status: 'development-only'; names: string[] };

// Mirrors Node's lookup: the nearest node_modules directory on the way to the root.
function resolveInstalled(packages: NonNullable<Lockfile['packages']>, from: string, name: string) {
    for (let base = from; ; base = base.slice(0, Math.max(0, base.lastIndexOf('/node_modules/')))) {
        const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
        if (packages[candidate]) return candidate;
        if (!base) return null;
    }
}

export function shippedPackagePaths({ lockfile, packageJson }: AuditGraph): Set<string> | null {
    const packages = lockfile?.packages;
    if (!packages || !packageJson) return null;
    const direct = { ...packageJson.dependencies, ...packageJson.optionalDependencies, ...packageJson.devDependencies };
    const pending = Object.keys(direct).filter(name => !DEVELOPMENT_TOOLS.has(name))
        .map(name => resolveInstalled(packages, '', name));
    const shipped = new Set<string>();
    while (pending.length) {
        const current = pending.pop();
        if (!current || shipped.has(current)) continue;
        shipped.add(current);
        const { dependencies, optionalDependencies, peerDependencies } = packages[current];
        for (const name of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies })) {
            pending.push(resolveInstalled(packages, current, name));
        }
    }
    return shipped;
}

export function evaluateAudit(audit: AuditReport | null, graph: AuditGraph = {}): AuditResult {
    const counts = audit?.metadata?.vulnerabilities;
    const findings = audit?.vulnerabilities;
    if (!counts || !Number.isSafeInteger(counts.total) || counts.total < 0
        || !findings || typeof findings !== 'object' || Array.isArray(findings)) {
        throw new Error('npm audit reported no usable vulnerability metadata');
    }
    const names = Object.keys(findings).sort();
    if (counts.total === 0 && !names.length) return { status: 'clean' };
    // Without the graph, or without a location, nothing can be shown to be tooling.
    const shipped = shippedPackagePaths(graph);
    const unowned = names.filter(name => {
        const nodes = findings[name]?.nodes;
        return !shipped || !Array.isArray(nodes) || !nodes.length
            || nodes.some(node => shipped.has(node) || !graph.lockfile?.packages?.[node]);
    });
    if (unowned.length || !names.length) {
        throw new Error(`Unowned npm audit findings: ${unowned.join(', ') || 'missing vulnerability detail'}`);
    }
    return { status: 'development-only', names };
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

    if (auditRun.status !== 0 && auditRun.status !== 1) {
        throw new Error(`npm audit failed: ${auditRun.stderr.trim() || `exit ${auditRun.status}`}`);
    }
    const [lockfile, packageJson] = await Promise.all(['package-lock.json', 'package.json']
        .map(async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))));
    const result = evaluateAudit(JSON.parse(auditRun.stdout), { lockfile, packageJson });
    if (result.status === 'clean') console.log('npm audit passed with no vulnerabilities.');
    else console.log(`npm audit passed: no advisories in shipped code. Development tooling only: ${result.names.join(', ')}.`);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error: Error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
