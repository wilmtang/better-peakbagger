// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A promise a test settles by hand, to hold work at a known point.

export interface Deferred<T = unknown> {
    promise: Promise<T>;
    resolve: (value?: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

export const deferred = <T = unknown,>(): Deferred<T> => {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((yes, no) => { resolve = value => yes(value as T | PromiseLike<T>); reject = no; });
    return { promise, resolve, reject };
};
