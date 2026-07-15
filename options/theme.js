// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Applies the options-page theme before its stylesheet can paint. Extension
// storage is asynchronous, so keep a synchronous, page-local mirror and let
// options.js reconcile it with the authoritative setting after the page loads.

(() => {
    'use strict';
    const S = window.BPBSettings;
    if (!S) return;

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

    window.BPBOptionsTheme = { apply };
})();
