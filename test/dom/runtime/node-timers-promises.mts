/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `node:timers/promises` for in-page browser tests.

export const setTimeout = <T = void, >(delay = 0, value?: T) =>
    new Promise<T>(resolve => { globalThis.setTimeout(() => resolve(value as T), delay); });
export const setImmediate = <T = void, >(value?: T) => setTimeout(0, value);
export default { setTimeout, setImmediate };
