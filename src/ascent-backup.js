// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — saved ascent page GitHub backup affordance.
//
// Runs in the isolated world on ascent.aspx. It fails closed: no affordance
// unless the signed-in climber owns this ascent, the feature is enabled, and a
// repository is connected. On click it fetches Peakbagger's stored GPS track in
// the page's own session, then asks the background worker to push one commit —
// the token stays in the worker and is never seen here. The backup is strictly
// read-only toward Peakbagger and never touches a Save control.

import { ascentPage as AscentPage } from './ascent-page.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.runtime) return;

    const ERROR_TEXT = {
        auth: 'The GitHub authorization is no longer valid. Reconnect in the extension options.',
        'no-access': 'The backup repository is no longer reachable. Check it in the extension options.',
        'not-connected': 'Connect a GitHub repository in the extension options first.',
        'no-repo': 'Choose a backup repository in the extension options first.',
        archived: 'The backup repository is archived and read-only.',
        'repo-conflict': 'The repository contains conflicting backup folders. Choose another in the extension options.',
        'branch-protected': 'The repository’s branch protection rejected the commit.',
        'branch-missing': 'The backup repository has no branch to commit to yet.',
        'rate-limit': 'GitHub is rate-limiting requests. Try again in a few minutes.',
        conflict: 'Another change landed first. Try backing up again.',
        network: 'Could not reach GitHub. Check your connection and try again.',
        'no-data': 'Could not read this ascent’s details to back up.',
        disabled: 'GitHub backup is turned off.',
        unknown: 'The backup did not complete. Try again.',
    };
    const errorText = code => ERROR_TEXT[code] || ERROR_TEXT.unknown;

    const sendBg = message => new Promise(resolve => {
        try {
            ext.runtime.sendMessage(message, response => { void ext.runtime.lastError; resolve(response || null); });
        } catch { resolve(null); }
    });

    const el = (tag, props = {}, children = []) => {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
            else if (value != null) node.setAttribute(key, value);
        }
        for (const child of [].concat(children)) if (child) node.appendChild(child);
        return node;
    };

    let bar = null;
    const setBody = (...nodes) => { if (bar) bar.querySelector('.bpb-gh-body').replaceChildren(...nodes.filter(Boolean)); };

    const renderIdle = info => setBody(
        el('span', { class: 'bpb-gh-label', text: 'Back up this ascent to GitHub' }),
        el('button', { type: 'button', class: 'bpb-gh-btn bpb-gh-primary', text: 'Back up', onclick: () => runBackup(info) }),
    );

    const renderWorking = () => setBody(el('span', { class: 'bpb-gh-label', text: 'Backing up to GitHub…' }));

    const renderSuccess = result => setBody(
        el('span', { class: 'bpb-gh-label bpb-gh-ok', text: result && result.isUpdate ? 'Backup updated ✓' : 'Backed up ✓' }),
        result && result.commitUrl
            ? el('a', { class: 'bpb-gh-link', href: result.commitUrl, target: '_blank', rel: 'noopener noreferrer', text: 'View commit' })
            : null,
    );

    const renderError = (info, error) => setBody(
        el('span', { class: 'bpb-gh-label bpb-gh-err', text: errorText(error && error.code) }),
        el('button', { type: 'button', class: 'bpb-gh-btn', text: 'Try again', onclick: () => runBackup(info) }),
    );

    const runBackup = async (info, { auto = false } = {}) => {
        renderWorking();
        let gpx = null;
        if (info.gpxUrl) {
            // Fetched in the page's own session (same-origin, credentialed), the
            // same place the analyzer reads the stored track.
            try { const res = await fetch(info.gpxUrl); if (res.ok) gpx = await res.text(); } catch { /* no track */ }
        }
        const page = {
            ascent: { id: info.ascentId, date: info.date || undefined },
            peak: { id: info.peak.id, name: info.peak.name },
            report: { markdown: info.reportMarkdown || '' },
        };
        const response = await sendBg({ type: 'GITHUB_BACKUP_ASCENT', page, gpx, auto });
        if (response && response.ok) { renderSuccess(response.result); return; }
        // Automatic mode on an already-backed-up revisit: fall back to the manual
        // affordance rather than showing an error the user did not trigger.
        if (auto && response && response.error && response.error.code === 'no-fresh-save') { renderIdle(info); return; }
        renderError(info, response && response.error);
    };

    const mountBar = (info, { auto = false } = {}) => {
        bar = el('div', { class: 'bpb-gh-bar', role: 'region', 'aria-label': 'GitHub backup' }, [
            el('div', { class: 'bpb-gh-body' }),
            el('button', { type: 'button', class: 'bpb-gh-dismiss', 'aria-label': 'Dismiss', text: '×', onclick: () => bar.remove() }),
        ]);
        document.body.insertBefore(bar, document.body.firstChild);
        // Automatic mode pushes right away (declining quietly on a revisit);
        // manual mode waits for the click.
        if (auto) runBackup(info, { auto: true });
        else renderIdle(info);
    };

    const start = async () => {
        const info = AscentPage.read({ doc: document, search: location.search });
        // Fail closed: only the owner of a real ascent sees the affordance.
        if (info.ascentId == null || !info.isOwner) return;
        const status = await sendBg({ type: 'GITHUB_BACKUP_STATUS' });
        if (!status || !status.enabled || !status.connected) return;
        mountBar(info, { auto: !!status.auto });
    };

    void start();
})();
