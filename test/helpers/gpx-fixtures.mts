// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/gpx');

export async function readCompressedGpxFixture(name: string): Promise<string> {
    const encoded = await readFile(path.join(FIXTURE_ROOT, name), 'utf8');
    const binary = atob(encoded.replaceAll(/\s/g, ''));
    const compressed = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        compressed[index] = binary.charCodeAt(index);
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}
