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
import { ascentSnapshot as Snapshot } from './ascent-snapshot.js';
import { reportMarkup as Markup } from './report-markup.js';
import { githubError as GithubError } from './github-error.js';
import { classifyResponse } from './profile-backup-core.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.runtime) return;

    const errorText = error => GithubError.message(error, {
        fallback: 'The extension did not return an error description. Reload this ascent and try again.',
    });
    const failure = code => Object.assign(new Error(code), { code });

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
        el('span', { class: 'bpb-gh-label bpb-gh-err', text: errorText(error) }),
        el('button', { type: 'button', class: 'bpb-gh-btn', text: 'Try again', onclick: () => runBackup(info) }),
    );

    const responseText = async (url, kind) => {
        let response;
        try {
            response = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
        } catch {
            throw failure(kind === 'gpx' ? 'peakbagger-track' : 'peakbagger-read');
        }
        let text = '';
        try { text = await response.text(); }
        catch { throw failure(kind === 'gpx' ? 'peakbagger-track' : 'peakbagger-read'); }
        if (classifyResponse(response.status, response.headers, text, { kind }) !== 'ok') {
            throw failure(kind === 'gpx' ? 'peakbagger-track' : 'peakbagger-read');
        }
        return text;
    };

    // A manual backup can run long after the save-time session snapshot expired.
    // Read the owner-only edit form so the replacement is still complete. The
    // display page omits many fields and cannot distinguish an empty field from
    // a field it simply does not render.
    const readPersistedSnapshot = async info => {
        if (!info.editUrl) throw failure('peakbagger-read');
        const html = await responseText(info.editUrl, 'edit');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const form = doc.getElementById('Form1') || doc.querySelector('form[name="Form1"]');
        if (!form || !form.elements.JournalText || !form.elements.DateText || !form.elements.PeakListBox) {
            throw failure('peakbagger-read');
        }
        const params = new URL(info.editUrl, location.href).searchParams;
        params.set('aid', String(info.ascentId));
        if (info.peak.id != null) params.set('pid', String(info.peak.id));
        const built = Snapshot.build({
            form,
            params,
            report: { markdown: Markup.bracketToMarkdown(form.elements.JournalText.value || '') },
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : '',
        });
        if (built.snapshot.ascent.id !== info.ascentId
            || (info.peak.id != null && built.snapshot.peak.id !== info.peak.id)) {
            throw failure('peakbagger-read');
        }
        if (!built.snapshot.ascent.date && info.date) built.snapshot.ascent.date = info.date;
        if (!built.snapshot.peak.name && info.peak.name) built.snapshot.peak.name = info.peak.name;
        return built.snapshot;
    };

    const runBackup = async (info, { auto = false } = {}) => {
        renderWorking();
        let page;
        let gpx;
        try {
            page = await readPersistedSnapshot(info);
            // A missing link authoritatively means Peakbagger stores no track. If
            // a link exists, however, a failed read is ambiguous and must abort;
            // treating failure as absence would delete an older track.gpx.
            gpx = info.gpxUrl ? await responseText(info.gpxUrl, 'gpx') : null;
        } catch (error) {
            renderError(info, error);
            return;
        }
        const response = await sendBg({ type: 'GITHUB_BACKUP_ASCENT', page, pageComplete: true, gpx, auto });
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
