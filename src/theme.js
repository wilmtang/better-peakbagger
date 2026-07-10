// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — site-wide theme applier.
// Runs in the isolated world on every Peakbagger page at document_start. It
// sets data-bpb-theme="dark"|"light" on <html>; the dark rules live in
// src/site-dark.css (injected via the manifest, inert until the attribute is
// "dark"). chrome.storage is async and can lose the race against first paint,
// so the last-known preference is mirrored into the page's localStorage and
// applied synchronously here, then reconciled once the authoritative stored
// setting resolves. See docs/dark-mode-flash.md.

(() => {
    const S = window.BPBSettings;
    if (!S) return;
    const root = document.documentElement;

    // Mirrors the theme preference ('system' | 'light' | 'dark') so the next
    // page load can apply it synchronously, before chrome.storage answers.
    const CACHE_KEY = 'bpbThemePref';

    let pref = 'system';
    const apply = () => {
        root.setAttribute('data-bpb-theme', S.resolveTheme(pref));
        try { localStorage.setItem(CACHE_KEY, pref); } catch (e) { /* storage blocked */ }
    };

    // Synchronous pre-paint pass from the mirror; resolveTheme falls back to
    // the OS preference for anything that isn't an explicit 'light'/'dark'.
    let cached = null;
    try { cached = localStorage.getItem(CACHE_KEY); } catch (e) { /* storage blocked */ }
    root.setAttribute('data-bpb-theme', S.resolveTheme(cached));

    S.get().then(s => { pref = s.theme; apply(); });
    S.subscribe(s => { pref = s.theme; apply(); });

    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (pref === 'system') apply(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }
})();
