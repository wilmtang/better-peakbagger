// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Full-profile GitHub backup on the signed-in climber's ClimbListC page. The
// tab owns the multi-minute producer/consumer pipeline; the MV3 worker wakes
// for repository preflight and serialized atomic batch commits.

import {
    profileBackupCore as Core,
    type AscentListEntry,
    type ExistingFolderInput,
    type LoadItemOptions,
    type LoadItemResult,
    type ParsedAscentList,
    type ProfileBackupFailure,
    type ProfileBackupRunner,
    type ProfileBackupRunnerState,
} from './profile-backup-core.ts';
import { ascentBackupSource as Source } from '../ascent/ascent-backup-source.ts';
import { githubError as GithubError } from '../github/github-error-copy.ts';
import { peakbaggerCloudflare as Cloudflare } from '../peakbagger/peakbagger-cloudflare.ts';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.ts';
import { dom as Dom } from '../ui/dom.ts';
import { createStableText, type StableText } from '../ui/stable-text.ts';
import {
    runtimeMessage as RuntimeMessage,
    type RuntimeMessageError,
    type RuntimeMessageResponse,
} from '../ui/runtime-message.ts';
import { trustedAction as TrustedAction, type TrustedActionWorkflow } from '../ui/trusted-action.ts';

interface ProfileBackupExtension {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
        getManifest?: () => { version?: string };
    };
}

interface ActiveWorkflow extends TrustedActionWorkflow {
    generation: string;
}

interface PreparationOwner {
    workflow: ActiveWorkflow;
    generation: number;
    controller: AbortController;
}

interface ProfileRepoStatus {
    enabled?: boolean;
    connected?: boolean;
    repo?: {
        fullName?: string;
    };
}

interface PendingDeletionResponse extends RuntimeMessageResponse {
    aids?: number[];
}

interface DeletionError extends RuntimeMessageError {
    source?: string;
}

interface DeletionResultData {
    noOp?: boolean;
    removedFileCount?: number;
    commitUrl?: string;
}

interface DeletionConfirmResponse extends RuntimeMessageResponse {
    confirmed?: boolean;
    error?: DeletionError;
    result?: DeletionResultData;
}

interface ProfileBackupStatusResponse extends RuntimeMessageResponse {
    folders?: ExistingFolderInput[];
}

interface BackupStatusResponse extends RuntimeMessageResponse {
    enabled?: boolean;
    connected?: boolean;
    repo?: {
        fullName?: string;
    };
}

type SourceFailureKind = 'challenged' | 'transient' | 'wrong-content';

interface SourceFailure {
    kind: SourceFailureKind;
    url?: string | null;
    error?: unknown;
    reason?: string;
}

interface SourceTextOk {
    kind: 'ok';
    text: string;
}

interface SourceDocumentOk {
    kind: 'ok';
    document: Document;
}

type SourceTextResult = SourceTextOk | SourceFailure;
type SourceDocumentResult = SourceDocumentOk | SourceFailure;

interface AscentBackupData {
    snapshot: unknown;
    gpx: string | null;
}

interface SnapshotFromEditDocumentOptions {
    doc: Document;
    editUrl: string;
    baseUrl: string;
    ascentId: number;
    peakId: number | null;
    climberId: number | null;
    fallbackDate: string;
    fallbackPeakName: string;
    extensionVersion: string;
}

interface SnapshotFromEditDocumentResult {
    ok: boolean;
    snapshot?: unknown;
    code?: string;
}

interface BackupSourceApi {
    fetchPeakbaggerResource(url: string | null, options: { kind: 'edit' | 'gpx'; signal?: AbortSignal }): Promise<SourceTextResult>;
    fetchPeakbaggerDocument(url: string | null, options: { kind: 'edit' | 'list'; signal?: AbortSignal }): Promise<SourceDocumentResult>;
    snapshotFromEditDocument(options: SnapshotFromEditDocumentOptions): SnapshotFromEditDocumentResult;
    storedGpxUrl(options: { origin: string; ascentId: number }): string | null;
}

const backupSource = Source as unknown as BackupSourceApi;

