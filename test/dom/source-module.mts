// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { DomContext } from '../../scripts/dom-tier.mts';

// Serve a private TypeScript module without adding a test export
// to a shipped extension bundle.
export async function openSourceModule({ route, open }: DomContext, {
    source, pagePath, html,
}: { source: URL; pagePath: string; html: string }): Promise<string> {
    const { outputFiles } = await build({
        entryPoints: [fileURLToPath(source)], bundle: true, write: false, format: 'esm', platform: 'browser',
    });
    assert.equal(outputFiles.length, 1, 'a source fixture must emit one JavaScript module');
    const modulePath = '/fixture/source-module.js';
    await route(modulePath, outputFiles[0]!.text, 'text/javascript');
    await route(pagePath, html);
    await open(pagePath);
    return modulePath;
}
