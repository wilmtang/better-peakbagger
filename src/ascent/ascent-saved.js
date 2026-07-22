// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Save-success routing (isolated world, ascentedit.aspx).
//
// After a successful Add or Edit, Peakbagger leaves the user on the SAME URL in
// a success view rather than navigating to ascent.aspx. A newly added ascent's
// id appears in its photo link; an edited ascent keeps the id in location.search.
// This module inserts a direct "View the Saved Ascent" link for both cases. When
// automatic GitHub backup is enabled and connected, it follows that link after
// success so the ordinary ascent.aspx backup runner performs the one push.
//
// The link itself is an ungated convenience; only automatic navigation is
// gated by connected backup settings. It shares the ascent-editor bundle with
// the draft-fill pipeline, so every code path is wrapped so a failure here can
// never disturb draft filling.

(() => {
    'use strict';

    const LINK_ID = 'bpb-view-new-ascent';
    const ext = globalThis.browser || globalThis.chrome;
    // Tolerant of the observed live text ("Ascent Added/Saved Successfully!")
    // and the plainer "Ascent Saved Successfully" / "Ascent Added Successfully".
    const SUCCESS_RE = /Ascent (?:Added\/Saved|Added|Saved)\s+Successfully/i;

    const successConfirmed = () => {
        const subtitle = document.getElementById('SubTitle');
        return !!subtitle && SUCCESS_RE.test(subtitle.textContent || '');
    };

    const validAid = value => value && /^\d+$/.test(value) ? value : null;

    // Edits retain aid in the page URL. Adds have no URL aid, so the freshly
    // created id must be read from Peakbagger's success-view photo link.
    const savedAscentId = () => {
        try {
            const aid = validAid(new URL(location.href).searchParams.get('aid'));
            if (aid) return aid;
        } catch (_error) { /* fall through to the add-ascent photo link */ }
        const link = document.querySelector('a[href*="photo.aspx?aid=" i]');
        if (!link) return null;
        try {
            const aid = new URL(link.getAttribute('href'), location.href).searchParams.get('aid');
            return validAid(aid);
        } catch (_error) {
            return null;
        }
    };

    const sendBg = async message => {
        if (!ext || !ext.runtime || typeof ext.runtime.sendMessage !== 'function') return null;
        try { return (await ext.runtime.sendMessage(message)) || null; }
        catch (_error) { return null; }
    };

    const referringPageLink = () => [...document.querySelectorAll('a')]
        .find(anchor => /go back to referring page/i.test(anchor.textContent || '')) || null;

    let autoRouteStarted = false;
    const routeAutomaticBackup = (link, aid) => {
        if (autoRouteStarted) return;
        autoRouteStarted = true;
        void sendBg({ type: 'GITHUB_BACKUP_STATUS' }).then(status => {
            if (!status || !status.enabled || !status.connected || !status.auto) return;
            // The async response may arrive after another postback changed the
            // panel. Only navigate while this is still the confirmed save result.
            if (!link.isConnected || !successConfirmed() || savedAscentId() !== aid) return;
            link.click();
        });
    };

    const tryInsert = () => {
        if (!successConfirmed()) return;
        const aid = savedAscentId();
        if (!aid) return;
        const existing = document.getElementById(LINK_ID);
        if (existing) {
            routeAutomaticBackup(existing, aid);
            return;
        }
        const anchor = referringPageLink();
        if (!anchor) return;

        const link = document.createElement('a');
        link.id = LINK_ID;
        link.href = `ascent.aspx?aid=${aid}`;
        link.textContent = 'View the Saved Ascent';
        // Reads: "Go Back to Referring Page, View the Saved Ascent, or, add a
        // new ascent on this page."
        anchor.after(document.createTextNode(', '), link);
        routeAutomaticBackup(link, aid);
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
