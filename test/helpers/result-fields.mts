// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests assert on a discriminated result's fields directly, such as a failure's
// error code, without first narrowing to the variant: an assertion on a field
// the actual variant lacks fails on its undefined value. fieldsOf exposes every
// variant's fields as optional, each typed as the union of its variants' types.

type KeysOf<T> = T extends unknown ? keyof T : never;
type ValueOf<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
export type Fields<T> = { [K in KeysOf<T>]?: ValueOf<T, K> };

export const fieldsOf = <T extends object>(result: T): Fields<T> => result as Fields<T>;
