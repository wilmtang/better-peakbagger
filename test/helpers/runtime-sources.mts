// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { AUTHORED_SOURCE_ROOTS, root } from '../../scripts/build-config.mts';
import { walkFiles } from './walk-files.mts';

const excludedDirectories = new Set(['node_modules', 'dist', 'web-ext-artifacts', 'browser-evidence', 'third_party', 'vendor', '.git']);
export function isRuntimeSource(file: string): boolean {
    const parts = file.replaceAll('\\', '/').split('/');
    return !parts.some(part => excludedDirectories.has(part)) && !/\.d\.[cm]?ts$/i.test(file)
        && /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/i.test(file);
}
export async function runtimeSourceFiles(repositoryRoot = root): Promise<string[]> {
    const groups = await Promise.all(AUTHORED_SOURCE_ROOTS.map((directory: string) =>
        walkFiles(path.join(repositoryRoot, directory), isRuntimeSource, file => !excludedDirectories.has(path.basename(file)))));
    return groups.flat().sort();
}
export interface RuntimeSource { file: string; text: string; variants: string[]; }
export function sourceVariants(file: string, text: string): string[] {
    const transpile = (code: string) => ts.transpileModule(code, {fileName: file.endsWith('.tsx') ? 'policy.tsx' : 'policy.ts', compilerOptions: {
        target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, removeComments: false,
    }}).outputText;
    // Preserve the raw check as well: formatting-sensitive policies must not
    // lose evidence while TypeScript annotations and generic calls are erased.
    if (/\.[cm]?tsx?$/i.test(file)) return [text, transpile(text)];
    if (/\.svelte$/i.test(file)) return [text, text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
        (_match: string, open: string, code: string, close: string) => open + transpile(code) + close)];
    return [text];
}
export async function runtimeSources(repositoryRoot = root): Promise<RuntimeSource[]> {
    return Promise.all((await runtimeSourceFiles(repositoryRoot)).map(async absolute => {
        const file = path.relative(repositoryRoot, absolute).split(path.sep).join('/');
        const text = await readFile(absolute, 'utf8');
        return {file, text, variants: sourceVariants(file, text)};
    }));
}
