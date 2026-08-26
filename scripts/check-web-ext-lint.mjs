// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One entry per owned warning. Identity is (code, file) plus how many times
// that pair may appear — deliberately not the line and column.
//
// Every owned warning except the manifest one sits inside vendored code that
// esbuild bundles, so its line and column are a byte offset into generated
// output. Pinning them made an unrelated source edit anywhere in the same
// bundle fail this gate as "baseline warnings disappeared or moved", and the
// only available repair was to paste the new offsets back in — a re-baselining
// step that reviews nothing and, done often enough, trains the reader to
// accept a moved warning without checking whether it is still the same one.
// Counting occurrences per file keeps what the gate is actually for: no new
// warning, no owned warning silently disappearing, and nothing unowned.
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
        owner: 'MapLibre GL JS 6.2.0 module worker',
        packageName: 'maplibre-gl',
        packageVersion: '6.2.0',
        reason: 'reviewed upstream optional worker-plugin import paths; Better Peakbagger sets only its fixed local worker URL'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'vendor/maplibre-gl.mjs',
        count: 3,
        owner: 'MapLibre GL JS 6.2.0 main module',
        packageName: 'maplibre-gl',
        packageVersion: '6.2.0',
        reason: 'reviewed upstream popup, attribution, and scale HTML paths; extension popups use DOM nodes and attribution is validated'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'content/ascent-editor.js',
        count: 1,
        owner: 'ProseMirror view 1.42.1',
        packageName: 'prosemirror-view',
        packageVersion: '1.42.1',
        reason: 'dependency clipboard parser uses a detached document'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'content/ascent-editor.js',
        count: 1,
        owner: 'TipTap core 3.30.1',
        packageName: '@tiptap/core',
        packageVersion: '3.30.1',
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
    const total = [...expected.values()].reduce((sum, count) => sum + count, 0);

    const unexpected = [];
    const missing = [];
    for (const key of new Set([...expected.keys(), ...actual.keys()])) {
        const allowed = expected.get(key) || 0;
        const seen = actual.get(key) || 0;
        if (seen > allowed) unexpected.push(`${describeKey(key)} (${seen}, owned ${allowed})`);
        else if (seen < allowed) missing.push(`${describeKey(key)} (${seen}, owned ${allowed})`);
    }
    if (unexpected.length || missing.length || report.summary?.warnings !== warnings.length) {
        throw new Error([
            unexpected.length ? `new warnings: ${unexpected.join(', ')}` : '',
            missing.length ? `baseline warnings disappeared: ${missing.join(', ')}` : '',
            report.summary?.warnings !== warnings.length
                ? `warning count mismatch: summary ${report.summary?.warnings}, reported ${warnings.length}`
                : ''
        ].filter(Boolean).join('; '));
    }
    if (warnings.length !== total) {
        throw new Error(`warning count mismatch: reported ${warnings.length}, owned ${total}`);
    }

    return baseline.map(({ code, file, count, owner, reason }) =>
        ({ code, file, count: count ?? 1, owner, reason }));
}

export function validateWarningDependencyVersions(packageLock, baseline = WEB_EXT_WARNING_BASELINE) {
    for (const warning of baseline.filter((entry) => entry.packageName)) {
        const resolved = packageLock.packages?.[`node_modules/${warning.packageName}`]?.version;
        if (warning.packageVersion !== resolved) {
            throw new Error(
                `${warning.owner} warning acceptance is stale: package-lock.json resolves `
                + `${warning.packageName}@${resolved || 'missing'}`,
            );
        }
    }
}

function main() {
    validateWarningDependencyVersions(JSON.parse(
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

    const accepted = evaluateWebExtLint(JSON.parse(result.stdout));
    const total = accepted.reduce((sum, warning) => sum + warning.count, 0);
    console.log(`web-ext lint passed with ${total} owned warnings:`);
    for (const warning of accepted) {
        console.log(`  - ${warning.code} ×${warning.count} in ${warning.file} — ${warning.owner}: ${warning.reason}`);
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
