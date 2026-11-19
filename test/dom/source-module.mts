// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import type { DomContext } from '../../scripts/dom-tier.mts';

// Serve a private, standalone TypeScript module without adding a test export
// to a shipped extension bundle.
export async function openSourceModule({ route, open }: DomContext, {
    source, pagePath, html,
}: { source: URL; pagePath: string; html: string }): Promise<string> {
    const { code } = await transform(await readFile(source, 'utf8'), {
        sourcefile: path.basename(fileURLToPath(source)), loader: 'ts', format: 'esm',
    });
    const modulePath = '/fixture/source-module.js';
    await route(modulePath, code, 'text/javascript');
    await route(pagePath, html);
    await open(pagePath);
    return modulePath;
}
