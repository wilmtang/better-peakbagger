/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from 'node:module';
export type TestWindow = Window & typeof globalThis;
export interface TestDomOptions { contentType?: string; url?: string; runScripts?: string; pretendToBeVisual?: boolean; }
export interface TestDom { window: TestWindow; getInternalVMContext(): import('node:vm').Context; }
export const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html?: string, options?: TestDomOptions) => TestDom };
