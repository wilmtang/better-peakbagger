// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Provider timing ownership. The page realm owns fetch, bounded body reading,
// parsing, and result construction. The worker's non-abortable executeScript
// race is deliberately longer only to bound dispatch and structured cloning.

export const PROVIDER_OWNERSHIP_TIMEOUT_MS = 8000;
export const PROVIDER_EXPORT_TIMEOUT_MS = 30000;
export const PROVIDER_BROWSER_MARGIN_MS = 2000;
export const PROVIDER_CAPTURE_OPERATION_TIMEOUT_MS =
    PROVIDER_EXPORT_TIMEOUT_MS + PROVIDER_BROWSER_MARGIN_MS;
export const PROVIDER_PAGE_OPERATION_TIMEOUT_MS = 20000;

export const providerTiming = {
    PROVIDER_OWNERSHIP_TIMEOUT_MS,
    PROVIDER_EXPORT_TIMEOUT_MS,
    PROVIDER_BROWSER_MARGIN_MS,
    PROVIDER_CAPTURE_OPERATION_TIMEOUT_MS,
    PROVIDER_PAGE_OPERATION_TIMEOUT_MS,
};
