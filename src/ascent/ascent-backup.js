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
import { ascentBackupSource as Source } from './ascent-backup-source.js';
import { githubError as GithubError } from '../github/github-error-copy.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import { dom as Dom } from '../ui/dom.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.runtime) return;

    const errorText = error => error && error.source === 'peakbagger'
        ? PeakbaggerError.message(error)
        : GithubError.message(error, {
            fallback: 'The extension did not return an error description. Reload this ascent and try again.',
        });
    // Promise form is shared by modern MV3 Chrome and Firefox's browser API;
    // callback form is not portable to Firefox's browser namespace.
    const sendBg = async message => {
        try { return (await ext.runtime.sendMessage(message)) || null; }
        catch { return null; }
    };

    const el = Dom.element;

    let control = null;
    const setBody = (...nodes) => { if (control) control.querySelector('.bpb-gh-body').replaceChildren(...nodes.filter(Boolean)); };

    const renderIdle = info => setBody(
        el('button', {
            type: 'button',
            class: 'bpb-gh-btn',
            text: 'Back up to GitHub',
            onclick: () => runBackup(info),
        }),
    );

    const renderChecking = () => setBody(el('span', { class: 'bpb-gh-label', text: 'Checking backup…' }));

    const renderWorking = () => setBody(el('span', { class: 'bpb-gh-label', text: 'Backing up to GitHub…' }));

    const renderCurrent = () => setBody(
        el('span', { class: 'bpb-gh-label bpb-gh-ok', text: 'Backed up ✓' }),
    );

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
        const result = await Source.fetchPeakbaggerResource(url, { kind });
        if (result.kind !== 'ok') throw result.error;
        return result.text;
    };

    // A manual backup can run long after the save-time session snapshot expired.
    // Read the owner-only edit form so the replacement is still complete. The
    // display page omits many fields and cannot distinguish an empty field from
    // a field it simply does not render.
    const readPersistedSnapshot = async info => {
        if (!info.editUrl) throw PeakbaggerError.failure('invalid-request', { resource: 'edit' });
        const result = await Source.fetchPeakbaggerDocument(info.editUrl, { kind: 'edit' });
        if (result.kind !== 'ok') throw result.error;
        const parsed = Source.snapshotFromEditDocument({
            doc: result.document,
            editUrl: info.editUrl,
            baseUrl: location.href,
            ascentId: info.ascentId,
            peakId: info.peak.id,
            fallbackDate: info.date,
            fallbackPeakName: info.peak.name,
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : '',
        });
        if (!parsed.ok) {
            throw PeakbaggerError.failure(parsed.code === 'identity' ? 'identity-mismatch' : 'parse', {
                resource: 'edit',
            });
        }
        return parsed.snapshot;
    };

    const readCurrentBackup = async info => ({
        page: await readPersistedSnapshot(info),
        // A missing link authoritatively means Peakbagger stores no track. If
        // a link exists, a failed read is ambiguous and the passive check must
        // fall back to the manual action rather than assert either state.
        gpx: info.gpxUrl ? await responseText(info.gpxUrl, 'gpx') : null,
    });

    const checkBackup = async (info, current = null) => {
        renderChecking();
        let source = current;
        try { source = source || await readCurrentBackup(info); }
        catch { renderIdle(info); return; }
        const response = await sendBg({
            type: 'GITHUB_CHECK_ASCENT_BACKUP',
            page: source.page,
            pageComplete: true,
            gpx: source.gpx,
        });
        if (response && response.ok && response.current) renderCurrent();
        else renderIdle(info);
    };

    const runBackup = async (info, { auto = false } = {}) => {
        renderWorking();
        let current;
        try {
            current = await readCurrentBackup(info);
        } catch (error) {
            renderError(info, error);
            return;
        }
        const response = await sendBg({
            type: 'GITHUB_BACKUP_ASCENT',
            page: current.page,
            pageComplete: true,
            gpx: current.gpx,
            auto,
        });
        if (response && response.ok) { renderSuccess(response.result); return; }
        // Automatic mode on a revisit must not commit. Reuse the complete page
        // read to report whether GitHub already holds the same owned payload.
        if (auto && response && response.error && response.error.code === 'no-fresh-save') {
            await checkBackup(info, current);
            return;
        }
        renderError(info, response && response.error);
    };

    const mountControl = (info, { auto = false } = {}) => {
        const editLink = AscentPage.ascentEditLink(document, info.ascentId);
        const actions = editLink && editLink.parentElement;
        if (!actions) return;
        control = el('span', { class: 'bpb-gh-control', role: 'group', 'aria-label': 'GitHub backup' }, [
            el('span', { class: 'bpb-gh-body', 'aria-live': 'polite' }),
        ]);
        actions.append(document.createTextNode(' '), control);
        // Automatic mode pushes right away (declining quietly on a revisit);
        // manual mode passively compares before offering the click.
        if (auto) runBackup(info, { auto: true });
        else void checkBackup(info);
    };

    const start = async () => {
        const info = AscentPage.read({ doc: document, search: location.search });
        // Fail closed: only the owner of a real ascent sees the affordance.
        if (info.ascentId == null || !info.isOwner) return;
        const status = await sendBg({ type: 'GITHUB_BACKUP_STATUS' });
        if (!status || !status.enabled || !status.connected) return;
        mountControl(info, { auto: !!status.auto });
    };

    void start();
})();