(() => {
    'use strict';

    const extensionGlobals = globalThis as {
        browser?: ProfileBackupExtension;
        chrome?: ProfileBackupExtension;
    };
    const ext = extensionGlobals.browser || extensionGlobals.chrome;
    if (!ext || !ext.runtime || !/\/climber\/climblistc\.aspx$/i.test(location.pathname)) return;

    const sendBg = RuntimeMessage.bind(ext);
    const sendBgResult = RuntimeMessage.bindResult(ext);
    const node = Dom.element;

    let panel: HTMLElement | null = null;
    let runner: ProfileBackupRunner<AscentListEntry> | null = null;
    let ownerId: number | null = null;
    let workflow: ActiveWorkflow | null = null;
    let workflowGeneration = 0;
    let preparation: PreparationOwner | null = null;
    let idleStatus: ProfileRepoStatus | null = null;
    let progressNoteText: StableText | null = null;
    let pendingText: StableText | null = null;

    const body = (...children: Array<Node | null | undefined | false>): void => {
        panel?.querySelector('.bpb-profile-body')
            ?.replaceChildren(...children.filter((child): child is Node => Boolean(child)));
    };
    const button = (text: string, onclick: (event: MouseEvent) => void, primary = false): HTMLButtonElement => node('button', {
        type: 'button', class: `bpb-profile-btn${primary ? ' bpb-profile-primary' : ''}`, onclick,
    }, [node('span', { text })]);
    const disabledButton = (text: string): HTMLButtonElement => node('button', {
        type: 'button', class: 'bpb-profile-btn', disabled: true,
    }, [node('span', { text })]);
    const removePanel = (): void => {
        if (panel) panel.remove();
        panel = null;
    };
    const ensurePanel = (): boolean => {
        if (panel?.isConnected) return true;
        panel = node('section', {
            id: 'bpb-profile-backup',
            class: 'bpb-profile-panel',
            'aria-label': 'Ascent and TR backup',
        }, [
            node('div', { class: 'bpb-profile-body', 'aria-live': 'polite' }),
        ]);
        const table = Array.from(document.querySelectorAll('table.gray')).find(candidate =>
            candidate.querySelector('a[href*="ascent.aspx?aid="]')
            || /Ascent\s*Date\b/i.test(candidate.textContent || ''));
        if (!table || !table.parentNode) {
            panel = null;
            return false;
        }
        const filterBar = document.getElementById('pbaf-bar');
        const anchor = filterBar && filterBar.parentNode === table.parentNode ? filterBar : table;
        table.parentNode.insertBefore(panel, anchor);
        return true;
    };
    const messageFor = (error: unknown): string => GithubError.message(error, {
        fallback: 'The extension did not return an error description. Reload this page and try again.',
    });
    const deletionMessageFor = (error: unknown): string => {
        const err = error && typeof error === 'object' ? error as { source?: unknown; message?: unknown } : null;
        return err?.source === 'peakbagger' && err.message
            ? String(err.message).replace(/\s+/g, ' ').trim().slice(0, 220)
            : messageFor(error);
    };

    const endWorkflow = async (expected: ActiveWorkflow | null = workflow): Promise<void> => {
        if (workflow !== expected) return;
        const ending = workflow;
        workflow = null;
        if (ending) await TrustedAction.end(ext, ending, ending.generation);
    };

    const beginWorkflow = async (event: Event | null | undefined): Promise<ActiveWorkflow | null | undefined> => {
        if (event?.isTrusted !== true) return null;
        const generation = String(++workflowGeneration);
        await endWorkflow();
        const begun = await TrustedAction.begin(ext, event, 'profile-backup', generation);
        if (!begun) return null;
        if (generation !== String(workflowGeneration)) {
            void TrustedAction.end(ext, begun, generation);
            return undefined;
        }
        workflow = { ...begun, generation };
        return workflow;
    };

    const renderIdle = (status: ProfileRepoStatus): void => {
        idleStatus = status;
        panel?.setAttribute('aria-busy', 'false');
        body(
            node('div', { class: 'bpb-profile-copy' }, [
                node('strong', { text: 'Back up your ascents and TRs' }),
                node('span', { text: `Archive every ascent and its TR from every year to ${status.repo?.fullName ?? ''}, even when this page shows only one year. Existing backups are skipped.` }),
            ]),
            node('div', { class: 'bpb-profile-actions' }, [
                button('Back up all ascents and TRs', event => { void startBackup(false, event); }, true),
                button('Refresh all', renderRefreshConfirmation),
            ]),
        );
    };

    const renderRefreshConfirmation = (): void => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: 'Refresh all ascents and TRs?' }),
            node('span', { text: 'This re-syncs every ascent and its TR from every year and commits them to GitHub in groups of up to 10, including unchanged entries.' }),
        ]),
        node('div', { class: 'bpb-profile-actions' }, [
            button('Refresh all ascents and TRs', event => { void startBackup(true, event); }, true),
            button('Cancel', () => { void initialize(); }),
        ]),
    );

    const cancelPreparation = (owner: PreparationOwner, restoreFocus = true): void => {
        if (preparation !== owner) return;
        const ownedFocus = restoreFocus && Boolean(panel?.contains(document.activeElement));
        preparation = null;
        workflowGeneration++;
        owner.controller.abort();
        void endWorkflow(owner.workflow);
        if (idleStatus) renderIdle(idleStatus);
        if (ownedFocus && document.activeElement === document.body) {
            panel?.querySelector<HTMLElement>('.bpb-profile-primary')?.focus({ preventScroll: true });
        }
    };
    const renderPreparing = (owner: PreparationOwner): void => {
        panel?.setAttribute('aria-busy', 'true');
        body(
            node('div', { class: 'bpb-profile-copy' }, [
                node('strong', { text: 'Preparing backup…' }),
                node('span', { text: 'Reading the complete ascent list and your repository.' }),
            ]),
            node('div', { class: 'bpb-profile-actions' }, [disabledButton('Preparing…'), button('Cancel', () => cancelPreparation(owner))]),
        );
    };

    const renderDeletionResult = (status: ProfileRepoStatus, response: DeletionConfirmResponse | null | undefined): void => {
        if (!response?.ok) {
            return body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: 'GitHub cleanup needs attention' }),
                    node('span', { text: deletionMessageFor(response?.error) }),
                ]),
                node('div', { class: 'bpb-profile-actions' }, [
                    button('Try again', () => { void confirmPendingDeletion(status); }, true),
                    button('Not now', () => renderIdle(status)),
                ]),
            );
        }
        if (!response.confirmed) {
            return body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: 'GitHub was not changed' }),
                    node('span', { text: 'Peakbagger still lists this ascent, so its backup files were kept.' }),
                ]),
                node('div', { class: 'bpb-profile-actions' }, [
                    button('Done', () => renderIdle(status), true),
                ]),
            );
        }

        const result = response.result || {};
        const detail = result.noOp
            ? 'No Better Peakbagger files remained for this ascent.'
            : `${result.removedFileCount || 0} backup file${result.removedFileCount === 1 ? '' : 's'} removed from the current branch. Git history and your own files remain.`;
        return body(
            node('div', { class: 'bpb-profile-copy' }, [
                node('strong', { text: result.noOp ? 'GitHub backup was already clear' : 'GitHub backup files removed' }),
                node('span', { text: detail }),
            ]),
            node('div', { class: 'bpb-profile-actions' }, [
                result.commitUrl
                    ? node('a', {
                        class: 'bpb-profile-btn bpb-profile-primary',
                        href: result.commitUrl,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        text: 'View commit',
                    })
                    : null,
                button('Done', () => renderIdle(status), !result.commitUrl),
            ]),
        );
    };

    const openChallenge = (url: string, onFailure: () => void): boolean => {
        let opened: Window | null = null;
        try {
            opened = window.open('about:blank', '_blank');
            if (!opened) throw new Error('tab blocked');
            opened.opener = null;
            opened.location.replace(url);
            return true;
        } catch {
            try { opened?.close(); } catch { /* the failed tab is already unusable */ }
            onFailure();
            return false;
        }
    };

    const challengeFailure = (url: string): HTMLDivElement => node('div', { class: 'bpb-profile-challenge-failure' }, [
        node('span', {
            class: 'bpb-profile-error',
            text: 'The check tab could not be opened. Use this Peakbagger link, then resume.',
        }),
        node('a', {
            class: 'bpb-profile-challenge-link',
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: url,
        }),
    ]);

    const renderChallenge = (state: ProfileBackupRunnerState<AscentListEntry>, { openFailed = false } = {}): void => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: Cloudflare.copy.title }),
            node('span', { text: 'Complete the check in the new tab, then resume here. The interrupted ascent will be retried.' }),
        ]),
        openFailed ? challengeFailure(state.challengeUrl ?? '') : null,
        node('div', { class: 'bpb-profile-actions' }, [
            button('Open check', () => openChallenge(
                state.challengeUrl ?? '',
                () => renderChallenge(state, { openFailed: true }),
            ), true),
            button('Resume', () => { void runner?.resume(); }),
            button('Cancel', () => runner?.cancel()),
        ]),
    );

    const renderListChallenge = (
        result: SourceFailure,
        refreshAll: boolean,
        { openFailed = false } = {},
    ): void => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: Cloudflare.copy.title }),
            node('span', { text: 'Complete the check, then retry the backup.' }),
        ]),
        openFailed ? challengeFailure(result.url ?? '') : null,
        node('div', { class: 'bpb-profile-actions' }, [
            button('Open check', () => openChallenge(
                result.url ?? '',
                () => renderListChallenge(result, refreshAll, { openFailed: true }),
            ), true),
            button('Retry', event => { void startBackup(refreshAll, event); }),
            button('Cancel', () => { void initialize(); }),
        ]),
    );

    const renderFailures = (failures: readonly ProfileBackupFailure[]): HTMLUListElement | null => {
        if (!failures.length) return null;
        const list = node('ul', { class: 'bpb-profile-failures' });
        for (const failure of failures) {
            const link = node('a', { href: failure.ascentUrl, target: '_blank', rel: 'noopener noreferrer', text: failure.peakName || `Ascent ${failure.aid}` });
            list.append(node('li', {}, [link, document.createTextNode(` — ${failure.reason}`)]));
        }
        return list;
    };

    const renderState = (state: ProfileBackupRunnerState<AscentListEntry>): void => {
        panel?.setAttribute('aria-busy', String(
            state.status === 'pause-requested' || state.status === 'cancel-requested'));
        if (state.status === 'pause-requested' || state.status === 'cancel-requested') {
            const focusWasInPanel = Boolean(panel?.contains(document.activeElement));
            const cancelling = state.status === 'cancel-requested';
            const writing = state.uploading > 0;
            const title = cancelling ? 'Stopping ascent and TR backup' : 'Pause requested';
            const message = writing ? cancelling ? 'Stopping after the current GitHub batch…' : 'Pausing after the current GitHub batch…'
                : cancelling ? 'Stopping…' : 'Pausing…';
            const existingProgress = panel?.querySelector<HTMLProgressElement>('progress');
            if (panel?.querySelector('.bpb-profile-copy > strong')?.textContent === title && existingProgress) {
                pendingText?.set(message);
                existingProgress.value = state.completed;
                return;
            }
            const pendingLabel = node('span', { text: message });
            pendingText = createStableText(pendingLabel);
            pendingText.reserve(['Stopping after the current GitHub batch…', 'Pausing after the current GitHub batch…', 'Stopping…', 'Pausing…']);
            const statusCopy = node('div', {
                class: 'bpb-profile-copy', tabindex: '-1',
            }, [
                node('strong', { text: title }), pendingLabel,
            ]);
            body(
                statusCopy,
                node('progress', {
                    class: 'bpb-profile-progress', max: Math.max(1, state.total), value: state.completed,
                }),
                node('div', { class: 'bpb-profile-actions' }, cancelling
                    ? [node('span', { 'aria-hidden': 'true' }), disabledButton('Cancel requested')]
                    : [disabledButton('Pause requested'), button('Cancel', () => runner?.cancel())]),
            );
            if (focusWasInPanel) {
                (panel?.querySelector<HTMLElement>('button:not(:disabled)') || statusCopy).focus();
            }
            return;
        }
        if (state.status === 'paused' && state.pauseReason === 'challenge') return renderChallenge(state);
        if (state.status === 'complete' || state.status === 'cancelled') {
            void endWorkflow();
            const summary = state.status === 'complete'
                ? `Backed up ${state.backedUp}; skipped ${state.skipped}; failed ${state.failures.length}.`
                : `Cancelled. Backed up ${state.backedUp}; skipped ${state.skipped}; failed ${state.failures.length}; not backed up ${state.notReached}.`;
            return body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: state.status === 'complete' ? 'Ascent and TR backup complete' : 'Ascent and TR backup stopped' }),
                    node('span', { text: summary }),
                ]),
                renderFailures(state.failures),
                node('div', { class: 'bpb-profile-actions' }, [button('Done', () => { void initialize(); }, true)]),
            );
        }
        if (state.status === 'paused') {
            if (state.pauseReason === 'github') {
                const batchSize = state.pauseBatchSize || state.buffered || 1;
                return body(
                    node('div', { class: 'bpb-profile-copy' }, [
                        node('strong', { text: 'Ascent and TR backup paused' }),
                        node('span', { text: `The ${batchSize}-ascent batch is still ready. Resume will retry it; nothing was discarded.` }),
                    ]),
                    renderFailures(state.pauseError ? [state.pauseError] : []),
                    node('div', { class: 'bpb-profile-actions' }, [
                        button('Resume', () => { void runner?.resume(); }, true), button('Cancel', () => runner?.cancel()),
                    ]),
                );
            }
            const copy = state.pauseReason === 'transient'
                ? 'Several ascents could not be reached. Check your connection before resuming.'
                : 'Backup paused. This tab must stay open.';
            return body(
                node('div', { class: 'bpb-profile-copy' }, [node('strong', { text: 'Ascent and TR backup paused' }), node('span', { text: copy })]),
                renderFailures(state.failures),
                node('div', { class: 'bpb-profile-actions' }, [
                    button('Resume', () => { void runner?.resume(); }, true), button('Cancel', () => runner?.cancel()),
                ]),
            );
        }

        const current = state.current;
        const readyLabel = `${state.buffered} ascent${state.buffered === 1 ? '' : 's'} ready`;
        const activity = state.producerWaiting
            ? 'Waiting for GitHub…'
            : current
                ? `Reading ${current.peakName || `ascent ${current.aid}`}…`
                : state.uploading
                    ? `Uploading ${state.uploading} ascent${state.uploading === 1 ? '' : 's'} to GitHub…`
                    : state.buffered
                        ? `${readyLabel} for GitHub…`
                        : 'Starting…';
        const note = state.producerWaiting
            ? `${readyLabel}. Reading resumes automatically when GitHub frees space.`
            : `${state.fetched} read${state.buffered ? ` · ${readyLabel}` : ''}${state.uploading ? ` · uploading ${state.uploading}` : ''} · Keep this tab open.`;
        // Progress ticks must not replace the focused Pause/Cancel controls.
        const existing = panel?.querySelector('.bpb-profile-progress-copy');
        if (existing && panel?.querySelector('.bpb-profile-actions button')?.textContent === 'Pause') {
            const countHeading = existing.querySelector('strong');
            const activityLabel = existing.querySelector('span');
            const activityTitle = existing.querySelector<HTMLElement>('.bpb-profile-activity');
            if (countHeading) countHeading.textContent = `${state.completed} of ${state.total}`;
            if (activityLabel) activityLabel.textContent = activity;
            if (activityTitle) activityTitle.title = activity;
            progressNoteText?.set(note);
            const progress = panel.querySelector<HTMLProgressElement>('progress');
            if (progress) {
                progress.max = Math.max(1, state.total);
                progress.value = state.completed;
            }
            return;
        }
        const noteLabel = node('span', { class: 'bpb-profile-note', text: note });
        progressNoteText = createStableText(noteLabel);
        const countSize = '8'.repeat(String(state.total).length);
        progressNoteText.reserve([
            `${countSize} read · ${countSize} ascents ready · uploading ${countSize} · Keep this tab open.`,
            `${countSize} ascents ready. Reading resumes automatically when GitHub frees space.`,
        ]);
        body(
            node('div', { class: 'bpb-profile-progress-copy' }, [
                node('strong', { text: `${state.completed} of ${state.total}` }),
                node('span', { class: 'bpb-profile-activity', text: activity, title: activity }), noteLabel,
            ]),
            node('progress', { class: 'bpb-profile-progress', max: Math.max(1, state.total), value: state.completed }),
            node('div', { class: 'bpb-profile-actions' }, [
                button('Pause', () => runner?.pause()), button('Cancel', () => runner?.cancel()),
            ]),
        );
    };

    const responseText = (url: string | null, kind: 'edit' | 'gpx', signal?: AbortSignal): Promise<SourceTextResult> =>
        backupSource.fetchPeakbaggerResource(url, { kind, signal });
    const responseDocument = (url: string | null, kind: 'edit' | 'list', signal?: AbortSignal): Promise<SourceDocumentResult> =>
        backupSource.fetchPeakbaggerDocument(url, { kind, signal });
    const rejectedPage = (url: string, kind: 'edit' | 'list', code: 'identity-mismatch' | 'parse'): SourceFailure => {
        const error = PeakbaggerError.failure(code, { resource: kind });
        return { kind: 'wrong-content', url, error, reason: PeakbaggerError.message(error) };
    };

    const completeList = async (signal?: AbortSignal): Promise<ParsedAscentList | SourceFailure> => {
        const target = Core.fullListUrl(location.href);
        const current = new URL(location.href);
        if (current.searchParams.get('j') === '-1' && current.searchParams.get('y') === '9999') {
            return Core.parseAscentList(document, { url: location.href });
        }
        const result = await responseDocument(target, 'list', signal);
        if (result.kind !== 'ok') return result;
        const parsed = Core.parseAscentList(result.document, { url: target });
        return parsed.isOwner && parsed.climberId === ownerId
            ? parsed
            : rejectedPage(target, 'list', 'identity-mismatch');
    };

    const confirmPendingDeletion = async (status: ProfileRepoStatus): Promise<void> => {
        const pending = await sendBg<PendingDeletionResponse>({ type: 'GITHUB_ASCENT_DELETE_PENDING' });
        if (!pending?.ok || !pending.aids?.length) {
            renderIdle(status);
            return;
        }
        body(node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: 'Confirming the Peakbagger deletion…' }),
            node('span', { text: 'Checking your complete My Ascents list before GitHub is changed.' }),
        ]));

        const list = await completeList();
        if (!list || 'kind' in list || !list.isOwner || list.climberId !== ownerId) {
            renderDeletionResult(status, {
                ok: false,
                error: {
                    source: 'peakbagger',
                    message: (list && 'reason' in list ? list.reason : undefined)
                        || 'The complete My Ascents list could not be verified. GitHub was not changed.',
                },
            });
            return;
        }
        const allAscentIds = list.ascents.map(ascent => ascent.aid);
        // Intents are source-tab scoped and normally singular. Process in order
        // so each deletion remains its own retryable GitHub transaction.
        for (const aid of pending.aids) {
            const response = await sendBg<DeletionConfirmResponse>({
                type: 'GITHUB_ASCENT_DELETE_CONFIRM',
                aid,
                climberId: ownerId,
                allAscentIds,
                pageComplete: true,
            });
            if (!response?.ok || !response.confirmed) {
                renderDeletionResult(status, response);
                return;
            }
            renderDeletionResult(status, response);
        }
    };

    const loadAscent = async (
        item: AscentListEntry,
        { probeUrl = null, signal }: Partial<LoadItemOptions> = {},
    ): Promise<LoadItemResult<AscentBackupData>> => {
        if (probeUrl) {
            const kind = /GPXFile\.aspx|GetAscentGPX\.aspx/i.test(new URL(probeUrl, location.href).pathname) ? 'gpx' : 'edit';
            const probe = await responseText(probeUrl, kind, signal);
            if (probe.kind !== 'ok') return probe;
        }
        const editUrl = new URL(`/climber/AscentEdit.aspx?aid=${item.aid}`, location.origin).toString();
        if (ownerId == null) return rejectedPage(editUrl, 'edit', 'identity-mismatch');
        const edit = await responseDocument(editUrl, 'edit', signal);
        if (edit.kind !== 'ok') return edit;
        const parsed = backupSource.snapshotFromEditDocument({
            doc: edit.document,
            editUrl,
            baseUrl: location.href,
            ascentId: item.aid,
            peakId: item.pid,
            climberId: ownerId,
            fallbackDate: item.date,
            fallbackPeakName: item.peakName,
            extensionVersion: ext.runtime.getManifest ? (ext.runtime.getManifest().version ?? '') : '',
        });
        if (!parsed.ok) {
            return rejectedPage(editUrl, 'edit', parsed.code === 'identity' ? 'identity-mismatch' : 'parse');
        }
        let gpx: string | null = null;
        if (item.hasGpx) {
            // Mirror the site's own ascent-page link (GPXFile.aspx?…&sep=1) so the
            // backup stores byte-for-byte what a user clicking that link gets, and
            // what the GPX analyzer reads. The old GetAscentGPX.aspx endpoint was
            // renamed and now 302s to a 200 HTML error page.
            const gpxUrl = backupSource.storedGpxUrl({ origin: location.origin, ascentId: item.aid });
            const track = await responseText(gpxUrl, 'gpx', signal);
            if (track.kind !== 'ok') return track;
            gpx = track.text;
        }
        return { kind: 'ok', data: { snapshot: parsed.snapshot, gpx } };
    };

    const pushAscentBatch = async (
        batch: Array<{ item: AscentListEntry; data: AscentBackupData }>,
    ): Promise<RuntimeMessageResponse | null> => {
        if (!workflow) return { ok: false, error: { code: 'activation-required' } };
        const result = await sendBg({
            type: 'GITHUB_BACKUP_PROFILE_BATCH',
            grantToken: workflow.grantToken,
            generation: workflow.generation,
            entries: batch.map(({ item, data }) => ({
                aid: item.aid,
                snapshot: data.snapshot,
                gpx: data.gpx,
            })),
        });
        if (result && !result.ok && result.error) {
            return { ...result, error: { ...result.error, message: messageFor(result.error) } };
        }
        return result;
    };

    const startBackup = async (refreshAll: boolean, event: Event): Promise<void> => {
        if (event?.isTrusted !== true) return;
        const activeWorkflow = await beginWorkflow(event);
        if (activeWorkflow === undefined) return;
        if (!activeWorkflow) {
            return body(
                node('span', { class: 'bpb-profile-error', text: messageFor({ code: 'activation-required' }) }),
                button('Try again', retryEvent => { void startBackup(refreshAll, retryEvent); }, true),
            );
        }
        const owner: PreparationOwner = { workflow: activeWorkflow, generation: workflowGeneration, controller: new AbortController() };
        preparation = owner;
        const ownsPreparation = () => preparation === owner && workflow === activeWorkflow && workflowGeneration === owner.generation;
        renderPreparing(owner);
        const list = await completeList(owner.controller.signal);
        if (!ownsPreparation()) return;
        if (!list || 'kind' in list) {
            preparation = null;
            panel?.setAttribute('aria-busy', 'false');
            void endWorkflow(activeWorkflow);
            if (list && list.kind === 'challenged') return renderListChallenge(list, refreshAll);
            return body(
                node('span', { class: 'bpb-profile-error', text: (list && list.reason) || 'Could not read the complete ascent list.' }),
                button('Try again', retryEvent => { void startBackup(refreshAll, retryEvent); }),
            );
        }
        const status = await sendBg<ProfileBackupStatusResponse>({ type: 'GITHUB_BACKUP_PROFILE_STATUS' });
        if (!ownsPreparation()) return;
        if (!status || !status.ok) {
            preparation = null;
            panel?.setAttribute('aria-busy', 'false');
            void endWorkflow(activeWorkflow);
            return body(
                node('span', { class: 'bpb-profile-error', text: messageFor(status && status.error) }),
                button('Try again', retryEvent => { void startBackup(refreshAll, retryEvent); }),
            );
        }
        preparation = null;
        runner = Core.createRunner({
            ascents: list.ascents,
            existingFolders: status.folders,
            refreshAll,
            loadItem: loadAscent,
            pushBatch: pushAscentBatch,
            onState: renderState,
        });
        void runner.run();
    };

    const initialize = async (): Promise<void> => {
        await endWorkflow();
        runner = null;
        const current = Core.parseAscentList(document, { url: location.href });
        if (!current.isOwner) { removePanel(); return; }
        ownerId = current.climberId;
        const statusResult = await sendBgResult<BackupStatusResponse>({ type: 'GITHUB_BACKUP_STATUS' });
        const status = statusResult.kind === 'response' ? statusResult.value : null;
        const statusKnown = typeof status?.enabled === 'boolean'
            && typeof status?.connected === 'boolean'
            && (!status.connected || typeof status.repo?.fullName === 'string');
        if (!statusKnown) {
            if (!ensurePanel()) return;
            body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: 'Ascent and TR backup is temporarily unavailable' }),
                    node('span', { text: 'Better Peakbagger could not check GitHub. Your ascent list is unchanged.' }),
                ]),
                node('div', { class: 'bpb-profile-actions' }, [
                    button('Try again', () => { void initialize(); }, true),
                ]),
            );
            return;
        }
        if (!status.enabled || !status.connected) { removePanel(); return; }
        if (!ensurePanel()) return;
        await confirmPendingDeletion(status);
    };

    const start = (): void => { void initialize(); };
    window.addEventListener('pagehide', () => { if (preparation) cancelPreparation(preparation, false); });
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
