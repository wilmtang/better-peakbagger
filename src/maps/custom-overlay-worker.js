// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseCustomData } from './custom-overlay-data.js';
self.onmessage = event => {
    try { self.postMessage({ ok: true, value: parseCustomData(event.data) }); }
    catch { self.postMessage({ ok: false, error: 'Invalid or oversized vector data.' }); }
};
