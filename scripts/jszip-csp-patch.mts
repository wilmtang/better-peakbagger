// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

const BEFORE = '"function"!=typeof e&&(e=new Function(""+e));';
const AFTER = 'if("function"!=typeof e)throw new TypeError("ZIP tasks must be functions");';

export function patchJsZipCsp(source: string, version: unknown): string {
    if (version !== '3.10.2' || source.split(BEFORE).length !== 2) {
        throw new Error('Review the JSZip scheduler CSP patch before building this dependency version.');
    }
    return source.replace(BEFORE, AFTER);
}

export const jsZipCspPlugin = (): Plugin => ({
    name: 'jszip-function-only-scheduler',
    setup(context) {
        context.onLoad({ filter: /[/\\]jszip[/\\]dist[/\\]jszip\.min\.js$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            const metadata = JSON.parse(await readFile(path.replace(/dist[/\\]jszip\.min\.js$/, 'package.json'), 'utf8')) as { version?: unknown };
            return { contents: patchJsZipCsp(source, metadata.version), loader: 'js' };
        });
    },
});
