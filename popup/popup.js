// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

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
    const providerLabel = document.getElementById('provider-label');
    const settingsButton = document.getElementById('open-settings');
    let activeTab = null;
    let currentJob = null;
    let pollTimer = null;
    let capturePending = false;
    const TERMINAL_PHASES = new Set(['ready', 'no-matches', 'no-gps', 'error', 'opened', 'previewed']);

    const clear = element => { while (element.firstChild) element.firstChild.remove(); };

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
        actions.forEach(action => card.append(button(action.label, action.onClick, action.primary ? 'primary' : '')));
        state.append(card);
    };

    const retry = () => beginCapture(true);
    const openSettings = () => {
        try { void ext.runtime.openOptionsPage(); } catch { /* unavailable in a broken extension context */ }
    };
    const errorState = error => {
        const code = error?.code || 'capture-failed';
        const signedOut = code === 'peakbagger-signed-out';
        const providerSignedOut = code === 'provider-signed-out';
        const notOwner = code === 'not-owner';
        if (code === 'unsupported') {
            stateCard(
                'Open an activity to begin',
                'Open a Garmin Connect or Strava activity, then select Better Peakbagger again.',
                { kind: 'empty', action: { label: 'Settings', onClick: openSettings } }
            );
            return;
        }
        stateCard(
            notOwner ? 'This activity isn’t yours' : signedOut ? 'Check your Peakbagger session' : 'Capture stopped',
            error?.message || 'The activity could not be captured.',
            {
                kind: notOwner ? 'locked' : 'error',
                actions: signedOut
                    ? [
                        { label: 'Open Peakbagger', onClick: () => ext.tabs.create({ url: 'https://peakbagger.com/Default.aspx' }) },
                        { label: 'I’m signed in — try again', onClick: retry }
                    ]
                    : providerSignedOut
                        ? [
                            {
                                label: `Open ${currentJob?.provider === 'garmin' ? 'Garmin' : 'Strava'} sign in`,
                                onClick: () => ext.tabs.create({
                                    url: currentJob?.provider === 'garmin'
                                        ? 'https://connect.garmin.com/signin/'
                                        : 'https://www.strava.com/login'
                                })
                            },
                            { label: 'I’m signed in — try again', onClick: retry }
                        ]
                    : (code === 'unsupported' || notOwner ? [] : [{ label: 'Try again', onClick: retry }])
            }
        );
    };

    const phaseText = phase => ({
        starting: ['Starting capture…', 'Checking the active activity page.'],
        'checking-peakbagger': ['Checking Peakbagger…', 'Verifying your Peakbagger session before accessing any GPS coordinates.'],
        'checking-ownership': ['Verifying ownership…', 'Confirming the signed-in provider account matches the activity author.'],
        analyzing: ['Reading the track…', 'Keeping only coordinates, elevation, time, and segment boundaries in memory.'],
        'finding-peaks': ['Detecting summits…', 'Comparing the full-resolution path with nearby Peakbagger summits.']
    }[phase] || ['Working…', 'Preparing detected ascent drafts.']);

    const evidenceText = match => {
        const parts = [`${Math.round(match.evidence.distanceM)} m from summit`];
        if (Number.isFinite(match.evidence.elevationDeltaM)) parts.push(`${Math.round(match.evidence.elevationDeltaM)} m elevation difference`);
        if (Number.isFinite(match.evidence.trackQuality)) parts.push(`${Math.round(match.evidence.trackQuality * 100)}% track quality`);
        if (match.evidence.ambiguous) parts.push('nearby summit ambiguity');
        return parts.join(' · ');
    };

    const selectedIds = () => [...list.querySelectorAll('input:checked')].map(input => Number(input.value));
    const refreshSelection = () => {
        const count = selectedIds().length;
        selectionCount.textContent = `${count} selected`;
        openButton.textContent = count === 1 ? 'Open 1 draft' : `Open ${count} drafts`;
        openButton.disabled = count === 0;
        void ext.runtime.sendMessage({ type: 'CAPTURE_SELECTION', tabId: activeTab.id, selectedIds: selectedIds() });
    };

    const renderResults = job => {
        currentJob = job;
        clear(state);
        clear(list);
        results.hidden = false;
        const track = job.trackSummary;
        clear(summary);
        clearCaptureButton.hidden = !job.hasCachedGpx;
        clearCaptureButton.disabled = false;
        clearCaptureButton.textContent = 'Delete captured track data';
        const counts = document.createElement('strong');
        counts.textContent = `${track.originalPointCount.toLocaleString()} → ${track.retainedPointCount.toLocaleString()} points`;
        summary.append(counts, document.createTextNode(` · max deviation ${track.maxDeviationM.toFixed(1)} m · health/device metadata removed`));

        job.matches.forEach(match => {
            const row = document.createElement('label');
            row.className = `peak-row ${match.classification}`;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = String(match.id);
            checkbox.checked = (job.selectedIds || []).includes(match.id);
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
            confidence.textContent = `${match.classification === 'strong' ? 'Strong' : 'Probable'} match · ${match.confidence}% confidence`;
            row.append(checkbox, text, confidence);
            list.append(row);
        });
        refreshSelection();
        if (job.phase === 'opened' || job.phase === 'previewed') {
            openButton.textContent = job.phase === 'previewed' ? 'Preview submitted' : 'Drafts opened';
            openButton.disabled = true;
        }
    };

    const render = job => {
        if (!job) return;
        currentJob = job;
        providerLabel.textContent = job.provider === 'garmin'
            ? 'Garmin Connect activity'
            : job.provider === 'strava' ? 'Strava activity' : 'Capture this activity';
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
            stateCard('No confident summit matches', 'Possible and weak results are intentionally hidden. Nothing was opened or uploaded.');
            return;
        }
        if (job.phase === 'ready' || job.phase === 'opened' || job.phase === 'previewed') return renderResults(job);
        const [title, detail] = phaseText(job.phase);
        stateCard(title, detail, { loading: true });
    };

    const poll = async () => {
        if (!activeTab) return;
        try {
            const job = await ext.runtime.sendMessage({ type: 'CAPTURE_STATUS', tabId: activeTab.id });
            if (job) render(job);
            if ((!job && capturePending) || (job && !TERMINAL_PHASES.has(job.phase))) {
                pollTimer = setTimeout(poll, 450);
            } else {
                pollTimer = null;
            }
        } catch (error) {
            errorState({ message: error.message });
        }
    };

    const beginCapture = force => {
        clearTimeout(pollTimer);
        capturePending = true;
        stateCard('Starting capture…', 'No GPS data is accessed until account ownership is verified.', { loading: true });
        void ext.runtime.sendMessage({ type: 'CAPTURE_START', tabId: activeTab.id, force })
            .then(job => {
                capturePending = false;
                if (job) render(job);
                if (!job || TERMINAL_PHASES.has(job.phase)) {
                    clearTimeout(pollTimer);
                    pollTimer = null;
                }
            })
            .catch(error => {
                capturePending = false;
                clearTimeout(pollTimer);
                pollTimer = null;
                errorState({ message: error.message });
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
            if (!response?.ok) throw new Error(response?.error?.message || 'The captured track data could not be deleted.');
            currentJob = null;
            stateCard(
                'Captured track data deleted',
                'The reduced track and any prepared draft handoffs were deleted. Existing draft tabs were left open but disconnected.',
                { action: { label: 'Capture again', primary: true, onClick: () => beginCapture(false) } }
            );
        } catch (error) {
            stateCard('Couldn’t delete captured track data', error.message, {
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
            if (response?.phase === 'error') throw new Error(response.error?.message || 'Drafts could not be opened.');
            openButton.textContent = response?.groupWarning ? 'Drafts opened without group' : 'Drafts opened';
        } catch (error) {
            openButton.disabled = false;
            openButton.textContent = `Open ${selectedIds().length} drafts`;
            stateCard('Draft opening stopped', error.message, { kind: 'error', action: { label: 'Back to results', onClick: () => renderResults(currentJob) } });
        }
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
