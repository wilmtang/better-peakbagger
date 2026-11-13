// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Re-exports jsdom's published types under the names earlier tests use.
export { JSDOM } from 'jsdom';
export type { ConstructorOptions as TestDomOptions } from 'jsdom';
import type { JSDOM } from 'jsdom';
export type TestWindow = Window & typeof globalThis;
export type TestDom = JSDOM;
