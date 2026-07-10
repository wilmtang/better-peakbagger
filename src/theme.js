// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — site-wide theme applier.
// Runs in the isolated world on every Peakbagger page at document_start. It
// sets data-bpb-theme="dark"|"light" on <html>; the dark rules live in
// src/site-dark.css (injected via the manifest, inert until the attribute is
// "dark"). Because chrome.storage is async there is a brief flash of the
// native page before the attribute lands — unavoidable without synchronous
// storage.

(() => {
    const S = window.BPBSettings;
    if (!S) return;
    const root = document.documentElement;

    let pref = 'system';
    const apply = () => root.setAttribute('data-bpb-theme', S.resolveTheme(pref));

    S.get().then(s => { pref = s.theme; apply(); });
    S.subscribe(s => { pref = s.theme; apply(); });

    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (pref === 'system') apply(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }
})();
