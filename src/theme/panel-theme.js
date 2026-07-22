// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Applies the extension-panel theme before its stylesheet can paint. Extension
// storage is asynchronous, so a synchronous page-local mirror supplies the
// first frame and the authoritative synced setting reconciles it afterward.

import { settings as S } from '../settings/settings.js';

const CACHE_KEY = 'bpbThemePref';
const root = document.documentElement;

const apply = (preference, { cache = true } = {}) => {
    root.setAttribute('data-bpb-theme', S.resolveTheme(preference));
    if (!cache) return;
    try { localStorage.setItem(CACHE_KEY, preference); } catch (e) { /* storage blocked */ }
};

let cached = null;
try { cached = localStorage.getItem(CACHE_KEY); } catch (e) { /* storage blocked */ }
apply(cached, { cache: false });

// Popup pages have no later settings controller, so the shared head bootstrap
// owns reconciliation. The options controller also calls apply while painting
// its controls; the operation is intentionally idempotent.
void S.get().then(settings => apply(settings.theme));

export const panelTheme = { apply };
