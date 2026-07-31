// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// First content script on every Peakbagger document. Keep this entry free of
// settings-schema/storage imports: its whole purpose is to put dark pixels on
// screen before the full theme bundle is parsed.

import { themeResolve } from './theme-resolve.js';
import { applyEarlyTheme } from './theme-bootstrap.js';

applyEarlyTheme({
    document,
    resolveTheme: preference => themeResolve.resolve(preference),
});
