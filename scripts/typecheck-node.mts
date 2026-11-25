// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checks the Node TypeScript project as two programs. Files that need DOM
// types (see domRootFiles: their static, dynamic or type-only import closure
// reaches extension source, or they declare a DOM lib reference) are
// checked with the DOM library (tsconfig.dom.check.json); every other script,
// test and tool is checked without DOM globals (tsconfig.node.check.json), so
// Node code cannot silently start depending on browser types. The split
// follows the files themselves, so there is no hand-kept list to drift, and
// the Node program is rejected if a dependency's declarations pull DOM in.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AUTHORED_SOURCE_ROOTS } from './build-config.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const parseProject = (configPath: string): ts.ParsedCommandLine => {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
        ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
    });
    if (!parsed) throw new Error(`Unable to read ${configPath}.`);
    return parsed;
};

// Every root file that needs DOM types: it imports extension source (whose browser modules are written against DOM and
// extension globals), or declares `/// <reference lib="dom" />` itself
// (browser callbacks evaluated by a Playwright or WebDriver script); or it
// imports such a file directly or through helpers, statically, dynamically or
// type-only. A lib reference applies to its whole program, so
// leaving one in the Node program would give every Node file DOM globals.
export const domRootFiles = (fileNames: readonly string[], options: ts.CompilerOptions, cwd = root): string[] => {
    const browserRoots = AUTHORED_SOURCE_ROOTS.map(directory => path.join(cwd, directory) + path.sep);
    const importers = new Map<string, Set<string>>();
    const marked = new Set<string>();
    const visited = new Set<string>();
    const pending = [...fileNames];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
        if (visited.has(file)) continue;
        visited.add(file);
        const { importedFiles, libReferenceDirectives } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
        if (libReferenceDirectives.some(({ fileName }) => /^dom(?:\.|$)/i.test(fileName))) marked.add(file);
        for (const { fileName } of importedFiles) {
            const resolved = ts.resolveModuleName(fileName, file, options, ts.sys).resolvedModule;
            if (!resolved || resolved.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(resolved.resolvedFileName)) continue;
            const dependency = resolved.resolvedFileName;
            if (browserRoots.some(directory => path.resolve(dependency).startsWith(directory))) { marked.add(file); continue; }
            if (!importers.has(dependency)) importers.set(dependency, new Set());
            importers.get(dependency)!.add(file);
            pending.push(dependency);
        }
    }
    // Walk importer edges back from every file that needs DOM types directly.
    const reached = [...marked];
    for (let file = reached.pop(); file !== undefined; file = reached.pop()) {
        for (const importer of importers.get(file) ?? []) {
            if (!marked.has(importer)) { marked.add(importer); reached.push(importer); }
        }
    }
    return fileNames.filter(file => marked.has(file));
};

// The DOM project lists no files of its own: its roots come from the split.
const NO_INPUTS = new Set([18002, 18003]);

const createChecked = (label: string, fileNames: string[], options: ts.CompilerOptions) => {
    if (!fileNames.length) throw new Error(`The ${label} checking program has no files.`);
    return ts.createProgram({ rootNames: fileNames, options });
};

// DOM library files a program loaded, for example through a dependency's
// `/// <reference lib="dom" />`; the root-file split cannot see those.
export const domLibraryFiles = (program: ts.Program): string[] => program.getSourceFiles()
    .map(file => file.fileName).filter(file => /[\\/]lib\.dom(?:\.[\w.]+)?\.d\.ts$/.test(file));

const leakDiagnostic = (files: string[]): ts.Diagnostic => ({
    category: ts.DiagnosticCategory.Error, code: 0, file: undefined, start: undefined, length: undefined,
    messageText: `The Node checking program loaded DOM declarations (${files.map(file => path.basename(file)).join(', ')}); `
        + 'a dependency or reference pulled them in. Move the importing file to the DOM program or drop the reference.',
});

export const runNodeTypecheck = (cwd = root): number => {
    const node = parseProject(path.join(cwd, 'tsconfig.node.check.json'));
    const dom = parseProject(path.join(cwd, 'tsconfig.dom.check.json'));
    const errors = [...node.errors, ...dom.errors.filter(error => !NO_INPUTS.has(error.code))];
    const domFiles = new Set(domRootFiles(node.fileNames, node.options, cwd));
    const nodeProgram = createChecked('Node', node.fileNames.filter(file => !domFiles.has(file)), node.options);
    const leaked = domLibraryFiles(nodeProgram);
    const diagnostics = [
        ...errors,
        ...(leaked.length ? [leakDiagnostic(leaked)] : []),
        ...ts.getPreEmitDiagnostics(nodeProgram),
        ...ts.getPreEmitDiagnostics(createChecked('DOM test', [...domFiles], dom.options)),
    ];
    if (diagnostics.length) {
        const host: ts.FormatDiagnosticsHost = {
            getCanonicalFileName: file => file, getCurrentDirectory: () => cwd, getNewLine: () => '\n',
        };
        const format = process.stdout.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics;
        process.stdout.write(format(diagnostics, host));
        process.stdout.write(`\nFound ${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'}.\n`);
        return 2;
    }
    return 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = runNodeTypecheck();
}
