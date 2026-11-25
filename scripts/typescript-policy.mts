// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These are output or upstream-code boundaries, not exceptions for authored
// tests, fixtures, evidence scripts, configuration or store-asset tooling.
export const JAVASCRIPT_EXCLUDED_ROOTS = Object.freeze([
    'dist/', 'node_modules/', 'web-ext-artifacts/', 'browser-evidence/', 'third_party/',
]);

export function typescriptPolicyViolations(paths: readonly string[]): string[] {
    return [...new Set(paths)].filter(file => /\.(?:[cm]?js|jsx)$/i.test(file)
        && !JAVASCRIPT_EXCLUDED_ROOTS.some(prefix => file.startsWith(prefix))).sort();
}

export type PolicySelection = 'staged' | 'committed';

export function policySelection(args: readonly string[]): PolicySelection {
    if (!args.length || (args.length === 1 && args[0] === '--staged')) return 'staged';
    if (args.length === 1 && args[0] === '--committed') return 'committed';
    throw new Error('Usage: typescript-policy.mts [--staged | --committed]');
}

export function trackedPolicyPaths(selection: PolicySelection, cwd: string): string[] {
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Scan the complete snapshot even when invoked from a subdirectory.
    const output = selection === 'staged'
        ? git(['--no-literal-pathspecs', 'ls-files', '--cached', '--full-name', '-z', '--', ':/'])
        : git(['ls-tree', '-r', '--full-tree', '--name-only', '-z', 'HEAD']);
    return output.split('\0').filter(Boolean);
}

export function runTypeScriptPolicy(args: readonly string[], cwd: string): void {
    const selection = policySelection(args);
    const paths = trackedPolicyPaths(selection, cwd);
    const violations = typescriptPolicyViolations(paths);
    if (violations.length) {
        throw new Error('Convert tracked authored JavaScript files to TypeScript:\n'
            + violations.map(file => `- ${JSON.stringify(file)}`).join('\n')
            + '\nUse .ts for browser modules and .mts for Node ESM; update callers and preserve generated .js output.');
    }
    console.log(`TypeScript policy passed (${paths.length} tracked paths examined in the ${selection === 'staged' ? 'index' : 'committed tree'}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runTypeScriptPolicy(process.argv.slice(2), process.cwd());
    } catch (error) {
        console.error(error instanceof Error && !('status' in error)
            ? error.message
            : 'TypeScript policy could not inspect the requested Git snapshot.');
        process.exitCode = 1;
    }
}
