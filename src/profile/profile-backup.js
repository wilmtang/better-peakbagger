// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Full-profile GitHub backup on the signed-in climber's ClimbListC page. The
// tab owns the multi-minute producer/consumer pipeline; the MV3 worker wakes
// for repository preflight and serialized atomic batch commits.

import { profileBackupCore as Core } from './profile-backup-core.js';
import { ascentBackupSource as Source } from '../ascent/ascent-backup-source.js';
import { githubError as GithubError } from '../github/github-error-copy.js';
import { peakbaggerCloudflare as Cloudflare } from '../peakbagger/peakbagger-cloudflare.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import { dom as Dom } from '../ui/dom.js';
import { runtimeMessage as RuntimeMessage } from '../ui/runtime-message.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext || !ext.runtime || !/\/climber\/climblistc\.aspx$/i.test(location.pathname)) return;

    const sendBg = RuntimeMessage.bind(ext);
    const sendBgResult = RuntimeMessage.bindResult(ext);
    const node = Dom.element;

    let panel;
    let runner;
    let ownerId;

    const body = (...children) => panel.querySelector('.bpb-profile-body').replaceChildren(...children.filter(Boolean));
    const button = (text, onclick, primary = false) => node('button', {
        type: 'button', class: `bpb-profile-btn${primary ? ' bpb-profile-primary' : ''}`, text, onclick,
    });
    const removePanel = () => {
        if (panel) panel.remove();
        panel = null;
    };
    const ensurePanel = () => {
        if (panel?.isConnected) return true;
        panel = node('section', {
            id: 'bpb-profile-backup',
            class: 'bpb-profile-panel',
            'aria-label': 'GitHub profile backup',
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
    const messageFor = error => GithubError.message(error, {
        fallback: 'The extension did not return an error description. Reload this page and try again.',
    });
    const deletionMessageFor = error => error?.source === 'peakbagger' && error.message
        ? String(error.message).replace(/\s+/g, ' ').trim().slice(0, 220)
        : messageFor(error);

    const renderIdle = status => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: 'Back up your Peakbagger profile' }),
            node('span', { text: `Archive every ascent from every year to ${status.repo.fullName}, even when this page shows only one year. Existing backups are skipped.` }),
        ]),
        node('div', { class: 'bpb-profile-actions' }, [
            button('Back up all ascents', () => startBackup(false), true),
            button('Refresh all', renderRefreshConfirmation),
        ]),
    );

    const renderRefreshConfirmation = () => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: 'Refresh every ascent?' }),
            node('span', { text: 'This re-syncs every ascent from every year and commits them to GitHub in groups of up to 10, including unchanged entries.' }),
        ]),
        node('div', { class: 'bpb-profile-actions' }, [
            button('Refresh every ascent', () => startBackup(true), true),
            button('Cancel', () => initialize()),
        ]),
    );

    const renderPreparing = () => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: 'Preparing backup…' }),
            node('span', { text: 'Reading the complete ascent list and your repository.' }),
        ]),
    );

    const renderDeletionResult = (status, response) => {
        if (!response?.ok) {
            return body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: 'GitHub cleanup needs attention' }),
                    node('span', { text: deletionMessageFor(response?.error) }),
                ]),
                node('div', { class: 'bpb-profile-actions' }, [
                    button('Try again', () => confirmPendingDeletion(status), true),
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

    const openChallenge = (url, onFailure) => {
        let opened = null;
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

    const challengeFailure = url => node('div', { class: 'bpb-profile-challenge-failure' }, [
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

    const renderChallenge = (state, { openFailed = false } = {}) => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: Cloudflare.copy.title }),
            node('span', { text: 'Complete the check in the new tab, then resume here. The interrupted ascent will be retried.' }),
        ]),
        openFailed ? challengeFailure(state.challengeUrl) : null,
        node('div', { class: 'bpb-profile-actions' }, [
            button('Open check', () => openChallenge(
                state.challengeUrl,
                () => renderChallenge(state, { openFailed: true }),
            ), true),
            button('Resume', () => { void runner.resume(); }),
            button('Cancel', () => runner.cancel()),
        ]),
    );

    const renderListChallenge = (result, refreshAll, { openFailed = false } = {}) => body(
        node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: Cloudflare.copy.title }),
            node('span', { text: 'Complete the check, then retry the backup.' }),
        ]),
        openFailed ? challengeFailure(result.url) : null,
        node('div', { class: 'bpb-profile-actions' }, [
            button('Open check', () => openChallenge(
                result.url,
                () => renderListChallenge(result, refreshAll, { openFailed: true }),
            ), true),
            button('Retry', () => startBackup(refreshAll)),
            button('Cancel', () => initialize()),
        ]),
    );

    const renderFailures = failures => {
        if (!failures.length) return null;
        const list = node('ul', { class: 'bpb-profile-failures' });
        for (const failure of failures) {
            const link = node('a', { href: failure.ascentUrl, target: '_blank', rel: 'noopener noreferrer', text: failure.peakName || `Ascent ${failure.aid}` });
            list.append(node('li', {}, [link, document.createTextNode(` — ${failure.reason}`)]));
        }
        return list;
    };

    const renderState = state => {
        if (state.status === 'paused' && state.pauseReason === 'challenge') return renderChallenge(state);
        if (state.status === 'complete' || state.status === 'cancelled') {
            const summary = state.status === 'complete'
                ? `Backed up ${state.backedUp}; skipped ${state.skipped}; failed ${state.failures.length}.`
                : `Cancelled. Backed up ${state.backedUp}; skipped ${state.skipped}; failed ${state.failures.length}; not backed up ${state.notReached}.`;
            return body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: state.status === 'complete' ? 'Profile backup complete' : 'Profile backup stopped' }),
                    node('span', { text: summary }),
                ]),
                renderFailures(state.failures),
                node('div', { class: 'bpb-profile-actions' }, [button('Done', () => initialize(), true)]),
            );
        }
        if (state.status === 'paused') {
            if (state.pauseReason === 'github') {
                const batchSize = state.pauseBatchSize || state.buffered || 1;
                return body(
                    node('div', { class: 'bpb-profile-copy' }, [
                        node('strong', { text: 'GitHub backup paused' }),
                        node('span', { text: `The ${batchSize}-ascent batch is still ready. Resume will retry it; nothing was discarded.` }),
                    ]),
                    renderFailures(state.pauseError ? [state.pauseError] : []),
                    node('div', { class: 'bpb-profile-actions' }, [
                        button('Resume', () => { void runner.resume(); }, true), button('Cancel', () => runner.cancel()),
                    ]),
                );
            }
            const copy = state.pauseReason === 'transient'
                ? 'Several ascents could not be reached. Check your connection before resuming.'
                : 'Backup paused. This tab must stay open.';
            return body(
                node('div', { class: 'bpb-profile-copy' }, [node('strong', { text: 'Profile backup paused' }), node('span', { text: copy })]),
                renderFailures(state.failures),
                node('div', { class: 'bpb-profile-actions' }, [
                    button('Resume', () => { void runner.resume(); }, true), button('Cancel', () => runner.cancel()),
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
        body(
            node('div', { class: 'bpb-profile-progress-copy' }, [
                node('strong', { text: `${state.completed} of ${state.total}` }),
                node('span', { text: activity }),
                node('span', { class: 'bpb-profile-note', text: note }),
            ]),
            node('progress', { class: 'bpb-profile-progress', max: Math.max(1, state.total), value: state.completed }),
            node('div', { class: 'bpb-profile-actions' }, [
                button('Pause', () => runner.pause()), button('Cancel', () => runner.cancel()),
            ]),
        );
    };

    const responseText = (url, kind) => Source.fetchPeakbaggerResource(url, { kind });
    const responseDocument = (url, kind) => Source.fetchPeakbaggerDocument(url, { kind });
    const rejectedPage = (url, kind, code) => {
        const error = PeakbaggerError.failure(code, { resource: kind });
        return { kind: 'wrong-content', url, error, reason: PeakbaggerError.message(error) };
    };

    const completeList = async () => {
        const target = Core.fullListUrl(location.href);
        const current = new URL(location.href);
        if (current.searchParams.get('j') === '-1' && current.searchParams.get('y') === '9999') {
            return Core.parseAscentList(document, { url: location.href });
        }
        const result = await responseDocument(target, 'list');
        if (result.kind !== 'ok') return result;
        const parsed = Core.parseAscentList(result.document, { url: target });
        return parsed.isOwner && parsed.climberId === ownerId
            ? parsed
            : rejectedPage(target, 'list', 'identity-mismatch');
    };

    const confirmPendingDeletion = async status => {
        const pending = await sendBg({ type: 'GITHUB_ASCENT_DELETE_PENDING' });
        if (!pending?.ok || !pending.aids?.length) {
            renderIdle(status);
            return;
        }
        body(node('div', { class: 'bpb-profile-copy' }, [
            node('strong', { text: 'Confirming the Peakbagger deletion…' }),
            node('span', { text: 'Checking your complete My Ascents list before GitHub is changed.' }),
        ]));

        const list = await completeList();
        if (!list || list.kind || !list.isOwner || list.climberId !== ownerId) {
            renderDeletionResult(status, {
                ok: false,
                error: {
                    source: 'peakbagger',
                    message: (list && list.reason)
                        || 'The complete My Ascents list could not be verified. GitHub was not changed.',
                },
            });
            return;
        }
        const allAscentIds = list.ascents.map(ascent => ascent.aid);
        // Intents are source-tab scoped and normally singular. Process in order
        // so each deletion remains its own retryable GitHub transaction.
        for (const aid of pending.aids) {
            const response = await sendBg({
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

    const loadAscent = async (item, { probeUrl = null } = {}) => {
        if (probeUrl) {
            const kind = /GPXFile\.aspx|GetAscentGPX\.aspx/i.test(new URL(probeUrl, location.href).pathname) ? 'gpx' : 'edit';
            const probe = await responseText(probeUrl, kind);
            if (probe.kind !== 'ok') return probe;
        }
        const editUrl = new URL(`/climber/AscentEdit.aspx?aid=${item.aid}`, location.origin).toString();
        const edit = await responseDocument(editUrl, 'edit');
        if (edit.kind !== 'ok') return edit;
        const parsed = Source.snapshotFromEditDocument({
            doc: edit.document,
            editUrl,
            baseUrl: location.href,
            ascentId: item.aid,
            peakId: item.pid,
            climberId: ownerId,
            fallbackDate: item.date,
            fallbackPeakName: item.peakName,
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : '',
        });
        if (!parsed.ok) {
            return rejectedPage(editUrl, 'edit', parsed.code === 'identity' ? 'identity-mismatch' : 'parse');
        }
        let gpx = null;
        if (item.hasGpx) {
            // Mirror the site's own ascent-page link (GPXFile.aspx?…&sep=1) so the
            // backup stores byte-for-byte what a user clicking that link gets, and
            // what the GPX analyzer reads. The old GetAscentGPX.aspx endpoint was
            // renamed and now 302s to a 200 HTML error page.
            const gpxUrl = Source.storedGpxUrl({ origin: location.origin, ascentId: item.aid });
            const track = await responseText(gpxUrl, 'gpx');
            if (track.kind !== 'ok') return track;
            gpx = track.text;
        }
        return { kind: 'ok', data: { snapshot: parsed.snapshot, gpx } };
    };

    const pushAscentBatch = async batch => {
        const result = await sendBg({
            type: 'GITHUB_BACKUP_PROFILE_BATCH',
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

    const startBackup = async refreshAll => {
        renderPreparing();
        const list = await completeList();
        if (!list || list.kind) {
            if (list && list.kind === 'challenged') return renderListChallenge(list, refreshAll);
            return body(node('span', { class: 'bpb-profile-error', text: (list && list.reason) || 'Could not read the complete ascent list.' }), button('Try again', () => startBackup(refreshAll)));
        }
        const status = await sendBg({ type: 'GITHUB_BACKUP_PROFILE_STATUS' });
        if (!status || !status.ok) {
            return body(node('span', { class: 'bpb-profile-error', text: messageFor(status && status.error) }), button('Try again', () => startBackup(refreshAll)));
        }
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

    const initialize = async () => {
        runner = null;
        const current = Core.parseAscentList(document, { url: location.href });
        if (!current.isOwner) { removePanel(); return; }
        ownerId = current.climberId;
        const statusResult = await sendBgResult({ type: 'GITHUB_BACKUP_STATUS' });
        const status = statusResult.kind === 'response' ? statusResult.value : null;
        const statusKnown = typeof status?.enabled === 'boolean'
            && typeof status?.connected === 'boolean'
            && (!status.connected || typeof status.repo?.fullName === 'string');
        if (!statusKnown) {
            if (!ensurePanel()) return;
            body(
                node('div', { class: 'bpb-profile-copy' }, [
                    node('strong', { text: 'Profile backup is temporarily unavailable' }),
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

    const start = () => { void initialize(); };
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
