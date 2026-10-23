// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { capturePhases as CapturePhases } from '../src/capture/capture-phases.js';
import { captureErrorPolicy } from '../src/capture/capture-error-policy.js';
import { matchLabel } from '../src/capture/match-confidence.js';
import { providerFromUrl } from '../src/capture/provider-url.js';
import { PEAKBAGGER_ORIGIN } from '../src/peakbagger/peakbagger-origin.js';
import { settings as Settings } from '../src/settings/settings.js';
import { units as Units } from '../src/ui/units.js';
import { createStableText } from '../src/ui/stable-text.js';
import { rateLimitMessage } from '../src/net/rate-limit.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    const state = document.getElementById('state');
    const results = document.getElementById('results');
    const list = document.getElementById('peak-list');
    const summary = document.getElementById('track-summary');
    const timestampChoice = document.getElementById('timestamp-choice');
    const includeTimestampsOnce = document.getElementById('include-timestamps-once');
    const privacyNote = document.getElementById('capture-privacy-note');
    const privacyText = createStableText(privacyNote);
    const timedPrivacy = 'Peak lookup sends small track-corridor boxes to Peakbagger. Opening drafts sends the reduced GPX track with coordinates, elevation, and time to Preview. Save is always manual.';
    const timelessPrivacy = 'Peak lookup sends small track-corridor boxes to Peakbagger. Opening drafts sends the reduced GPX track with coordinates and elevation, with timestamps removed, to Preview. Save is always manual.';
    privacyText.reserve([timedPrivacy, timelessPrivacy]);
    const openButton = document.getElementById('open-drafts');
    const clearCaptureButton = document.getElementById('clear-capture');
    const selectionCount = document.getElementById('selection-count');
    const selectionLockHint = document.getElementById('selection-lock-hint');
    const openNote = document.getElementById('open-note');
    const providerLabel = document.getElementById('provider-label');
    const settingsButton = document.getElementById('open-settings');
    let activeTab = null;
    let currentJob = null;
    // Resolved once when the popup opens. `units: 'auto'` means "follow the
    // page", and the popup has no Peakbagger page to follow — it opens over a
    // Garmin or Strava activity — so it takes the shared module's documented
    // imperial fallback rather than inventing a second source of truth or
    // persisting a "last units seen" value for a cosmetic tie-break.
    let displayUnits = { distance: Units.IMPERIAL, elevation: Units.IMPERIAL };
    let displayUnitsReady = false;
    let pendingUnitsJob = null;
    let pollTimer = null;
    let captureRevision = 0;
    let capturePending = false;
    let resultActionPending = false;
    let cancelling = false;
    let progressCard = null;
    let popupCaptureStartedAt = null;
    let popupDiagnosticReported = false;

    const replaceOperation = () => {
        clearTimeout(pollTimer);
        pollTimer = null;
        capturePending = false;
        pendingUnitsJob = null;
        return ++captureRevision;
    };

    const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
    const reportPopupDiagnostic = job => {
        if (globalThis.BPB_CAPTURE_DIAGNOSTICS !== true
            || popupDiagnosticReported
            || popupCaptureStartedAt === null
            || !CapturePhases.isTerminal(job?.phase)) return;
        popupDiagnosticReported = true;
        console.debug('Better Peakbagger popup diagnostics', {
            version: 1,
            outcome: job.phase,
            popupToReadyMs: Math.round(Math.max(0, monotonicNow() - popupCaptureStartedAt) * 10) / 10,
        });
    };

    const clear = element => { while (element.firstChild) element.firstChild.remove(); };

    // The worker reports its own failures as data — a job with phase 'error', or
    // a route result carrying { error: { code, message } } — so those sentences
    // are product copy and belong on screen. A *rejected* sendMessage is the
    // messaging layer instead, and its text is browser internals ("Could not
    // establish connection. Receiving end does not exist."). Mark the errors
    // this file raises from a worker answer so the catch can tell them apart;
    // anything unmarked gets the same plain transport copy poll() and
    // beginCapture() already use.
    const TRANSPORT_FAILURE = 'The extension couldn’t be reached. Try again in a moment.';
    const reportedFailure = message => Object.assign(new Error(message), { fromWorker: true });
    const publicMessage = error => (error?.fromWorker && error.message) || TRANSPORT_FAILURE;

    const button = (label, onClick, className = '') => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = `panel-button ${className}`;
        element.textContent = label;
        element.addEventListener('click', onClick);
        return element;
    };

    const stateCard = (title, detail, options = {}) => {
        const actions = options.actions || (options.action ? [options.action] : []);
        const ownedFocus = state.contains(document.activeElement) || results.contains(document.activeElement);
        results.hidden = true;
        // Progress ticks change readings, never the Cancel control under the
        // keyboard or pointer. Reservations use real copy and remain unpainted.
        if (options.loading && progressCard?.card.isConnected
            && actions.length === progressCard.actions.length
            && actions.every((action, index) => action.onClick === progressCard.actions[index].onClick)) {
            progressCard.title.textContent = title;
            progressCard.detail.set(detail);
            progressCard.controls.forEach((control, index) => {
                control.setAttribute('aria-disabled', String(!!actions[index].pending));
                control.setAttribute('aria-busy', String(!!actions[index].pending));
            });
            return;
        }
        clear(state);
        progressCard = null;
        const card = document.createElement('div');
        card.className = `state-card ${options.kind || ''}`;
        const heading = document.createElement('div');
        heading.className = 'state-title';
        if (options.loading) {
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            spinner.setAttribute('aria-hidden', 'true');
            heading.append(spinner);
        }
        const titleNode = document.createTextNode(title);
        heading.append(titleNode);
        const paragraph = document.createElement('p');
        paragraph.className = 'state-detail';
        paragraph.textContent = detail;
        card.append(heading, paragraph);
        const controls = actions.map(action => {
            const control = button(action.label, event => {
                if (control.getAttribute('aria-disabled') !== 'true') action.onClick(event);
            }, action.primary ? 'primary' : 'secondary');
            control.setAttribute('aria-disabled', String(!!action.pending));
            control.setAttribute('aria-busy', String(!!action.pending));
            card.append(control);
            return control;
        });
        state.append(card);
        if (options.loading) {
            const detailText = createStableText(paragraph);
            detailText.reserve([
                detail,
                ...['validating-activity', 'waiting-provider', 'verifying-ownership', 'checking-peakbagger',
                    'exporting-gpx', 'processing-track', 'preparing-results', 'searching-summits'].map(phase => phaseText({ phase })[1]),
                'Removing this in-progress capture from the extension.',
            ]);
            progressCard = { card, title: titleNode, detail: detailText, actions, controls };
        }
        if (ownedFocus) controls[0]?.focus({ preventScroll: true });
    };

    const retry = () => beginCapture(true);
    const openPeakbagger = async () => {
        if (Number.isInteger(currentJob?.error?.recoveryTabId)) {
            try {
                const focused = await ext.runtime.sendMessage({
                    type: 'CAPTURE_FOCUS_RECOVERY',
                    tabId: activeTab.id,
                });
                if (focused?.ok) return;
            } catch { /* fall through to a new canonical first-party tab */ }
        }
        await ext.tabs.create({ url: `${PEAKBAGGER_ORIGIN}/Default.aspx` });
    };
    const openSettings = () => {
        try { void ext.runtime.openOptionsPage(); } catch { /* unavailable in a broken extension context */ }
    };
    const providerName = () => currentJob?.provider === 'garmin' ? 'Garmin' : 'Strava';
    const focusProvider = () => ext.tabs.update(activeTab.id, { active: true });
    const reloadProvider = async () => {
        await ext.tabs.reload(activeTab.id);
    };
    const reopenProvider = () => {
        const activityId = String(currentJob?.activityId || '');
        if (!/^\d+$/.test(activityId)) return;
        const url = currentJob?.provider === 'garmin'
            ? `https://connect.garmin.com/app/activity/${activityId}`
            : currentJob?.provider === 'strava'
                ? `https://www.strava.com/activities/${activityId}` : null;
        if (url) return ext.tabs.create({
            url,
            ...(Number.isInteger(activeTab.windowId) ? { windowId: activeTab.windowId } : {}),
            ...(Number.isInteger(activeTab.index) ? { index: activeTab.index + 1 } : {}),
        });
    };
    const openProviderSignIn = () => ext.tabs.create({
        url: currentJob?.provider === 'garmin'
            ? 'https://connect.garmin.com/signin/'
            : 'https://www.strava.com/login'
    });
    const actionForRecovery = recovery => ({
        retry: { label: 'Try again', primary: true, onClick: retry },
        'check-again': { label: 'Check again', primary: true, onClick: retry },
        settings: { label: 'Settings', onClick: openSettings },
        'focus-provider': { label: `Return to ${providerName()}`, primary: true, onClick: focusProvider },
        'reload-provider': { label: 'Reload activity', primary: true, onClick: reloadProvider },
        'reopen-provider': { label: 'Reopen activity', primary: true, onClick: reopenProvider },
        'provider-sign-in': { label: `Open ${providerName()} sign in`, primary: true, onClick: openProviderSignIn },
        'open-peakbagger': { label: 'Open Peakbagger', primary: true, onClick: openPeakbagger },
    }[recovery] || null);
    const dynamicErrorMessages = new Set([
        'gpx-too-large',
        'track-too-large',
        'capture-analysis-too-large',
        'peak-response-too-large',
        'too-many-waypoints',
        'invalid-track',
    ]);
    const errorState = error => {
        const code = error?.code || 'capture-failed';
        if (code === 'garmin-inbox-activity') {
            stateCard('Activity already imported', error.message, { action: { label: 'Open activity inbox', primary: true,
                onClick: () => document.getElementById('activity-inbox')?.click() } });
            return;
        }
        const policy = captureErrorPolicy(code);
        const action = actionForRecovery(policy.recovery);
        let detail = dynamicErrorMessages.has(code) && error?.message
            ? error.message
            : policy.message;
        let title = policy.title;
        if (code === 'provider-rate-limited' || code === 'rate-limit') {
            const service = code === 'rate-limit' ? 'Peakbagger' : currentJob?.provider === 'garmin'
                ? 'Garmin' : currentJob?.provider === 'strava' ? 'Strava' : 'Activity provider';
            title = `${service} request limit reached`;
            detail = rateLimitMessage(service, error?.retryAt).slice(`${title}. `.length)
                + ' Select Better Peakbagger again to retry.';
        }
        stateCard(
            title,
            detail,
            {
                kind: code === 'unsupported' ? 'empty'
                    : policy.recovery === 'none' ? 'locked' : 'error',
                actions: action ? [action] : [],
            }
        );
    };

    const phaseText = job => {
        if (job.phase === 'searching-summits') {
            const completed = Number(job.progress?.completed);
            const total = Number(job.progress?.total);
            const bounded = Number.isInteger(completed) && Number.isInteger(total)
                && total > 0 && completed >= 0 && completed <= total;
            return [
                'Searching summit areas…',
                bounded
                    ? `${completed} of ${total} areas checked.`
                    : 'Comparing the route with nearby Peakbagger summits.',
            ];
        }
        return ({
            'validating-activity': ['Checking this activity…', 'Confirming the active tab is a supported activity.'],
            'waiting-provider': ['Waiting for the activity…', 'Loading the provider page needed to verify this activity.'],
            'verifying-ownership': ['Verifying ownership…', 'Confirming the signed-in provider account matches the activity author.'],
            'checking-peakbagger': ['Checking Peakbagger…', 'Verifying your Peakbagger session before accessing any GPS coordinates.'],
            'exporting-gpx': ['Getting the GPS track…', 'Requesting this activity’s route from the signed-in provider page.'],
            'processing-track': ['Processing the track…', 'Keeping only route fields needed to detect ascents.'],
            'preparing-results': ['Preparing detected ascents…', 'Matching the route and preparing a private review list.'],
            // Old non-terminal jobs can survive a service-worker update. Keep
            // their cards understandable until cleanup expires them.
            starting: ['Starting capture…', 'Checking the active activity page.'],
            'checking-ownership': ['Verifying ownership…', 'Confirming the signed-in provider account matches the activity author.'],
            analyzing: ['Processing the track…', 'Keeping only route fields needed to detect ascents.'],
            'finding-peaks': ['Searching summit areas…', 'Comparing the route with nearby Peakbagger summits.'],
        }[job.phase] || ['Working…', 'Preparing detected ascent drafts.']);
    };

    const cancelCapture = async () => {
        if (cancelling) return;
        cancelling = true;
        const revision = replaceOperation();
        stateCard('Cancelling capture…', 'Removing this in-progress capture from the extension.', {
            loading: true, action: { label: 'Cancel', onClick: cancelCapture, pending: true }
        });
        try {
            const response = await ext.runtime.sendMessage({ type: 'CAPTURE_CANCEL', tabId: activeTab.id });
            if (revision !== captureRevision) return;
            if (!response?.ok) {
                if (response?.job) { render(response.job); void poll(revision); return; }
                throw reportedFailure('The capture could not be cancelled.');
            }
            currentJob = null;
            stateCard(
                'Capture cancelled',
                'No track data from this capture was kept.',
                { action: { label: 'Start again', primary: true, onClick: () => beginCapture(true) } }
            );
        } catch (error) {
            if (revision !== captureRevision) return;
            stateCard('Couldn’t cancel capture', publicMessage(error), {
                kind: 'error', action: { label: 'Try again', onClick: cancelCapture }
            });
        } finally { cancelling = false; }
    };

    const evidenceText = match => {
        const parts = [`${Units.formatApproach(match.evidence.distanceM, displayUnits.distance)} from summit`];
        if (Number.isFinite(match.evidence.elevationDeltaM)) {
            parts.push(`${Units.formatElevation(match.evidence.elevationDeltaM, displayUnits.elevation)} elevation difference`);
        }
        if (Number.isFinite(match.evidence.trackQuality)) parts.push(`${Math.round(match.evidence.trackQuality * 100)}% track quality`);
        if (match.evidence.ambiguous) parts.push('nearby summit ambiguity');
        return parts.join(' · ');
    };

    const selectedIds = () => [...list.querySelectorAll('input:checked')].map(input => Number(input.value));
    const setResultActionPending = pending => {
        resultActionPending = pending;
        const locked = pending || currentJob?.phase !== 'ready';
        list.querySelectorAll('input').forEach(input => {
            input.disabled = locked;
            input.closest('.peak-row').classList.toggle('selection-locked', locked);
        });
        includeTimestampsOnce.disabled = locked;
        clearCaptureButton.setAttribute('aria-disabled', String(pending));
    };
    const refreshSelection = () => {
        if (resultActionPending) return;
        const count = selectedIds().length;
        selectionCount.textContent = `${count} selected`;
        if (currentJob?.phase === 'opening') {
            selectionLockHint.hidden = false;
            openButton.textContent = 'Opening drafts…';
            includeTimestampsOnce.disabled = true;
            openButton.setAttribute('aria-disabled', 'true');
            return;
        }
        if (currentJob?.phase === 'opened' || currentJob?.phase === 'previewed') {
            selectionLockHint.hidden = false;
            openButton.textContent = 'Show opened drafts';
            openButton.setAttribute('aria-disabled', 'false');
            return;
        }
        selectionLockHint.hidden = true;
        openButton.textContent = count === 1 ? 'Open 1 draft' : `Open ${count} drafts`;
        openButton.disabled = count === 0;
        openButton.setAttribute('aria-disabled', String(count === 0 || resultActionPending));
        currentJob.selectedIds = selectedIds();
        void ext.runtime.sendMessage({ type: 'CAPTURE_SELECTION', tabId: activeTab.id, selectedIds: selectedIds() });
    };

    const renderResults = job => {
        const ownedProgressFocus = state.contains(document.activeElement);
        currentJob = job;
        clear(state);
        clear(list);
        results.hidden = false;
        timestampChoice.hidden = !job.timestampChoiceAvailable;
        includeTimestampsOnce.checked = job.includeTimestampsOnce === true;
        includeTimestampsOnce.disabled = job.phase !== 'ready';
        privacyText.set(job.timestampsRemoved ? timelessPrivacy : timedPrivacy);
        // Reset the note; the open handler re-states it for the job it just opened.
        openNote.hidden = true;
        openNote.textContent = '';
        const track = job.trackSummary;
        clear(summary);
        clearCaptureButton.hidden = !job.hasCachedGpx;
        clearCaptureButton.setAttribute('aria-disabled', 'false');
        clearCaptureButton.textContent = 'Delete captured track data';
        const counts = document.createElement('strong');
        counts.textContent = `${track.originalPointCount.toLocaleString()} → ${track.retainedPointCount.toLocaleString()} points`;
        const deviation = Units.formatApproach(track.maxDeviationM, displayUnits.distance, 1);
        summary.append(counts, document.createTextNode(` · max deviation ${deviation} · health/device metadata removed`));

        job.matches.forEach(match => {
            const row = document.createElement('label');
            row.className = `peak-row ${match.classification}`;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = String(match.id);
            checkbox.checked = (job.selectedIds || []).includes(match.id);
            checkbox.disabled = job.phase === 'opening' || job.phase === 'opened' || job.phase === 'previewed';
            if (checkbox.disabled) row.classList.add('selection-locked');
            checkbox.addEventListener('change', refreshSelection);
            const text = document.createElement('span');
            const name = document.createElement('span');
            name.className = 'peak-name';
            name.textContent = match.name;
            const evidence = document.createElement('span');
            evidence.className = 'peak-evidence';
            evidence.textContent = evidenceText(match);
            text.append(name, evidence);
            const confidence = document.createElement('span');
            confidence.className = 'confidence';
            // Activity capture never binds a peak, so this list only ever
            // holds visible matches. Resolve the name through the shared owner
            // anyway: a row whose classification changed would otherwise keep
            // reading "Probable" while saying nothing changed.
            confidence.textContent = `${matchLabel(match.classification)} · ${match.confidence}%`;
            confidence.setAttribute('aria-label', `${matchLabel(match.classification)} match · ${match.confidence}% confidence`);
            row.append(checkbox, text, confidence);
            list.append(row);
        });
        refreshSelection();
        if (ownedProgressFocus) (list.querySelector('input:not(:disabled)') || openButton).focus({ preventScroll: true });
    };

    const render = job => {
        if (!job) return;
        currentJob = job;
        providerLabel.textContent = job.provider === 'garmin'
            ? 'Garmin Connect activity'
            : job.provider === 'strava' ? 'Strava activity' : 'Capture this activity';
        const needsUnits = job.phase === 'ready' || job.phase === 'opening'
            || job.phase === 'opened' || job.phase === 'previewed';
        if (needsUnits && !displayUnitsReady) {
            pendingUnitsJob = job;
            stateCard('Preparing detected ascents…', 'Loading your display units.', { loading: true });
            return;
        }
        pendingUnitsJob = null;
        reportPopupDiagnostic(job);
        if (job.phase === 'error') return errorState(job.error);
        if (job.phase === 'no-gps') {
            stateCard(
                'No GPS track on this activity',
                job.message || 'This activity has no recorded route to capture. Manually created activities need recorded track data before a GPX can be generated.',
                { action: { label: 'Check again', primary: true, onClick: retry } }
            );
            return;
        }
        if (job.phase === 'no-matches') {
            stateCard(
                'No confident summit matches',
                'Only Strong and Probable matches are shown, and nothing met that bar for this track. Nothing was opened or uploaded.',
                { action: { label: 'Check again', primary: true, onClick: retry } }
            );
            return;
        }
        if (job.phase === 'ready' || job.phase === 'opening'
            || job.phase === 'opened' || job.phase === 'previewed') return renderResults(job);
        const [title, detail] = phaseText(job);
        stateCard(title, detail, { loading: true, action: { label: 'Cancel', onClick: cancelCapture } });
    };

    // One failed status tick usually means a torn-down MV3 worker, not a dead
    // capture — and this is exactly the in-progress window, because poll() only
    // reschedules for non-terminal phases. Retry quietly under the current card
    // before saying anything, and never render runtime-messaging internals
    // ("Could not establish connection…") as an explanation to the user.
    const POLL_FAILURE_TOLERANCE = 5;
    let pollFailures = 0;

    const poll = async (revision = captureRevision) => {
        if (!activeTab || revision !== captureRevision) return;
        try {
            const job = await ext.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: activeTab.id });
            if (revision !== captureRevision) return;
            pollFailures = 0;
            if (job) render(job);
            if ((!job && capturePending) || (job && !CapturePhases.isTerminal(job.phase))) {
                pollTimer = setTimeout(() => void poll(revision), 450);
            } else {
                pollTimer = null;
            }
        } catch (error) {
            if (revision !== captureRevision) return;
            console.warn('Better Peakbagger: capture status poll failed', error);
            if (++pollFailures < POLL_FAILURE_TOLERANCE) {
                pollTimer = setTimeout(() => void poll(revision), 450);
                return;
            }
            pollTimer = null;
            // Check again re-asks without force, so a capture that was seconds
            // from finishing is reused rather than restarted.
            stateCard(
                'Couldn’t reach the extension',
                'The capture may still be running. Check again in a moment.',
                {
                    kind: 'error',
                    action: { label: 'Check again', primary: true, onClick: () => beginCapture(false) }
                }
            );
        }
    };

    const beginCapture = force => {
        const revision = replaceOperation();
        currentJob = null;
        popupCaptureStartedAt = globalThis.BPB_CAPTURE_DIAGNOSTICS === true ? monotonicNow() : null;
        popupDiagnosticReported = false;
        capturePending = true;
        pollFailures = 0;
        stateCard('Starting capture…', 'No GPS data is accessed until account ownership is verified.', {
            loading: true, action: { label: 'Cancel', onClick: cancelCapture }
        });
        void ext.runtime.sendMessage({ type: 'CAPTURE_START', tabId: activeTab.id, force })
            .then(job => {
                if (revision !== captureRevision) return;
                capturePending = false;
                if (job) render(job);
                if (!job || CapturePhases.isTerminal(job.phase)) {
                    clearTimeout(pollTimer);
                    pollTimer = null;
                }
            })
            .catch(error => {
                if (revision !== captureRevision) return;
                // A rejection here is the messaging layer, not the capture:
                // the worker reports its own failures as a phase: 'error' job.
                console.warn('Better Peakbagger: capture start failed', error);
                capturePending = false;
                clearTimeout(pollTimer);
                pollTimer = null;
                stateCard(
                    'Couldn’t reach the extension',
                    'The capture didn’t start. Try again in a moment.',
                    {
                        kind: 'error',
                        action: { label: 'Try again', primary: true, onClick: () => beginCapture(false) }
                    }
                );
            });
        void poll(revision);
    };

    clearCaptureButton.addEventListener('click', async () => {
        if (resultActionPending || clearCaptureButton.getAttribute('aria-disabled') === 'true') return;
        setResultActionPending(true);
        const revision = replaceOperation();
        openButton.setAttribute('aria-disabled', 'true');
        clearCaptureButton.setAttribute('aria-disabled', 'true');
        clearCaptureButton.setAttribute('aria-busy', 'true');
        clearCaptureButton.textContent = 'Deleting…';
        try {
            const response = await ext.runtime.sendMessage({ type: 'CAPTURE_CLEAR', tabId: activeTab.id });
            if (revision !== captureRevision) return;
            if (!response?.ok) throw reportedFailure(response?.error?.message || 'The captured track data could not be deleted.');
            currentJob = null;
            stateCard(
                'Captured track data deleted',
                'The reduced track and any prepared draft handoffs were deleted. Existing draft tabs were left open but disconnected.',
                { action: { label: 'Capture again', primary: true, onClick: () => beginCapture(false) } }
            );
        } catch (error) {
            if (revision !== captureRevision) return;
            setResultActionPending(false);
            renderResults(currentJob);
            openNote.textContent = publicMessage(error);
            openNote.hidden = false;
        } finally {
            setResultActionPending(false);
            clearCaptureButton.setAttribute('aria-busy', 'false');
        }
    });

    settingsButton.addEventListener('click', openSettings);
    includeTimestampsOnce.addEventListener('change', () => {
        // The choice stays in this job's UI until the opening transaction freezes it.
        // No preference write: the next capture starts with the privacy default.
        if (resultActionPending || currentJob?.phase !== 'ready') return;
        currentJob.selectedIds = selectedIds();
        currentJob.includeTimestampsOnce = includeTimestampsOnce.checked;
        currentJob.timestampsRemoved = !includeTimestampsOnce.checked;
        renderResults(currentJob);
    });

    openButton.addEventListener('click', async () => {
        if (resultActionPending || openButton.disabled || openButton.getAttribute('aria-disabled') === 'true') return;
        setResultActionPending(true);
        const revision = replaceOperation();
        openButton.setAttribute('aria-disabled', 'true');
        includeTimestampsOnce.disabled = true;
        openButton.textContent = 'Opening drafts…';
        openButton.setAttribute('aria-busy', 'true');
        try {
            const response = await ext.runtime.sendMessage({
                type: 'CAPTURE_OPEN_DRAFTS',
                tabId: activeTab.id,
                selectedIds: selectedIds(),
                includeTimestampsOnce: includeTimestampsOnce.checked
            });
            if (revision !== captureRevision) return;
            if (response?.phase === 'error') throw reportedFailure(response.error?.message || 'Drafts could not be opened.');
            // Re-render from the worker's own state so the selection lock engages
            // in this turn. Patching only the label leaves a "ready" card offering
            // an open the worker would refuse — polling has already stopped.
            setResultActionPending(false);
            if (response?.job) renderResults(response.job);
            else refreshSelection();
            // Grouping is cosmetic. Say so once in the status line and keep the
            // primary button's label a label.
            if (response?.groupWarning) {
                openNote.textContent = 'Drafts opened. Your browser didn’t group the tabs.';
                openNote.hidden = false;
            }
            openButton.setAttribute('aria-disabled', 'false');
        } catch (error) {
            if (revision !== captureRevision) return;
            setResultActionPending(false);
            refreshSelection();
            includeTimestampsOnce.disabled = currentJob?.phase !== 'ready';
            openNote.textContent = publicMessage(error);
            openNote.hidden = false;
        } finally {
            setResultActionPending(false);
            openButton.setAttribute('aria-busy', 'false');
        }
    });

    // Admission does not depend on a cosmetic units read. Start as soon as the
    // active tab is known, but hold a fast result card until units resolve so
    // distances are never painted in one system and corrected in another.
    void Settings.get().catch(() => null).then(settings => {
        displayUnits = {
            distance: Units.resolveUnits(settings, null, 'distance'),
            elevation: Units.resolveUnits(settings, null, 'elevation')
        };
        displayUnitsReady = true;
        const pending = pendingUnitsJob;
        if (pending && currentJob === pending) render(pending);
    });
    void ext.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        activeTab = tabs[0];
        if (!activeTab) {
            errorState({ code: 'unsupported', message: 'No active browser tab is available.' });
            return;
        }
        // Opening the popup reads existing work only. Starting a provider read
        // belongs to the explicit Capture this activity gesture.
        void ext.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: activeTab.id }).then(job => {
            if (job?.phase) { render(job); if (!CapturePhases.isTerminal(job.phase)) pollTimer = setTimeout(() => void poll(), 450); }
            else if (activeTab.url && !providerFromUrl(activeTab.url)) errorState({ code: 'unsupported' });
            else stateCard('Prepare this activity', 'Open a Garmin or Strava activity to prepare summit drafts.', {
                action: { label: 'Capture this activity', primary: true, onClick: () => beginCapture(false) },
            });
        }).catch(() => stateCard('Couldn’t read capture status', 'Try opening the popup again.'));
    });
    const inboxButton = document.getElementById('activity-inbox');
    const inboxStatus = document.getElementById('activity-inbox-status');
    let openingInbox = false;
    inboxButton?.addEventListener('click', async () => {
        if (openingInbox) return; openingInbox = true;
        inboxButton.setAttribute('aria-disabled', 'true'); inboxButton.setAttribute('aria-busy', 'true'); inboxStatus.textContent = 'Opening your activity inbox…';
        try {
            const result = await ext.runtime.sendMessage({ type: 'GARMIN_INBOX_OPEN' });
            if (!result?.ok) throw new Error();
            window.close();
        } catch { inboxStatus.textContent = 'Couldn’t open inbox. Try again.'; }
        finally { openingInbox = false; inboxButton.removeAttribute('aria-disabled'); inboxButton.removeAttribute('aria-busy'); }
    });
    void ext.runtime.sendMessage({ type: 'GARMIN_SUMMARY' }).then(inboxSummary => {
        if (!inboxSummary?.ok || openingInbox) return;
        const count = inboxSummary.pending;
        if (!Number.isInteger(count) || count < 0) return;
        document.getElementById('inbox-count').textContent = count > 99 ? '99+' : count ? String(count) : '';
        inboxButton.setAttribute('aria-label', `Activity inbox, ${count} pending activities`);
        inboxStatus.textContent = inboxSummary.error?.code === 'key-rejected' ? 'Garmin needs a new key. Open inbox to reconnect.'
            : inboxSummary.queued > 0 ? `${inboxSummary.queued} waiting for peak checks. Open inbox to resume.`
                : !inboxSummary.configured ? 'Connect Garmin to import your activities.' : inboxSummary.manual
                    ? 'Your Garmin activities, ready when you check.' : 'Your Garmin activities, imported automatically.';
    }).catch(() => {});
})();
