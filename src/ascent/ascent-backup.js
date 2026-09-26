// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — saved ascent and TR page GitHub backup affordance.
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
import { runtimeMessage as RuntimeMessage } from '../ui/runtime-message.js';
import { trustedAction as TrustedAction } from '../ui/trusted-action.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.runtime) return;

    const errorText = error => error && error.source === 'peakbagger'
        ? PeakbaggerError.message(error)
        : GithubError.message(error, {
            fallback: 'The extension did not return an error description. Reload this ascent and try again.',
        });
    const sendBg = RuntimeMessage.bind(ext);
    const SLOW_BACKUP_NOTICE_MS = 20_000;

    const el = Dom.element;

    let control = null;
    let operationGeneration = 0;
    let operationTimer = null;
    let pendingWrite = null;
    let reconcileOnResume = false;
    const setBody = (...nodes) => { if (control) control.querySelector('.bpb-gh-body').replaceChildren(...nodes.filter(Boolean)); };

    const clearOperationTimer = () => {
        if (operationTimer !== null && typeof globalThis.clearTimeout === 'function') {
            globalThis.clearTimeout(operationTimer);
        }
        operationTimer = null;
    };

    const beginOperation = ({ slow = false } = {}) => {
        clearOperationTimer();
        const generation = ++operationGeneration;
        if (slow && typeof globalThis.setTimeout === 'function') {
            operationTimer = globalThis.setTimeout(() => {
                if (generation === operationGeneration) renderSlow();
            }, SLOW_BACKUP_NOTICE_MS);
        }
        return generation;
    };

    const ownsOperation = generation => lifecycle.state === 'active' && generation === operationGeneration;

    const finishOperation = generation => {
        if (!ownsOperation(generation)) return false;
        clearOperationTimer();
        return true;
    };

    const renderIdle = info => setBody(
        el('button', {
            type: 'button',
            class: 'bpb-gh-btn',
            text: 'Back up ascent and TR',
            onclick: event => runBackup(info, { event }),
        }),
    );

    const renderChecking = () => setBody(el('span', { class: 'bpb-gh-label', text: 'Checking GitHub…' }));

    const renderWorking = () => setBody(el('span', { class: 'bpb-gh-label', text: 'Backing up to GitHub…' }));

    const renderSlow = () => setBody(el('span', {
        class: 'bpb-gh-label',
        text: 'This backup is taking longer than usual…',
    }));

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
        el('button', {
            type: 'button',
            class: 'bpb-gh-btn',
            text: 'Try again',
            onclick: event => runBackup(info, { event }),
        }),
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

    const checkBackup = async (info, current = null, {
        reconcile = false,
        failure = null,
        generation = null,
    } = {}) => {
        generation = generation ?? beginOperation();
        if (!ownsOperation(generation)) return;
        renderChecking();
        let source = current;
        try { source = source || await readCurrentBackup(info); }
        catch (error) {
            if (!finishOperation(generation)) return;
            if (failure) renderError(info, error);
            else renderIdle(info);
            return;
        }
        if (!ownsOperation(generation)) return;
        const response = await sendBg({
            type: 'GITHUB_CHECK_ASCENT_BACKUP',
            page: source.page,
            pageComplete: true,
            gpx: source.gpx,
            reconcile,
        });
        if (!finishOperation(generation)) return;
        if (response && response.ok && response.current) renderCurrent();
        else if (failure) renderError(info, response && response.error ? response.error : failure);
        else renderIdle(info);
    };

    const runBackup = async (info, { auto = false, current = null, event = null } = {}) => {
        // The host page can synthesize DOM events but cannot mint isTrusted.
        // Refuse before reading owner-only data or changing the control.
        if (lifecycle.state !== 'active' || (!auto && event?.isTrusted !== true)) return;
        const intendedGeneration = operationGeneration + 1;
        const workflow = auto ? null : await TrustedAction.begin(
            ext,
            event,
            'ascent-backup',
            intendedGeneration,
        );
        if (lifecycle.state !== 'active' || intendedGeneration !== operationGeneration + 1) {
            if (workflow) void TrustedAction.end(ext, workflow, intendedGeneration);
            return;
        }
        if (!auto && !workflow) {
            renderError(info, { code: 'activation-required' });
            return;
        }
        const generation = beginOperation({ slow: true });
        if (generation !== intendedGeneration) {
            if (workflow) void TrustedAction.end(ext, workflow, intendedGeneration);
            return;
        }
        renderWorking();
        try {
            current = current || await readCurrentBackup(info);
        } catch (error) {
            if (workflow) void TrustedAction.end(ext, workflow, generation);
            if (!finishOperation(generation)) return;
            renderError(info, error);
            return;
        }
        if (!ownsOperation(generation)) return;
        const request = sendBg({
            type: 'GITHUB_BACKUP_ASCENT',
            page: current.page,
            pageComplete: true,
            gpx: current.gpx,
            auto,
            ...(workflow ? { grantToken: workflow.grantToken, generation: String(generation) } : {}),
        });
        pendingWrite = request;
        const response = await request;
        if (workflow) void TrustedAction.end(ext, workflow, generation);
        if (!ownsOperation(generation)) return;
        if (pendingWrite === request) pendingWrite = null;
        if (response && response.ok) {
            if (finishOperation(generation)) renderSuccess(response.result);
            return;
        }
        // Automatic mode on a revisit must not commit. Reuse the complete page
        // read to report whether GitHub already holds the same owned payload.
        if (auto && response && response.error && response.error.code === 'no-fresh-save') {
            await checkBackup(info, current, { generation });
            return;
        }
        // A timed-out write may have reached GitHub even though its response
        // did not make it back. Compare the complete payload before offering a
        // retry, and ask the worker to consume the pending save snapshot only
        // when that read proves the commit landed.
        if (response && response.error && response.error.code === 'timeout') {
            await checkBackup(info, current, { reconcile: true, failure: response.error, generation });
            return;
        }
        if (!finishOperation(generation)) return;
        renderError(info, response && response.error);
    };

    const checkAutomaticBackup = async info => {
        const generation = beginOperation();
        renderChecking();
        let current;
        try { current = await readCurrentBackup(info); }
        catch {
            if (finishOperation(generation)) renderIdle(info);
            return;
        }
        if (!ownsOperation(generation)) return;
        const preflight = await sendBg({
            type: 'GITHUB_ASCENT_BACKUP_PREFLIGHT',
            page: current.page,
            pageComplete: true,
        });
        if (!ownsOperation(generation)) return;
        if (preflight && preflight.ok && preflight.fresh) {
            await runBackup(info, { auto: true, current });
            return;
        }
        await checkBackup(info, current, { generation });
    };

    const resumeBackup = async info => {
        const request = pendingWrite;
        const generation = beginOperation({ slow: !!request });
        if (request) renderWorking();
        else renderChecking();
        const response = request ? await request : null;
        if (!ownsOperation(generation)) return;
        if (pendingWrite === request) pendingWrite = null;
        // The worker owns the write. Wait for its answer, then read the current
        // saved ascent and reconcile; history traversal never submits it again.
        await checkBackup(info, null, {
            generation,
            reconcile: reconcileOnResume,
            failure: response?.error?.code === 'timeout' ? response.error : null,
        });
        if (ownsOperation(generation)) reconcileOnResume = false;
    };

    const mountControl = (info, { auto = false, resumed = false } = {}) => {
        if (!control) {
            const editLink = AscentPage.ascentEditLink(document, info.ascentId);
            const actions = editLink && editLink.parentElement;
            if (!actions) return;
            control = el('span', { class: 'bpb-gh-control', role: 'group', 'aria-label': 'Ascent and TR backup' }, [
                el('span', { class: 'bpb-gh-body', 'aria-live': 'polite' }),
            ]);
            actions.append(document.createTextNode(' '), control);
        }
        if (resumed) void resumeBackup(info);
        else if (auto) void checkAutomaticBackup(info);
        else void checkBackup(info);
    };

    const start = async ({ resumed = false } = {}) => {
        const generation = operationGeneration;
        const info = AscentPage.read({ doc: document, search: location.search });
        const status = info.ascentId != null && info.isOwner
            ? await sendBg({ type: 'GITHUB_BACKUP_STATUS' }) : null;
        if (!ownsOperation(generation)) return;
        if (!status || !status.enabled || !status.connected) {
            control?.remove();
            control = null;
            return;
        }
        mountControl(info, { auto: !!status.auto, resumed });
    };

    const invalidate = () => {
        if (pendingWrite) reconcileOnResume = true;
        operationGeneration++;
        clearOperationTimer();
    };
    const lifecycle = createPageLifecycle({
        onSuspend: invalidate,
        onResume: () => { void start({ resumed: true }); },
        onDispose: invalidate,
    });

    void start();
})();
