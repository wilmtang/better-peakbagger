// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Saved-ascent GPX handoffs to mapping services. The exact Peakbagger download
// is read only after a trusted provider click. Each destination's visible
// preview and final confirmation remain the user's review gate.

import { settings as S } from '../settings/settings.js';
import { ascentPage as AscentPage } from './ascent-page.js';
import { savedGpxSource as GpxSource } from '../gpx/saved-gpx-source.js';
import { MAX_CALTOPO_GPX_BYTES } from '../caltopo/caltopo-import.js';
import { MAX_ALLTRAILS_GPX_BYTES } from '../alltrails/alltrails-import.js';
import { MAX_GAIA_GPX_BYTES } from '../gaia/gaia-import.js';
import { MAX_ONX_GPX_BYTES, ONX_EXPORT_BUDGET_MS } from '../onx/onx-import.js';
import { dom as Dom } from '../ui/dom.js';
import { pageLifecycle as PageLifecycle } from '../ui/page-lifecycle.js';
import { runtimeMessage as RuntimeMessage } from '../ui/runtime-message.js';
import { trustedAction as TrustedAction } from '../ui/trusted-action.js';
import { createStableText } from '../ui/stable-text.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext?.runtime) return;

    const el = Dom.element;
    const sendBg = RuntimeMessage.bindResult(ext);
    const info = AscentPage.read({ doc: document, search: location.search });
    const trackLink = AscentPage.gpxLink(document);
    if (!info.gpxUrl || !trackLink || !GpxSource.storedTrackLink(info.gpxUrl, GpxSource.ascentIdentity(location.href))) {
        return;
    }

    const statusId = `bpb-map-handoff-status-${info.ascentId}`;
    const status = el('span', {
        id: statusId,
        class: 'bpb-map-handoff-status',
        role: 'status',
        'aria-live': 'polite',
    });
    const statusText = createStableText(status);
    statusText.reserve([
        'Reading the saved GPX…', 'Opening onX…', 'Waiting for onX…', 'Preparing onX’s preview…',
        'Open onX and sign in if prompted, then continue the export.',
        'Check onX before sending again. The file may already be there.',
        'Ready in onX. Review the file and click Import.',
    ]);
    const openOnx = el('button', { type: 'button', class: 'bpb-onx-open', text: 'Open onX', hidden: true });
    const openSlot = el('span', { class: 'bpb-onx-open-slot' }, [
        el('span', { class: 'bpb-onx-open-sizing', 'aria-hidden': 'true', text: 'Check onX' }), openOnx,
    ]);
    const feedback = el('span', { class: 'bpb-map-handoff-feedback' }, [status, openSlot]);
    const providerConfig = [
        {
            id: 'gaia',
            name: 'Gaia',
            buttonLabel: 'Send to Gaia',
            ariaLabel: 'Send saved GPX to Gaia GPS',
            permissionType: 'GAIA_PERMISSION_REQUEST',
            prepareType: 'GAIA_IMPORT_PREPARE',
            action: 'gaia-import',
            maxBytes: MAX_GAIA_GPX_BYTES,
        },
        {
            id: 'onx',
            name: 'onX',
            buttonLabel: 'Send to onX',
            ariaLabel: 'Send saved GPX to onX Backcountry',
            permissionType: 'ONX_PERMISSION_REQUEST',
            prepareType: 'ONX_IMPORT_PREPARE',
            action: 'onx-import',
            maxBytes: MAX_ONX_GPX_BYTES,
        },
        {
            id: 'alltrails',
            name: 'AllTrails',
            buttonLabel: 'Send to AllTrails',
            ariaLabel: 'Send saved GPX to AllTrails',
            permissionType: 'ALLTRAILS_PERMISSION_REQUEST',
            prepareType: 'ALLTRAILS_IMPORT_PREPARE',
            action: 'alltrails-import',
            maxBytes: MAX_ALLTRAILS_GPX_BYTES,
        },
        {
            id: 'caltopo',
            name: 'CalTopo',
            buttonLabel: 'Send to CalTopo',
            ariaLabel: 'Send saved GPX to CalTopo',
            permissionType: 'CALTOPO_PERMISSION_REQUEST',
            prepareType: 'CALTOPO_IMPORT_PREPARE',
            action: 'caltopo-import',
            maxBytes: MAX_CALTOPO_GPX_BYTES,
        },
    ];
    const providers = new Map(providerConfig.map(config => {
        const labelElement = el('span', { class: 'bpb-map-handoff-label-text', text: config.buttonLabel });
        const button = el('button', {
            type: 'button',
            class: `bpb-map-handoff-button bpb-map-handoff-button-${config.id}`,
            'data-provider': config.id,
            'aria-label': config.ariaLabel,
        }, [
            el('span', { class: 'bpb-map-handoff-icon', 'aria-hidden': 'true' }),
            el('span', { class: 'bpb-map-handoff-label', 'data-label': `Send to ${config.name} again` }, [labelElement]),
        ]);
        return [config.id, { ...config, button, labelElement, targetTabId: null, repeat: false }];
    }));
    const buttons = el('span', { class: 'bpb-map-handoff-buttons' },
        [...providers.values()].map(provider => provider.button));
    const control = el('span', {
        class: 'bpb-map-handoff-control',
        role: 'group',
        'aria-label': 'Send saved GPX to a map',
    }, [buttons, feedback]);

    let generation = 0;
    let activeProvider = null;
    let placementObserver = null;
    let onxWork = null;
    let onxLastAttempt = null;
    let onxResumeAttempt = null;

    let preferences = S.clean();
    const updateButtons = () => {
        for (const [index, id] of preferences.mapProviderOrder.entries()) {
            const button = providers.get(id).button;
            if (buttons.children[index] !== button) buttons.insertBefore(button, buttons.children[index] || null);
        }
        control.hidden = preferences.mapProvidersEnabled.length === 0 && !activeProvider && !status.textContent;
        for (const provider of providers.values()) {
            provider.button.hidden = !preferences.mapProvidersEnabled.includes(provider.id) && activeProvider !== provider.id;
            provider.button.setAttribute('aria-disabled', String(!!activeProvider));
            provider.button.setAttribute('aria-busy', String(activeProvider === provider.id));
        }
    };
    const render = (provider, {
        buttonText = provider.buttonLabel,
        message = '',
        success = false,
        repeat = false,
    }) => {
        provider.labelElement.textContent = buttonText;
        provider.button.classList.toggle('bpb-map-handoff-button-success', success);
        provider.button.setAttribute('aria-label', repeat ? `${provider.ariaLabel} again` : provider.ariaLabel);
        provider.repeat = repeat;
        for (const item of providers.values()) item.button.removeAttribute('aria-describedby');
        if (message) provider.button.setAttribute('aria-describedby', statusId);
        statusText.set(message);
        updateButtons();
    };

    const cancelOnx = () => {
        const work = onxWork;
        if (!work) {
            if (activeProvider === 'onx') {
                generation++;
                activeProvider = null;
                render(providers.get('onx'), { message: 'Transfer stopped. No GPX was sent.' });
            }
            return;
        }
        work.controller.abort();
        work.deadline.abort();
        work.reject?.(new Error('cancelled'));
        work.deadline.clear();
        clearTimeout(work.pollTimer);
        if (work.sent) void sendBg({ type: 'ONX_IMPORT_CANCEL', attemptId: work.id });
        onxWork = null;
        generation++;
        activeProvider = null;
        onxResumeAttempt = null;
        render(providers.get('onx'), { buttonText: 'Send to onX again', repeat: true,
            message: work.sent ? 'Check onX before sending again. The file may already be there.' : 'Transfer stopped. No GPX was sent.' });
    };
    openOnx.addEventListener('click', async event => {
        if (!event.isTrusted || !onxLastAttempt) return;
        const attemptId = onxLastAttempt;
        const activation = await TrustedAction.issue(ext, event, 'onx-import', generation);
        if (activation && attemptId === onxLastAttempt) void sendBg({
            type: 'ONX_IMPORT_OPEN', attemptId, activationToken: activation.token, generation: String(generation),
        });
    });
    const runOnx = async (provider, event) => {
        activeProvider = 'onx';
        const epoch = ++generation;
        openOnx.hidden = true;
        render(provider, { buttonText: 'Preparing…', message: 'Waiting for onX permission…' });
        // The permission request remains the first awaited extension call.
        const permission = await sendBg({ type: provider.permissionType });
        if (epoch !== generation) return;
        if (permission.kind !== 'response' || !permission.value?.ok) {
            activeProvider = null;
            render(provider, { message: permission.value?.message || 'onX access could not be requested. Try again.' });
            return;
        }
        const startedAt = Date.now();
        const expiresAt = startedAt + ONX_EXPORT_BUDGET_MS;
        const work = { id: crypto.randomUUID(), controller: new AbortController(), sent: false,
            deadline: Deadline.createRequestDeadline(ONX_EXPORT_BUDGET_MS), pollTimer: null, targetTabId: null };
        onxWork = work;
        const current = () => epoch === generation && onxWork === work;
        let workflow = null;
        let phase = 'setup';
        const cancellation = new Promise((_, reject) => { work.reject = reject; });
        const wait = async promise => {
            const value = await work.deadline.run(Promise.race([promise, cancellation]));
            if (!current() || Date.now() >= expiresAt) throw new Error('deadline');
            return value;
        };
        const showOpen = () => {
            if (!current() || !work.targetTabId || Date.now() - startedAt < 3000) return;
            openOnx.textContent = 'Open onX';
            openOnx.hidden = false;
        };
        const poll = async () => {
            if (!current() || Date.now() >= expiresAt) return;
            const response = await sendBg({ type: 'ONX_IMPORT_STATUS', attemptId: work.id });
            if (!current() || Date.now() >= expiresAt) return;
            const value = response.value;
            if (value?.attemptId === work.id && value.code === 'pending') {
                work.targetTabId = value.targetTabId;
                const messages = { opening: 'Opening onX…', preflight: 'Waiting for onX…', dispatching: 'Preparing onX’s preview…' };
                render(provider, { buttonText: 'Opening onX…', message: messages[value.phase] || 'Waiting for onX…' });
                showOpen();
            }
            work.pollTimer = setTimeout(poll, 200);
        };
        try {
            const beginning = TrustedAction.begin(ext, event, provider.action, epoch);
            beginning.then(value => { if (!current() && value) void TrustedAction.end(ext, value, epoch); });
            workflow = await wait(beginning);
            if (!workflow) throw new Error('setup');
            phase = 'source';
            render(provider, { buttonText: 'Preparing…', message: 'Reading the saved GPX…' });
            const source = await wait(GpxSource.readSourceGpx({ pageUrl: location.href, gpxUrl: info.gpxUrl,
                maxBytes: provider.maxBytes, signal: work.deadline.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) }));
            if (!source.ok) {
                activeProvider = null;
                render(provider, { message: source.message });
                return;
            }
            phase = 'onx';
            onxLastAttempt = work.id;
            render(provider, { buttonText: 'Opening onX…', message: 'Opening onX…' });
            work.sent = true;
            const request = sendBg({ type: provider.prepareType, ...source, attemptId: work.id, expiresAt,
                grantToken: workflow.grantToken, generation: String(epoch),
                ...(onxResumeAttempt ? { resumeAttemptId: onxResumeAttempt } : {}) });
            onxResumeAttempt = null;
            void poll();
            const response = await wait(request);
            const result = response.kind === 'response' && response.value?.attemptId === work.id ? response.value : {
                ok: false, supplied: true, message: 'Check onX before sending again. The file may already be there.' };
            activeProvider = null;
            work.targetTabId = result.targetTabId || work.targetTabId;
            onxResumeAttempt = result.canContinue === true ? work.id : null;
            render(provider, { buttonText: result.ok || result.supplied ? 'Send to onX again'
                : onxResumeAttempt ? 'Continue export' : provider.buttonLabel,
            message: result.message || 'The transfer could not start. Try again.', success: result.ok,
            repeat: result.ok || result.supplied });
            provider.button.setAttribute('aria-label', onxResumeAttempt ? 'Continue saved GPX export to onX' : provider.button.getAttribute('aria-label'));
            openOnx.textContent = result.supplied && !result.ok ? 'Check onX' : 'Open onX';
            openOnx.hidden = !work.targetTabId;
        } catch {
            if (!current()) return;
            activeProvider = null;
            if (work.sent) void sendBg({ type: 'ONX_IMPORT_CANCEL', attemptId: work.id });
            render(provider, { buttonText: work.sent ? 'Send to onX again' : provider.buttonLabel, repeat: work.sent,
                message: phase === 'source' ? 'Reading the saved GPX took too long. Try again.'
                    : phase === 'setup' ? 'The transfer could not start. Try again.'
                        : 'Check onX before sending again. The file may already be there.' });
            openOnx.textContent = 'Check onX';
            openOnx.hidden = !work.targetTabId;
        } finally {
            work.deadline.clear();
            clearTimeout(work.pollTimer);
            if (onxWork === work) onxWork = null;
            if (workflow) void TrustedAction.end(ext, workflow, epoch);
        }
    };

    const run = async (provider, event) => {
        if (event?.isTrusted !== true || activeProvider || !preferences.mapProvidersEnabled.includes(provider.id)) return;
        if (provider.id === 'onx') return runOnx(provider, event);
        // A possibly used importer is never reused. A deliberate repeat starts
        // a fresh destination tab, so the old preview remains available for
        // inspection and cannot receive the same file twice.
        if (provider.repeat) provider.targetTabId = null;
        activeProvider = provider.id;
        const currentGeneration = ++generation;
        render(provider, { buttonText: 'Preparing…', message: 'Reading the saved GPX…' });

        // This must be the first awaited extension call so Chromium retains the
        // user activation for its optional-host prompt.
        const permission = await sendBg({ type: provider.permissionType });
        if (currentGeneration !== generation) return;
        if (permission.kind !== 'response' || !permission.value?.ok) {
            activeProvider = null;
            render(provider, {
                message: permission.kind === 'response' && permission.value?.message
                    ? permission.value.message
                    : `${provider.name} access could not be requested. Try again.`,
            });
            return;
        }

        const workflow = await TrustedAction.begin(ext, event, provider.action, currentGeneration);
        if (currentGeneration !== generation) {
            if (workflow) void TrustedAction.end(ext, workflow, currentGeneration);
            return;
        }
        if (!workflow) {
            activeProvider = null;
            render(provider, { message: 'Click the button again to authorize this transfer.' });
            return;
        }

        let source;
        try {
            source = await GpxSource.readSourceGpx({
                pageUrl: location.href,
                gpxUrl: info.gpxUrl,
                maxBytes: provider.maxBytes,
            });
        } catch {
            source = { ok: false, message: 'The saved GPX could not be read.' };
        }
        if (!source.ok) {
            void TrustedAction.end(ext, workflow, currentGeneration);
            if (currentGeneration === generation) {
                activeProvider = null;
                render(provider, { message: source.message });
            }
            return;
        }
        if (currentGeneration !== generation) {
            void TrustedAction.end(ext, workflow, currentGeneration);
            return;
        }

        render(provider, {
            buttonText: `Opening ${provider.name}…`,
            message: `Preparing ${provider.name}’s import preview…`,
        });
        const response = await sendBg({
            type: provider.prepareType,
            ...source,
            grantToken: workflow.grantToken,
            generation: String(currentGeneration),
            ...(Number.isInteger(provider.targetTabId) ? { targetTabId: provider.targetTabId } : {}),
        });
        void TrustedAction.end(ext, workflow, currentGeneration);
        if (currentGeneration !== generation) return;
        activeProvider = null;

        if (response.kind !== 'response') {
            render(provider, {
                buttonText: `Send to ${provider.name} again`,
                message: `The transfer result was lost. Check ${provider.name} before sending again.`,
                repeat: true,
            });
            return;
        }
        const result = response.value || {};
        if (Number.isInteger(result.targetTabId)) provider.targetTabId = result.targetTabId;
        if (result.ok) {
            render(provider, {
                buttonText: `Send to ${provider.name} again`,
                message: result.message,
                success: true,
                repeat: true,
            });
            return;
        }
        if (result.supplied) {
            render(provider, {
                buttonText: `Send to ${provider.name} again`,
                message: result.message,
                repeat: true,
            });
            return;
        }
        if (result.code !== 'sign-in-required') provider.targetTabId = null;
        render(provider, {
            message: result.message || `${provider.name} could not prepare this GPX.`,
        });
    };

    for (const provider of providers.values()) {
        provider.button.addEventListener('click', event => run(provider, event));
    }
    updateButtons();
    const placeBesideDownload = () => {
        if (trackLink.nextElementSibling !== control) trackLink.after(control);
    };
    const stopPlacement = () => {
        placementObserver?.disconnect();
        placementObserver = null;
    };
    const observePlacement = () => {
        placeBesideDownload();
        if (placementObserver || !trackLink.parentElement) return;
        placementObserver = new MutationObserver(placeBesideDownload);
        placementObserver.observe(trackLink.parentElement, { childList: true });
    };
    observePlacement();
    let settingsRevision = 0;
    const unsubscribe = S.subscribe(settings => {
        settingsRevision++;
        preferences = settings;
        if (!settings.mapProvidersEnabled.includes('onx')) cancelOnx();
        updateButtons();
    });
    const loadPreferences = async () => {
        const revision = settingsRevision;
        const settings = await S.get();
        if (revision === settingsRevision) { preferences = settings; updateButtons(); }
    };
    void loadPreferences();
    PageLifecycle.create({
        onSuspend: () => { stopPlacement(); cancelOnx(); },
        onResume: () => { observePlacement(); void loadPreferences(); },
        onDispose: () => {
            cancelOnx();
            generation++;
            settingsRevision++;
            unsubscribe();
            stopPlacement();
        },
    });
})();
