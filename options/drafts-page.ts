// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — entry point for the standalone trip-report draft manager.
//
// The manager itself is options/drafts.ts, unchanged: it only ever needed its
// own nine elements and a way to report transient status, never anything else
// on the Settings page. This page supplies both.

import { initDrafts } from './drafts.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';

const extensionApi = (globalThis as { browser?: typeof chrome }).browser || globalThis.chrome;
const byId = (id: string): HTMLElement | null => document.getElementById(id);

const statusEl = byId('status');
const statusErrorEl = byId('status-error');
const statusErrorTextEl = byId('status-error-text');
const statusErrorDismissEl = byId('status-error-dismiss');

if (!OptionsUtils.logMissingElements('draft manager page', {
    status: statusEl,
    'status-error': statusErrorEl,
    'status-error-text': statusErrorTextEl,
    'status-error-dismiss': statusErrorDismissEl,
}) && statusEl && statusErrorEl && statusErrorTextEl && statusErrorDismissEl) {
    const { flash } = OptionsUtils.createStatusFlash({
        statusEl,
        statusErrorEl,
        statusErrorTextEl,
        statusErrorDismissEl,
    });
    initDrafts({ extensionApi, flash });
}
