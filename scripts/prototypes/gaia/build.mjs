// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const prototypeDist = path.resolve(here, '../../../web-ext-artifacts/gaia-prototype/dist');

export async function buildGaiaPrototype(outdir = prototypeDist) {
    await mkdir(outdir, { recursive: true });
    for (const name of ['background', 'popup', 'source']) {
        await build({
            entryPoints: [path.join(here, `${name}.mjs`)],
            outfile: path.join(outdir, `${name}.js`),
            bundle: true,
            format: 'iife',
            target: 'chrome128',
            platform: 'browser',
            ...(name === 'source' ? {
                globalName: '__bpbGaiaSource',
                footer: { js: '__bpbGaiaSource.readSourceGpx();' },
            } : {}),
        });
    }
    for (const name of ['manifest.json', 'popup.html']) await copyFile(path.join(here, name), path.join(outdir, name));
    return outdir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.log(await buildGaiaPrototype());
}
