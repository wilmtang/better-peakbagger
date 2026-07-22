// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function walkFiles(directory, predicate = () => true) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walkFiles(file, predicate));
        else if (entry.isFile() && predicate(file)) files.push(file);
    }
    return files.sort();
}
