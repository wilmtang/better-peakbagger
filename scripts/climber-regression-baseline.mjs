// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only reconstruction of the audited graph; no checkout or dist writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { ENTRIES, entrySources, root } from './build-config.mjs';

export async function auditedClimberAssets() {
    const revision = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'fdee876e^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
    assert.match(revision, /^[0-9a-f]{40}$/);
    const blob = file => execFileSync('git', ['-c', 'core.fsmonitor=false', 'show', `${revision}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const configuration = blob('scripts/build-config.mjs'), assets = new Map();
    for (const output of ['content/climber-favorite.js', 'content/climber-hover-card.js']) {
        const entry = ENTRIES.find(entry => entry.out === output);
        assert.ok(configuration.includes(`out: '${output}', sources: [${entry.sources.map(source => `'${source}'`).join(', ')}]`),
            'historical bundle composition must match before reconstructing the graph');
        const result = await build({ stdin: { contents: entrySources(entry).map(source => `import ${JSON.stringify(source)};`).join('\n'),
            resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
        plugins: [{ name: 'audited-source', setup(builder) {
            builder.onLoad({ filter: /\.js$/ }, args => {
                const relative = path.relative(root, args.path).split(path.sep).join('/');
                if (!relative.startsWith('src/')) return undefined;
                return { contents: blob(relative), loader: 'js', resolveDir: path.dirname(args.path) };
            });
        } }] });
        assets.set(output, result.outputFiles[0].text);
    }
    assets.set('css/climber-hover-card.css', blob('src/favorites/climber-hover-card.css'));
    return assets;
}
