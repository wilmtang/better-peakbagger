// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — entry point for the standalone Favorite climbers page.
//
// The list controller is options/favorites.ts, unchanged. It only ever needed
// its own elements, a way to report transient status, and a `save` that
// persists the two settings it owns (the source choice and the buddy-removal
// sync). This page supplies all three; the GitHub backup for the list lives on
// the Settings page and is driven separately.

import { settings as S, type SettingsData } from '../src/settings/settings.ts';
import { initFavorites } from './favorites.ts';
import { initIgnored } from './ignored.ts';
import { initClimberFiles } from './climber-files.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';

const extensionApi = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
const byId = (id: string) => document.getElementById(id);

const statusEl = byId('status');
const statusErrorEl = byId('status-error');
const statusErrorTextEl = byId('status-error-text');
const statusErrorDismissEl = byId('status-error-dismiss');

if (!OptionsUtils.logMissingElements('favorite climbers page', {
    status: statusEl,
    'status-error': statusErrorEl,
    'status-error-text': statusErrorTextEl,
    'status-error-dismiss': statusErrorDismissEl,
}) && statusEl && statusErrorEl && statusErrorTextEl && statusErrorDismissEl) {
    const { flash, dismissStatus } = OptionsUtils.createStatusFlash({
        statusEl,
        statusErrorEl,
        statusErrorTextEl,
        statusErrorDismissEl,
    });

    // The two settings this page owns are optimistic; on a write failure restore
    // the confirmed value and report it, the way the Settings page does.
    let confirmed: SettingsData | null = null;
    let settingsRevision = 0;
    const accept = (next: SettingsData): void => {
        settingsRevision++;
        confirmed = { ...next };
        favorites.populate(next);
    };
    const save = async (patch: Partial<SettingsData>): Promise<SettingsData | null> => {
        const revision = ++settingsRevision;
        try {
            const next = await S.set(patch);
            if (revision === settingsRevision) accept(next);
            return next;
        } catch {
            if (revision !== settingsRevision) return confirmed;
            if (confirmed) favorites.populate(confirmed);
            flash('That setting couldn’t be saved. Try again.', { error: true });
            return confirmed;
        }
    };

    const favorites = initFavorites({ extensionApi, flash, dismissStatus, save });
    initIgnored(extensionApi);
    initClimberFiles(extensionApi);
    S.subscribe(accept);
    const initialRevision = settingsRevision;
    void S.get().then(loaded => {
        if (initialRevision === settingsRevision) accept(loaded);
    });
}
