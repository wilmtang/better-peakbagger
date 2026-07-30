// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — entry point for the standalone Favorite climbers page.
//
// The list controller is options/favorites.js, unchanged. It only ever needed
// its own elements, a way to report transient status, and a `save` that
// persists the two settings it owns (the source choice and the buddy-removal
// sync). This page supplies all three; the GitHub backup for the list lives on
// the Settings page and is driven separately.

import { settings as S } from '../src/settings/settings.js';
import { initFavorites } from './favorites.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

const extensionApi = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
const byId = id => document.getElementById(id);

const statusEl = byId('status');
const statusErrorEl = byId('status-error');
const statusErrorTextEl = byId('status-error-text');
const statusErrorDismissEl = byId('status-error-dismiss');

if (!OptionsUtils.logMissingElements('favorite climbers page', {
    status: statusEl,
    'status-error': statusErrorEl,
    'status-error-text': statusErrorTextEl,
    'status-error-dismiss': statusErrorDismissEl,
})) {
    const { flash } = OptionsUtils.createStatusFlash({
        statusEl,
        statusErrorEl,
        statusErrorTextEl,
        statusErrorDismissEl,
    });

    // The two settings this page owns are optimistic; on a write failure restore
    // the confirmed value and report it, the way the Settings page does.
    let confirmed = null;
    const save = patch => S.set(patch).then(
        next => { confirmed = { ...next }; return next; },
        error => {
            if (confirmed) favorites.populate(confirmed);
            flash('That setting couldn’t be saved. Try again.', { error: true });
            throw error;
        },
    );

    const favorites = initFavorites({ extensionApi, flash, save });
    void S.get().then(settings => {
        confirmed = { ...settings };
        favorites.populate(settings);
    });
}
