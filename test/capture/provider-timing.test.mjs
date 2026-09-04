// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROVIDER_BROWSER_MARGIN_MS,
    PROVIDER_CAPTURE_OPERATION_TIMEOUT_MS,
    PROVIDER_EXPORT_TIMEOUT_MS,
    PROVIDER_OWNERSHIP_TIMEOUT_MS,
    PROVIDER_PAGE_OPERATION_TIMEOUT_MS,
} from '../../src/capture/provider-timing.js';

test('provider timing gives page export ownership before the worker margin', () => {
    assert.equal(PROVIDER_CAPTURE_OPERATION_TIMEOUT_MS,
        PROVIDER_EXPORT_TIMEOUT_MS + PROVIDER_BROWSER_MARGIN_MS);
    assert.ok(PROVIDER_BROWSER_MARGIN_MS > 0);
    assert.ok(PROVIDER_OWNERSHIP_TIMEOUT_MS < PROVIDER_PAGE_OPERATION_TIMEOUT_MS);
    assert.ok(PROVIDER_EXPORT_TIMEOUT_MS < PROVIDER_CAPTURE_OPERATION_TIMEOUT_MS);
});
