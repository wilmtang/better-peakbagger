// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — site-wide theme applier.
// Runs in the isolated world on every Peakbagger page at document_start. Two
// things must be live before the first paint for dark mode to show without a
// flash of the native light page: the dark *stylesheet* and the
// data-bpb-theme="dark" *attribute* it is gated on. This script puts BOTH into
// the DOM in a single synchronous document_start tick — the way Dark Reader
// does it:
//
//   * The sheet is injected here as a <style> in document.documentElement
//     (which exists this early; <head> does not yet), NOT via a manifest `css`
//     entry. Declarative `css` is a separate renderer channel that does not
//     reliably land before first paint, so it could lag the attribute and
//     flash. Injecting in JS collapses both into one tick the parser can't get
//     ahead of.
//   * The attribute is read from a page-localStorage mirror of the preference,
//     which isolated-world content scripts can read synchronously — unlike
//     chrome.storage, whose async round-trip loses the race. The authoritative
//     stored setting reconciles the attribute (and mirror) once it resolves.
//
// See docs/dark-mode-flash.md.

(() => {
    const S = window.BPBSettings;
    if (!S) return;
    const root = document.documentElement;

    // Mirrors the theme preference ('system' | 'light' | 'dark') so the next
    // page load can apply it synchronously, before chrome.storage answers.
    const CACHE_KEY = 'bpbThemePref';

    // Inject the dark stylesheet once, as early as possible, straight into
    // <html>. It stays inert until data-bpb-theme="dark" is set (below, and on
    // reconcile), so the same sheet also covers light mode and later live
    // toggles without re-injection.
    const STYLE_ID = 'bpb-site-dark';
    if (window.BPBDarkCSS && !document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = window.BPBDarkCSS;
        root.appendChild(style);
    }

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
