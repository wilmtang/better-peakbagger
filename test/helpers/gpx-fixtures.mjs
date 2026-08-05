// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../fixtures/gpx');

export async function readCompressedGpxFixture(name) {
    const encoded = await readFile(path.join(FIXTURE_ROOT, name), 'utf8');
    return gunzipSync(Buffer.from(encoded.replaceAll(/\s/g, ''), 'base64')).toString('utf8');
}
