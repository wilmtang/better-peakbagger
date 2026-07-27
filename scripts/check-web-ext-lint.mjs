// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const WEB_EXT_WARNING_BASELINE = Object.freeze([
    {
        code: 'BACKGROUND_SERVICE_WORKER_IGNORED',
        file: 'manifest.json',
        line: null,
        column: null,
        owner: 'cross-browser manifest',
        reason: 'Chrome needs service_worker while Firefox runs the paired scripts entry'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'vendor/maplibre-gl-csp.js',
        line: 5,
        column: 872687,
        owner: 'MapLibre GL JS 5.24.0',
        reason: 'pinned vendored renderer code'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'vendor/maplibre-gl-csp.js',
        line: 5,
        column: 942114,
        owner: 'MapLibre GL JS 5.24.0',
        reason: 'pinned vendored renderer code'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'vendor/maplibre-gl-csp.js',
        line: 5,
        column: 966365,
        owner: 'MapLibre GL JS 5.24.0',
        reason: 'pinned vendored renderer code'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'content/ascent-editor.js',
        line: 11962,
        column: 5,
        owner: 'ProseMirror view 1.42.1',
        reason: 'dependency clipboard parser uses a detached document'
    },
    {
        code: 'UNSAFE_VAR_ASSIGNMENT',
        file: 'content/ascent-editor.js',
        line: 17484,
        column: 5,
        owner: 'TipTap core 3.28.0',
        reason: 'dependency writes its generated stylesheet into a style element'
    }
]);

const fingerprint = warning => JSON.stringify({
    code: warning.code,
    file: warning.file,
    line: warning.line ?? null,
    column: warning.column ?? null
});

export function evaluateWebExtLint(report, baseline = WEB_EXT_WARNING_BASELINE) {
    if (report.summary?.errors !== 0 || (report.errors || []).length !== 0) {
        throw new Error(`web-ext lint reported ${report.summary?.errors ?? 'unknown'} errors`);
    }
    if (report.summary?.notices !== 0 || (report.notices || []).length !== 0) {
        throw new Error(`web-ext lint reported ${report.summary?.notices ?? 'unknown'} unowned notices`);
    }

    const expected = new Map(baseline.map(warning => [fingerprint(warning), warning]));
    const actual = new Map((report.warnings || []).map(warning => [fingerprint(warning), warning]));
    const unexpected = [...actual.keys()].filter(key => !expected.has(key));
    const missing = [...expected.keys()].filter(key => !actual.has(key));
    if (unexpected.length || missing.length || report.summary?.warnings !== actual.size) {
        const describe = keys => keys.map(key => {
            const warning = actual.get(key) || expected.get(key);
            return `${warning.code} ${warning.file}:${warning.line ?? '-'}:${warning.column ?? '-'}`;
        }).join(', ');
        throw new Error([
            unexpected.length ? `new warnings: ${describe(unexpected)}` : '',
            missing.length ? `baseline warnings disappeared or moved: ${describe(missing)}` : '',
            report.summary?.warnings !== actual.size
                ? `warning count mismatch: summary ${report.summary?.warnings}, unique ${actual.size}`
                : ''
        ].filter(Boolean).join('; '));
    }

    return baseline.map(({ code, file, owner, reason }) => ({ code, file, owner, reason }));
}

function main() {
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
    console.log(`web-ext lint passed with ${accepted.length} owned warnings:`);
    for (const warning of accepted) {
        console.log(`  - ${warning.code} in ${warning.file} — ${warning.owner}: ${warning.reason}`);
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
