// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Save-success convenience link (isolated world, ascentedit.aspx).
//
// After a successful Save the ascent editor reloads the SAME URL into a
// success view — "Ascent Added/Saved Successfully!" plus a "Go Back to
// Referring Page" link and a "photo" link that is the only place the freshly
// minted ascent id (aid) appears. Peakbagger offers no direct link to the new
// ascent from that page, so this module inserts one: "View the New Ascent".
//
// This is a pure convenience — there is no setting gate. It shares the
// ascent-editor bundle with the draft-fill pipeline, so every code path is
// wrapped so a failure here can never disturb draft filling.

(() => {
    'use strict';

    const LINK_ID = 'bpb-view-new-ascent';
    // Tolerant of the observed live text ("Ascent Added/Saved Successfully!")
    // and the plainer "Ascent Saved Successfully" / "Ascent Added Successfully".
    const SUCCESS_RE = /Ascent (?:Added|Saved)\/?(?:Saved )?Successfully/i;

    const successConfirmed = () => {
        const subtitle = document.getElementById('SubTitle');
        return !!subtitle && SUCCESS_RE.test(subtitle.textContent || '');
    };

    // The new ascent id lives only in the photo link's query string.
    const newAscentId = () => {
        const link = document.querySelector('a[href*="photo.aspx?aid=" i]');
        if (!link) return null;
        try {
            const aid = new URL(link.getAttribute('href'), location.href).searchParams.get('aid');
            return aid && /^\d+$/.test(aid) ? aid : null;
        } catch (_error) {
            return null;
        }
    };

    const referringPageLink = () => [...document.querySelectorAll('a')]
        .find(anchor => /go back to referring page/i.test(anchor.textContent || '')) || null;

    const tryInsert = () => {
        if (document.getElementById(LINK_ID)) return;
        if (!successConfirmed()) return;
        const aid = newAscentId();
        if (!aid) return;
        const anchor = referringPageLink();
        if (!anchor) return;

        const link = document.createElement('a');
        link.id = LINK_ID;
        link.href = `ascent.aspx?aid=${aid}`;
        link.textContent = 'View the New Ascent';
        // Reads: "Go Back to Referring Page, View the New Ascent, or, add a
        // new ascent on this page."
        anchor.after(document.createTextNode(', '), link);
    };

    const safeTryInsert = () => {
        try {
            tryInsert();
        } catch (_error) {
            // Never let a success-link failure escape into the shared bundle.
        }
    };

    safeTryInsert();

    // The success view arrives via an ASP.NET UpdatePanel async postback, so
    // watch for it. Observe the panel's PARENT (or the body), because ASP.NET
    // may replace #UpdatePanelAE wholesale — observing the element itself would
    // miss that. Debounce the mutation burst to a single microtask.
    const target = document.getElementById('UpdatePanelAE')?.parentNode || document.body;
    if (target && typeof MutationObserver === 'function') {
        let scheduled = false;
        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                safeTryInsert();
            });
        });
        try {
            observer.observe(target, { childList: true, subtree: true });
        } catch (_error) {
            // A missing observation target simply leaves the one-shot insert.
        }
    }
})();
