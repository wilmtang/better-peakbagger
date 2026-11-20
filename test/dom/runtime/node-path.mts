/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POSIX `node:path` for in-page browser tests. Paths name files in the
// checkout, which the DOM tier serves read-only (see node-fs.mts).

declare const __BPB_PROJECT_ROOT__: string;

export const sep = '/';
export const delimiter = ':';

export function normalize(value: string): string {
    const absolute = value.startsWith('/');
    const parts: string[] = [];
    for (const part of value.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
        else if (part !== '..' || !absolute) parts.push(part);
    }
    const joined = parts.join('/');
    return absolute ? `/${joined}` : joined || '.';
}

export const join = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'));
export function resolve(...parts: string[]): string {
    let resolved = '';
    for (const part of parts.reverse()) {
        if (!part) continue;
        resolved = resolved ? `${part}/${resolved}` : part;
        if (part.startsWith('/')) break;
    }
    // The working directory is the checkout, as under `npm test`.
    return normalize(resolved.startsWith('/') ? resolved : `${__BPB_PROJECT_ROOT__}/${resolved}`);
}
export const isAbsolute = (value: string) => value.startsWith('/');
export function dirname(value: string): string {
    const index = value.replace(/\/+$/, '').lastIndexOf('/');
    return index < 0 ? '.' : index === 0 ? '/' : value.slice(0, index);
}
export function basename(value: string, suffix?: string): string {
    const base = value.replace(/\/+$/, '').split('/').at(-1) ?? '';
    return suffix && base.endsWith(suffix) && base !== suffix ? base.slice(0, -suffix.length) : base;
}
export function extname(value: string): string {
    const base = basename(value), index = base.lastIndexOf('.');
    return index <= 0 ? '' : base.slice(index);
}
export function relative(from: string, to: string): string {
    const left = resolve(from).split('/').filter(Boolean), right = resolve(to).split('/').filter(Boolean);
    let shared = 0;
    while (shared < left.length && left[shared] === right[shared]) shared++;
    return [...left.slice(shared).map(() => '..'), ...right.slice(shared)].join('/');
}
export const posix = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative };
export default posix;
