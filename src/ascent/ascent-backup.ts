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

import { ascentPage as AscentPage } from './ascent-page.ts';
import { ascentBackupSource as Source, type SnapshotFromEditDocumentResult } from './ascent-backup-source.ts';
import { githubError as GithubError } from '../github/github-error-copy.ts';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.ts';
import { dom as Dom } from '../ui/dom.ts';
import { runtimeMessage as RuntimeMessage } from '../ui/runtime-message.ts';
import { trustedAction as TrustedAction, type TrustedActionEvent } from '../ui/trusted-action.ts';
import { createPageLifecycle } from '../ui/page-lifecycle.ts';

interface ExtensionApi {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
        getManifest?: () => { version: string };
    };
}

interface ErrorWithSource {
    source?: unknown;
    code?: unknown;
    message?: unknown;
    [key: string]: unknown;
}

interface BackupResult {
    isUpdate?: boolean;
    commitUrl?: string;
}

interface BackupStatusResponse {
    enabled?: boolean;
    connected?: boolean;
    auto?: boolean;
}

interface BackupCheckResponse {
    ok?: boolean;
    current?: boolean;
    error?: ErrorWithSource;
}

interface BackupWriteResponse {
    ok?: boolean;
    result?: BackupResult;
    error?: ErrorWithSource;
}

interface BackupPreflightResponse {
    ok?: boolean;
    fresh?: boolean;
}

type AscentInfo = ReturnType<typeof AscentPage.read>;
type PersistedSnapshot = Extract<SnapshotFromEditDocumentResult, { ok: true }>['snapshot'];

interface CurrentBackup {
    page: PersistedSnapshot;
    gpx: string | null;
}

interface CheckBackupOptions {
    reconcile?: boolean;
    failure?: unknown;
    generation?: number | null;
}

interface RunBackupOptions {
    auto?: boolean;
    current?: CurrentBackup | null;
    event?: TrustedActionEvent | null;
}

