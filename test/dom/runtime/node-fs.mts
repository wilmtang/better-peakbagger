/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Read-only `node:fs` and `node:fs/promises` for in-page browser tests. The
// DOM tier serves files inside the checkout at FILE_ROUTE and refuses every
// other path. Reads are synchronous XHRs or fetches to that route; there are
// no writes, so a browser test cannot change the tree it reads.

import { fileURLToPath } from './node-url.mts';

export const FILE_ROUTE = '/__bpb_fs__';
type PathLike = string | URL;
type Encoding = 'utf8' | 'utf-8' | { encoding?: 'utf8' | 'utf-8' | null } | null | undefined;

// Relative paths resolve against the checkout, the working directory
// `npm test` runs Node tests from.
declare const __BPB_PROJECT_ROOT__: string;
const toPath = (value: PathLike) => {
    const file = typeof value === 'string' ? value : fileURLToPath(value);
    return file.startsWith('/') ? file : `${__BPB_PROJECT_ROOT__}/${file.replace(/^\.\//, '')}`;
};
const routeFor = (value: PathLike) => `${FILE_ROUTE}${toPath(value).split('/').map(encodeURIComponent).join('/')}`;
const wantsText = (encoding: Encoding) => typeof encoding === 'string' || (typeof encoding === 'object' && !!encoding?.encoding);

// Like Node's readFile(path, 'utf8'), keep a leading byte order mark.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

const notFound = (file: PathLike) => Object.assign(new Error(`ENOENT: no such file or directory, open '${toPath(file)}'`), { code: 'ENOENT' });

export function readFileSync(file: PathLike, encoding?: Encoding): string | Uint8Array {
    const request = new XMLHttpRequest();
    request.open('GET', routeFor(file), false);
    // Synchronous requests cannot set responseType; keep each byte in one
    // UTF-16 unit and decode below.
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send();
    if (request.status === 404) throw notFound(file);
    if (request.status !== 200) throw new Error(`Unable to read ${toPath(file)}: HTTP ${request.status}`);
    const bytes = Uint8Array.from(request.responseText, character => character.charCodeAt(0) & 0xff);
    return wantsText(encoding) ? utf8.decode(bytes) : bytes;
}

export const existsSync = (file: PathLike) => {
    try { readFileSync(file); return true; } catch { return false; }
};

export async function readFile(file: PathLike, encoding?: Encoding): Promise<string | Uint8Array> {
    const response = await fetch(routeFor(file));
    if (response.status === 404) throw notFound(file);
    if (!response.ok) throw new Error(`Unable to read ${toPath(file)}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return wantsText(encoding) ? utf8.decode(bytes) : bytes;
}

const unsupported = (name: string) => () => { throw new Error(`fs.${name} is not available to browser tests.`); };
export const writeFile = unsupported('writeFile');
export const writeFileSync = unsupported('writeFileSync');
export const promises = { readFile };
export default { readFileSync, existsSync, readFile, promises };
