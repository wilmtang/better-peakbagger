// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { capturePhases as CapturePhases } from '../src/capture/capture-phases.js';
import { captureErrorPolicy } from '../src/capture/capture-error-policy.js';
import { matchLabel } from '../src/capture/match-confidence.js';
import { PEAKBAGGER_ORIGIN } from '../src/peakbagger/peakbagger-origin.js';
import { settings as Settings } from '../src/settings/settings.js';
import { units as Units } from '../src/ui/units.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    const state = document.getElementById('state');
    const results = document.getElementById('results');
    const list = document.getElementById('peak-list');
    const summary = document.getElementById('track-summary');
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
    let displayUnits = Units.IMPERIAL;
    let displayUnitsReady = false;
    let pendingUnitsJob = null;
    let pollTimer = null;
    let capturePending = false;
    let popupCaptureStartedAt = null;
    let popupDiagnosticReported = false;

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
        element.className = className;
        element.textContent = label;
        element.addEventListener('click', onClick);
        return element;
    };

    const stateCard = (title, detail, options = {}) => {
        results.hidden = true;
        clear(state);
        const card = document.createElement('div');
        card.className = `state-card ${options.kind || ''}`;
        const heading = document.createElement('div');
        heading.className = 'state-title';
        if (options.loading) {
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            heading.append(spinner);
        }
        heading.append(document.createTextNode(title));
        const paragraph = document.createElement('p');
        paragraph.className = 'state-detail';
        paragraph.textContent = detail;
        card.append(heading, paragraph);
        const actions = options.actions || (options.action ? [options.action] : []);
        actions.forEach(action => card.append(
            button(action.label, action.onClick, action.primary ? 'primary' : 'secondary')));
        state.append(card);
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
        const policy = captureErrorPolicy(code);
        const action = actionForRecovery(policy.recovery);
        let detail = dynamicErrorMessages.has(code) && error?.message
            ? error.message
            : policy.message;
        if (policy.recovery === 'wait' && Number.isFinite(error?.retryAt)) {
            const retryTime = new Date(error.retryAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
            });
            detail = `${detail} Try again after ${retryTime}.`;
        }
        stateCard(
            policy.title,
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
        clearTimeout(pollTimer);
        pollTimer = null;
        capturePending = false;
        stateCard('Cancelling capture…', 'Removing this in-progress capture from the extension.', { loading: true });
        try {
            const response = await ext.runtime.sendMessage({ type: 'CAPTURE_CANCEL', tabId: activeTab.id });
            if (!response?.ok) {
                if (response?.job) return render(response.job);
                throw reportedFailure('The capture could not be cancelled.');
            }
            currentJob = null;
            stateCard(
                'Capture cancelled',
                'No track data from this capture was kept.',
                { action: { label: 'Start again', primary: true, onClick: () => beginCapture(true) } }
            );
        } catch (error) {
            stateCard('Couldn’t cancel capture', publicMessage(error), {
                kind: 'error', action: { label: 'Try again', onClick: cancelCapture }
            });
        }
    };

    const evidenceText = match => {
        const parts = [`${Units.formatApproach(match.evidence.distanceM, displayUnits)} from summit`];
        if (Number.isFinite(match.evidence.elevationDeltaM)) {
            parts.push(`${Units.formatElevation(match.evidence.elevationDeltaM, displayUnits)} elevation difference`);
        }
        if (Number.isFinite(match.evidence.trackQuality)) parts.push(`${Math.round(match.evidence.trackQuality * 100)}% track quality`);
        if (match.evidence.ambiguous) parts.push('nearby summit ambiguity');
        return parts.join(' · ');
    };

    const selectedIds = () => [...list.querySelectorAll('input:checked')].map(input => Number(input.value));
    const refreshSelection = () => {
        const count = selectedIds().length;
        selectionCount.textContent = `${count} selected`;
        if (currentJob?.phase === 'opening') {
            selectionLockHint.hidden = false;
            openButton.textContent = 'Opening drafts…';
            openButton.disabled = true;
            return;
        }
        if (currentJob?.phase === 'opened' || currentJob?.phase === 'previewed') {
            selectionLockHint.hidden = false;
            openButton.textContent = 'Show opened drafts';
            openButton.disabled = false;
            return;
        }
        selectionLockHint.hidden = true;
        openButton.textContent = count === 1 ? 'Open 1 draft' : `Open ${count} drafts`;
        openButton.disabled = count === 0;
        void ext.runtime.sendMessage({ type: 'CAPTURE_SELECTION', tabId: activeTab.id, selectedIds: selectedIds() });
    };

    const renderResults = job => {
        currentJob = job;
        clear(state);
        clear(list);
        results.hidden = false;
        // Reset the note; the open handler re-states it for the job it just opened.
        openNote.hidden = true;
        openNote.textContent = '';
        const track = job.trackSummary;
        clear(summary);
        clearCaptureButton.hidden = !job.hasCachedGpx;
        clearCaptureButton.disabled = false;
        clearCaptureButton.textContent = 'Delete captured track data';
        const counts = document.createElement('strong');
        counts.textContent = `${track.originalPointCount.toLocaleString()} → ${track.retainedPointCount.toLocaleString()} points`;
        const deviation = Units.formatElevation(track.maxDeviationM, displayUnits, 1);
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
            confidence.textContent = `${matchLabel(match.classification)} match · ${match.confidence}% confidence`;
            row.append(checkbox, text, confidence);
            list.append(row);
        });
        refreshSelection();
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

    const poll = async () => {
        if (!activeTab) return;
        try {
            const job = await ext.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: activeTab.id });
            pollFailures = 0;
            if (job) render(job);
            if ((!job && capturePending) || (job && !CapturePhases.isTerminal(job.phase))) {
                pollTimer = setTimeout(poll, 450);
            } else {
                pollTimer = null;
            }
        } catch (error) {
            console.warn('Better Peakbagger: capture status poll failed', error);
            if (++pollFailures < POLL_FAILURE_TOLERANCE) {
                pollTimer = setTimeout(poll, 450);
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
        clearTimeout(pollTimer);
        popupCaptureStartedAt = globalThis.BPB_CAPTURE_DIAGNOSTICS === true ? monotonicNow() : null;
        popupDiagnosticReported = false;
        capturePending = true;
        pollFailures = 0;
        stateCard('Starting capture…', 'No GPS data is accessed until account ownership is verified.', {
            loading: true, action: { label: 'Cancel', onClick: cancelCapture }
        });
        void ext.runtime.sendMessage({ type: 'CAPTURE_START', tabId: activeTab.id, force })
            .then(job => {
                capturePending = false;
                if (job) render(job);
                if (!job || CapturePhases.isTerminal(job.phase)) {
                    clearTimeout(pollTimer);
                    pollTimer = null;
                }
            })
            .catch(error => {
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
        void poll();
    };

    clearCaptureButton.addEventListener('click', async () => {
        clearTimeout(pollTimer);
        openButton.disabled = true;
        clearCaptureButton.disabled = true;
        clearCaptureButton.textContent = 'Deleting…';
        try {
            const response = await ext.runtime.sendMessage({ type: 'CAPTURE_CLEAR', tabId: activeTab.id });
            if (!response?.ok) throw reportedFailure(response?.error?.message || 'The captured track data could not be deleted.');
            currentJob = null;
            stateCard(
                'Captured track data deleted',
                'The reduced track and any prepared draft handoffs were deleted. Existing draft tabs were left open but disconnected.',
                { action: { label: 'Capture again', primary: true, onClick: () => beginCapture(false) } }
            );
        } catch (error) {
            stateCard('Couldn’t delete captured track data', publicMessage(error), {
                kind: 'error',
                action: { label: 'Back to results', onClick: () => renderResults(currentJob) }
            });
        }
    });

    settingsButton.addEventListener('click', openSettings);

    openButton.addEventListener('click', async () => {
        openButton.disabled = true;
        openButton.textContent = 'Opening drafts…';
        try {
            const response = await ext.runtime.sendMessage({
                type: 'CAPTURE_OPEN_DRAFTS',
                tabId: activeTab.id,
                selectedIds: selectedIds()
            });
            if (response?.phase === 'error') throw reportedFailure(response.error?.message || 'Drafts could not be opened.');
            // Re-render from the worker's own state so the selection lock engages
            // in this turn. Patching only the label leaves a "ready" card offering
            // an open the worker would refuse — polling has already stopped.
            if (response?.job) renderResults(response.job);
            else refreshSelection();
            // Grouping is cosmetic. Say so once in the status line and keep the
            // primary button's label a label.
            if (response?.groupWarning) {
                openNote.textContent = 'Drafts opened. Your browser didn’t group the tabs.';
                openNote.hidden = false;
            }
            openButton.disabled = false;
        } catch (error) {
            refreshSelection();
            stateCard('Draft opening stopped', publicMessage(error), { kind: 'error', action: { label: 'Back to results', onClick: () => renderResults(currentJob) } });
        }
    });

    // Admission does not depend on a cosmetic units read. Start as soon as the
    // active tab is known, but hold a fast result card until units resolve so
    // distances are never painted in one system and corrected in another.
    void Settings.get().catch(() => null).then(settings => {
        displayUnits = Units.resolveUnits(settings);
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
        beginCapture(false);
    });
})();