(() => {
    'use strict';

    const ext = (globalThis as unknown as { browser?: ExtensionApi; chrome?: ExtensionApi }).browser
        || (globalThis as unknown as { chrome?: ExtensionApi }).chrome;
    if (!ext || !ext.runtime) return;

    const errorText = (error: unknown): string =>
        error && typeof error === 'object' && (error as ErrorWithSource).source === 'peakbagger'
            ? PeakbaggerError.message(error)
            : GithubError.message(error, {
                fallback: 'The extension did not return an error description. Reload this ascent and try again.',
            });
    const sendBg = RuntimeMessage.bind(ext);
    const SLOW_BACKUP_NOTICE_MS = 20_000;

    const el = Dom.element;

    let control: HTMLSpanElement | null = null;
    let backupInfo: AscentInfo | null = null;
    let operationGeneration = 0;
    let operationTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let pendingWrite: Promise<BackupWriteResponse | null> | null = null;
    let reconcileOnResume = false;
    let restoreFocusOnEnable = false;
    const setBody = (...nodes: (HTMLElement | null | undefined)[]) => {
        if (!control) return;
        const action = control.querySelector<HTMLButtonElement>('.bpb-gh-btn')!;
        const nextAction = nodes.find((node): node is HTMLButtonElement => node?.tagName === 'BUTTON');
        const complete = nodes[0]?.classList.contains('bpb-gh-ok');
        const checking = !nextAction && nodes[0]?.textContent === 'Checking GitHub…';
        if (!nextAction && !action.disabled && document.activeElement === action) {
            restoreFocusOnEnable = true;
        }
        action.disabled = !nextAction;
        action.hidden = !!complete || checking;
        if (complete) {
            restoreFocusOnEnable = false;
        } else if (nextAction && !action.hidden && restoreFocusOnEnable) {
            restoreFocusOnEnable = false;
            const active = document.activeElement;
            if (!active || active === document.body || active === document.documentElement || active === action) {
                action.focus({ preventScroll: true });
            }
        }
        action.onclick = nextAction ? event => {
            if (backupInfo) void runBackup(backupInfo, { event });
        } : null;
        action.querySelector('span')!.textContent = complete ? '' : nextAction?.textContent
            || ((nodes[0]?.textContent ?? '').includes('Checking') ? 'Checking GitHub…'
                : 'Backing up to GitHub…');
        const status = control.querySelector<HTMLSpanElement>('.bpb-gh-status')!;
        status.hidden = !complete && !checking;
        status.classList.toggle('bpb-gh-ok', !!complete);
        status.textContent = complete || checking ? nodes[0]!.textContent : '';
        const feedback = control.querySelector<HTMLSpanElement>('.bpb-gh-feedback')!;
        feedback.replaceChildren(...nodes.filter((node): node is HTMLElement => !!node && node !== nextAction
            && (!node.classList.contains('bpb-gh-label') || node.classList.contains('bpb-gh-err')
                || (node.textContent ?? '').includes('longer than usual'))));
        feedback.hidden = !feedback.childNodes.length;
    };

    const clearOperationTimer = () => {
        if (operationTimer !== null && typeof globalThis.clearTimeout === 'function') {
            globalThis.clearTimeout(operationTimer);
        }
        operationTimer = null;
    };

    const beginOperation = ({ slow = false }: { slow?: boolean } = {}): number => {
        clearOperationTimer();
        const generation = ++operationGeneration;
        if (slow && typeof globalThis.setTimeout === 'function') {
            operationTimer = globalThis.setTimeout(() => {
                if (generation === operationGeneration) renderSlow();
            }, SLOW_BACKUP_NOTICE_MS);
        }
        return generation;
    };

    const ownsOperation = (generation: number): boolean =>
        lifecycle.state === 'active' && generation === operationGeneration;

    const finishOperation = (generation: number): boolean => {
        if (!ownsOperation(generation)) return false;
        clearOperationTimer();
        return true;
    };

    const renderIdle = (info: AscentInfo) => setBody(
        el('button', {
            type: 'button',
            class: 'bpb-gh-btn',
            text: 'Back up ascent and TR',
            onclick: (event: Event) => { void runBackup(info, { event }); },
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

    const renderSuccess = (result: BackupResult | null | undefined) => setBody(
        el('span', { class: 'bpb-gh-label bpb-gh-ok', text: result && result.isUpdate ? 'Backup updated ✓' : 'Backed up ✓' }),
        result && result.commitUrl
            ? el('a', { class: 'bpb-gh-link', href: result.commitUrl, target: '_blank', rel: 'noopener noreferrer', text: 'View commit' })
            : null,
    );

    const renderError = (info: AscentInfo, error: unknown) => setBody(
        el('span', { class: 'bpb-gh-label bpb-gh-err', text: errorText(error) }),
        el('button', {
            type: 'button',
            class: 'bpb-gh-btn',
            text: 'Try again',
            onclick: (event: Event) => { void runBackup(info, { event }); },
        }),
    );

    const responseText = async (url: string, kind: 'gpx'): Promise<string> => {
        const result = await Source.fetchPeakbaggerResource(url, { kind });
        if (result.kind !== 'ok') throw result.error;
        return result.text;
    };

    // A manual backup can run long after the save-time session snapshot expired.
    // Read the owner-only edit form so the replacement is still complete. The
    // display page omits many fields and cannot distinguish an empty field from
    // a field it simply does not render.
    const readPersistedSnapshot = async (info: AscentInfo): Promise<PersistedSnapshot> => {
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

    const readCurrentBackup = async (info: AscentInfo): Promise<CurrentBackup> => ({
        page: await readPersistedSnapshot(info),
        // A missing link authoritatively means Peakbagger stores no track. If
        // a link exists, a failed read is ambiguous and the passive check must
        // fall back to the manual action rather than assert either state.
        gpx: info.gpxUrl ? await responseText(info.gpxUrl, 'gpx') : null,
    });

    const checkBackup = async (info: AscentInfo, current: CurrentBackup | null = null, {
        reconcile = false,
        failure = null,
        generation = null,
    }: CheckBackupOptions = {}): Promise<void> => {
        const opGeneration = generation ?? beginOperation();
        if (!ownsOperation(opGeneration)) return;
        renderChecking();
        let source = current;
        try { source = source || await readCurrentBackup(info); }
        catch (error) {
            if (!finishOperation(opGeneration)) return;
            if (failure) renderError(info, error);
            else renderIdle(info);
            return;
        }
        if (!ownsOperation(opGeneration)) return;
        const response = await sendBg<BackupCheckResponse>({
            type: 'GITHUB_CHECK_ASCENT_BACKUP',
            page: source.page,
            pageComplete: true,
            gpx: source.gpx,
            reconcile,
        });
        if (!finishOperation(opGeneration)) return;
        if (response && response.ok && response.current) renderCurrent();
        else if (failure) renderError(info, response && response.error ? response.error : failure);
        else renderIdle(info);
    };

    const runBackup = async (info: AscentInfo, { auto = false, current = null, event = null }: RunBackupOptions = {}): Promise<void> => {
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
        let resolvedCurrent = current;
        try {
            resolvedCurrent = resolvedCurrent || await readCurrentBackup(info);
        } catch (error) {
            if (workflow) void TrustedAction.end(ext, workflow, generation);
            if (!finishOperation(generation)) return;
            renderError(info, error);
            return;
        }
        if (!ownsOperation(generation)) return;
        const request = sendBg<BackupWriteResponse>({
            type: 'GITHUB_BACKUP_ASCENT',
            page: resolvedCurrent.page,
            pageComplete: true,
            gpx: resolvedCurrent.gpx,
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
            await checkBackup(info, resolvedCurrent, { generation });
            return;
        }
        // A timed-out write may have reached GitHub even though its response
        // did not make it back. Compare the complete payload before offering a
        // retry, and ask the worker to consume the pending save snapshot only
        // when that read proves the commit landed.
        if (response && response.error && response.error.code === 'timeout') {
            await checkBackup(info, resolvedCurrent, { reconcile: true, failure: response.error, generation });
            return;
        }
        if (!finishOperation(generation)) return;
        renderError(info, response && response.error);
    };

    const checkAutomaticBackup = async (info: AscentInfo): Promise<void> => {
        const generation = beginOperation();
        renderChecking();
        let current: CurrentBackup;
        try { current = await readCurrentBackup(info); }
        catch {
            if (finishOperation(generation)) renderIdle(info);
            return;
        }
        if (!ownsOperation(generation)) return;
        const preflight = await sendBg<BackupPreflightResponse>({
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

    const resumeBackup = async (info: AscentInfo): Promise<void> => {
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

    const mountControl = (info: AscentInfo, { auto = false, resumed = false }: { auto?: boolean; resumed?: boolean } = {}) => {
        backupInfo = info;
        if (!control) {
            const editLink = info.ascentId != null ? AscentPage.ascentEditLink(document, info.ascentId) : null;
            const actions = editLink && editLink.parentElement;
            if (!actions) return;
            control = el('span', { class: 'bpb-gh-control', role: 'group', 'aria-label': 'Ascent and TR backup' }, [
                el('span', { class: 'bpb-gh-body' }, [
                    el('span', { class: 'bpb-gh-action', 'data-label': 'Back up ascent and TR' }, [
                        el('button', { type: 'button', class: 'bpb-gh-btn', disabled: true, 'aria-live': 'polite' },
                            [el('span', { text: 'Checking…' })]),
                        el('span', { class: 'bpb-gh-status bpb-gh-label bpb-gh-ok', role: 'status', hidden: true }),
                    ]),
                    el('span', { class: 'bpb-gh-feedback', 'aria-live': 'polite', hidden: true }),
                ]),
            ]);
            actions.append(document.createTextNode(' '), control);
        }
        if (resumed) void resumeBackup(info);
        else if (auto) void checkAutomaticBackup(info);
        else void checkBackup(info);
    };

    const start = async ({ resumed = false }: { resumed?: boolean } = {}): Promise<void> => {
        const generation = operationGeneration;
        const info = AscentPage.read({ doc: document, search: location.search });
        const status = info.ascentId != null && info.isOwner
            ? await sendBg<BackupStatusResponse>({ type: 'GITHUB_BACKUP_STATUS' }) : null;
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
