/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `node:url` file URL helpers for in-page browser tests.

export function fileURLToPath(value: string | URL): string {
    const url = typeof value === 'string' ? new URL(value) : value;
    if (url.protocol !== 'file:') throw new TypeError(`The URL must be of scheme file: ${url.href}`);
    return decodeURIComponent(url.pathname);
}
export const pathToFileURL = (value: string) => new URL(`file://${value.split('/').map(encodeURIComponent).join('/')}`);
const URLClass = globalThis.URL, URLSearchParamsClass = globalThis.URLSearchParams;
export { URLClass as URL, URLSearchParamsClass as URLSearchParams };
export default { fileURLToPath, pathToFileURL, URL: URLClass, URLSearchParams: URLSearchParamsClass };
