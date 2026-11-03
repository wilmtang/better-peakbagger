/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from 'node:module';
export const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options?: {contentType?: string}) => {window: {document: Document; close(): void}};
};
