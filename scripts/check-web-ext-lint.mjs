// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Reviewed upper limits per warning code and output file. Generated positions
// drift with bundling, and upstream fixes may remove warnings. Neither is a
// regression. New code/file pairs and counts above the reviewed limit fail.
// These limits cannot distinguish a removed warning from a replacement of the
// same type in the same file; dependency source review remains necessary.
// Package versions come from package-lock.json for reporting only.
export const WEB_EXT_WARNING_BASELINE = Object.freeze([
    {
        code: 'BACKGROUND_SERVICE_WORKER_IGNORED',
        file: 'manifest.json',
        count: 1,
        owner: 'cross-browser manifest',
        reason: 'Chrome needs service_worker while Firefox runs the paired scripts entry'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'vendor/maplibre-gl-worker.mjs',
        count: 2,
        owner: 'MapLibre GL JS module worker',
        packageName: 'maplibre-gl',
        reason: 'reviewed upstream optional worker-plugin import paths; Better Peakbagger sets only its fixed local worker URL'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'vendor/maplibre-gl.mjs',
        count: 2,
        owner: 'MapLibre GL JS main module',
        packageName: 'maplibre-gl',
        reason: 'reviewed upstream popup and attribution HTML paths; extension popups use DOM nodes and attribution is validated; the scale control uses textContent'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'content/ascent-editor.js',
        count: 1,
        owner: 'ProseMirror view',
        packageName: 'prosemirror-view',
        reason: 'dependency clipboard parser uses a detached document'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'content/ascent-editor.js',
        count: 1,
        owner: 'TipTap core',
        packageName: '@tiptap/core',
        reason: 'dependency writes its generated stylesheet into a style element'
    }
]);

const fingerprint = warning => JSON.stringify({
    code: warning.code,
    file: warning.file
});

// Occurrences per (code, file). Baseline entries that share a fingerprint —
// two different vendored owners inside one bundle — add their allowances up.
const tally = (items, countOf) => {
    const counts = new Map();
    for (const item of items) {
        const key = fingerprint(item);
        counts.set(key, (counts.get(key) || 0) + countOf(item));
    }
    return counts;
};

const describeKey = key => {
    const { code, file } = JSON.parse(key);
    return `${code} ${file}`;
};

export function evaluateWebExtLint(report, baseline = WEB_EXT_WARNING_BASELINE) {
    if (report.summary?.errors !== 0 || (report.errors || []).length !== 0) {
        throw new Error(`web-ext lint reported ${report.summary?.errors ?? 'unknown'} errors`);
    }
    if (report.summary?.notices !== 0 || (report.notices || []).length !== 0) {
        throw new Error(`web-ext lint reported ${report.summary?.notices ?? 'unknown'} unowned notices`);
    }

    const warnings = report.warnings || [];
    const expected = tally(baseline, warning => warning.count ?? 1);
    const actual = tally(warnings, () => 1);

    const unexpected = [];
    for (const key of new Set([...expected.keys(), ...actual.keys()])) {
        const allowed = expected.get(key) || 0;
        const seen = actual.get(key) || 0;
        if (seen > allowed) unexpected.push(`${describeKey(key)} (${seen}, owned ${allowed})`);
    }
    if (unexpected.length || report.summary?.warnings !== warnings.length) {
        throw new Error([
            unexpected.length ? `new warnings: ${unexpected.join(', ')}` : '',
            report.summary?.warnings !== warnings.length
                ? `warning count mismatch: summary ${report.summary?.warnings}, reported ${warnings.length}`
                : ''
        ].filter(Boolean).join('; '));
    }
    // Owners sharing a code/file pair cannot be distinguished by this report.
    // Report their combined allowance and the actual observed count honestly.
    return [...actual].map(([key, count]) => {
        const owners = baseline.filter(warning => fingerprint(warning) === key);
        return {
            ...JSON.parse(key), count, maxCount: expected.get(key),
            owner: owners.map(warning => warning.owner).join('; '),
            reason: owners.map(warning => warning.reason).join('; '),
        };
    });
}

export function resolveWarningDependencyVersions(packageLock, baseline = WEB_EXT_WARNING_BASELINE) {
    return baseline.map((warning) => {
        if (!warning.packageName) return warning;
        const resolved = packageLock.packages?.[`node_modules/${warning.packageName}`]?.version;
        if (typeof resolved !== 'string' || resolved.trim() === '') {
            throw new Error(`package-lock.json has no resolved version for ${warning.packageName}`);
        }
        return {
            ...warning,
            owner: `${warning.owner} (${warning.packageName} ${resolved})`,
        };
    });
}

function main() {
    const baseline = resolveWarningDependencyVersions(JSON.parse(
        readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
    ));
    const executable = path.join(
        root,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext'
    );
    const result = spawnSync(executable, [
        'lint', '--source-dir', path.join(root, 'dist'), '--output', 'json'
    ], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (!result.stdout.trim()) {
        throw new Error(`web-ext lint produced no JSON: ${result.stderr.trim() || `exit ${result.status}`}`);
    }

    const accepted = evaluateWebExtLint(JSON.parse(result.stdout), baseline);
    const total = accepted.reduce((sum, warning) => sum + warning.count, 0);
    console.log(`web-ext lint passed with ${total} owned warnings:`);
    for (const warning of accepted) {
        console.log(`  - ${warning.code} ×${warning.count} (limit ${warning.maxCount}) in ${warning.file} — ${warning.owner}: ${warning.reason}`);
    }
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
