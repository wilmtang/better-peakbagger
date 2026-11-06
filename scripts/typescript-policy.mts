// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// These are output or upstream-code boundaries, not exceptions for authored
// tests, fixtures, evidence scripts, configuration or store-asset tooling.
export const JAVASCRIPT_EXCLUDED_ROOTS = Object.freeze([
    'dist/', 'node_modules/', 'web-ext-artifacts/', 'browser-evidence/', 'third_party/',
]);

export function typescriptPolicyViolations(paths: readonly string[]): string[] {
    return [...new Set(paths)].filter(file => /\.(?:[cm]?js|jsx)$/i.test(file)
        && !JAVASCRIPT_EXCLUDED_ROOTS.some(prefix => file.startsWith(prefix))).sort();
}

// Reference-only migration edits must not force an unrelated caller rewrite.
// Preserve every other byte, including comments, whitespace and quote style.
export function isMechanicalTypeScriptReferenceUpdate(before: string, after: string): boolean {
    if (before.length !== after.length || before === after) return false;
    const source = ts.createSourceFile('legacy.js', before, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const replacements: { start: number; end: number; value: string }[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) && /^[\w./@-]+\.(?:js|mjs|cjs)$/.test(node.text)) {
            const start = node.getStart(source), raw = before.slice(start, node.end);
            const value = raw.replace(/\.(mjs|cjs|js)(['"`])$/, (_all, extension: string, quote: string) =>
                `.${extension === 'mjs' ? 'mts' : extension === 'cjs' ? 'cts' : 'ts'}${quote}`);
            if (value !== raw && after.slice(start, node.end) === value) replacements.push({ start, end: node.end, value });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    let updated = before;
    for (const item of replacements.reverse()) updated = updated.slice(0, item.start) + item.value + updated.slice(item.end);
    return replacements.length > 0 && updated === after;
}

export type PolicySelection = { kind: 'staged' } | { kind: 'committed'; base: string };

export function policySelection(args: readonly string[]): PolicySelection {
    if (!args.length || (args.length === 1 && args[0] === '--staged')) return { kind: 'staged' };
    if (args.length === 2 && args[0] === '--base' && args[1] && !args[1].startsWith('-')) {
        return { kind: 'committed', base: args[1] };
    }
    throw new Error('Usage: typescript-policy.mts [--staged | --base REVISION]');
}

export function changedPolicyPaths(selection: PolicySelection, cwd: string): string[] {
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Deletions are allowed. Disabling rename detection makes a JS -> TS rename
    // an allowed deletion plus a TS addition, and a JS -> JS move a rejected add.
    const diff = ['--name-only', '-z', '--no-renames', '--diff-filter=ACMTUXB'];
    let output: string;
    if (selection.kind === 'staged') {
        output = git(['diff', '--cached', ...diff, '--']);
    } else if (/^0+$/.test(selection.base)) {
        // GitHub's initial-push before SHA denotes an empty tree. Inspect every
        // committed path rather than treating that special case as a skipped gate.
        output = git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
    } else {
        const base = git(['rev-parse', '--verify', '--end-of-options', `${selection.base}^{commit}`]).trim();
        output = git(['diff', ...diff, base, 'HEAD', '--']);
    }
    return output.split('\0').filter(Boolean);
}

export function runTypeScriptPolicy(args: readonly string[], cwd: string): void {
    const selection = policySelection(args), paths = changedPolicyPaths(selection, cwd);
    const read = (revision: string, file: string) => {
        try { return execFileSync('git', ['-c', 'core.fsmonitor=false', 'show', `${revision}:${file}`],
            { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch { return null; } // Missing/new files and unreadable comparisons remain rejected.
    };
    const violations = typescriptPolicyViolations(paths).filter(file => {
        const before = read(selection.kind === 'staged' ? 'HEAD' : selection.base, file);
        const after = read(selection.kind === 'staged' ? '' : 'HEAD', file);
        return before === null || after === null || !isMechanicalTypeScriptReferenceUpdate(before, after);
    });
    if (violations.length) {
        throw new Error('Convert new or modified authored JavaScript files to TypeScript:\n'
            + violations.map(file => `- ${JSON.stringify(file)}`).join('\n')
            + '\nUse .ts for browser modules and .mts for Node ESM; update callers and preserve generated .js output.');
    }
    console.log(`TypeScript policy passed (${paths.length} changed paths examined).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runTypeScriptPolicy(process.argv.slice(2), process.cwd());
    } catch (error) {
        console.error(error instanceof Error && !('status' in error)
            ? error.message
            : 'TypeScript policy could not inspect the requested Git comparison.');
        process.exitCode = 1;
    }
}
