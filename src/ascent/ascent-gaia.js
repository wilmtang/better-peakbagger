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
import { MAX_ONX_GPX_BYTES } from '../onx/onx-import.js';
import { dom as Dom } from '../ui/dom.js';
import { pageLifecycle as PageLifecycle } from '../ui/page-lifecycle.js';
import { runtimeMessage as RuntimeMessage } from '../ui/runtime-message.js';
import { trustedAction as TrustedAction } from '../ui/trusted-action.js';

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
        const labelElement = el('span', { class: 'bpb-map-handoff-label', text: config.buttonLabel });
        const button = el('button', {
            type: 'button',
            class: `bpb-map-handoff-button bpb-map-handoff-button-${config.id}`,
            'data-provider': config.id,
            'aria-label': config.ariaLabel,
        }, [
            el('span', { class: 'bpb-map-handoff-icon', 'aria-hidden': 'true' }),
            labelElement,
        ]);
        return [config.id, { ...config, button, labelElement, targetTabId: null, repeat: false }];
    }));
    const buttons = el('span', { class: 'bpb-map-handoff-buttons' },
        [...providers.values()].map(provider => provider.button));
    const control = el('span', {
        class: 'bpb-map-handoff-control',
        role: 'group',
        'aria-label': 'Send saved GPX to a map',
    }, [buttons, status]);

    let generation = 0;
    let activeProvider = null;
    let placementObserver = null;

    let preferences = S.clean();
    const updateButtons = () => {
        for (const [index, id] of preferences.mapProviderOrder.entries()) {
            const button = providers.get(id).button;
            if (buttons.children[index] !== button) buttons.insertBefore(button, buttons.children[index] || null);
        }
        control.hidden = preferences.mapProvidersEnabled.length === 0 && !activeProvider && !status.textContent;
        for (const provider of providers.values()) {
            provider.button.hidden = !preferences.mapProvidersEnabled.includes(provider.id) && activeProvider !== provider.id;
            provider.button.disabled = !!activeProvider;
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
        status.textContent = message;
        status.hidden = !message;
        updateButtons();
    };

    const run = async (provider, event) => {
        if (event?.isTrusted !== true || activeProvider || !preferences.mapProvidersEnabled.includes(provider.id)) return;
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
        updateButtons();
    });
    const loadPreferences = async () => {
        const revision = settingsRevision;
        const settings = await S.get();
        if (revision === settingsRevision) { preferences = settings; updateButtons(); }
    };
    void loadPreferences();
    PageLifecycle.create({
        onSuspend: stopPlacement,
        onResume: () => { observePlacement(); void loadPreferences(); },
        onDispose: () => {
            generation++;
            settingsRevision++;
            unsubscribe();
            stopPlacement();
        },
    });
})();
