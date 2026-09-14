// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Saved-ascent GPX handoff to Gaia. The exact Peakbagger download is read only
// after a trusted click, and Gaia receives it only after optional host access
// is granted. Gaia's own preview and Save action remain the final review gate.

import { ascentPage as AscentPage } from './ascent-page.js';
import { gaiaSource as GaiaSource } from '../gaia/gaia-source.js';
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
    if (!info.gpxUrl || !trackLink || !GaiaSource.storedTrackLink(info.gpxUrl, GaiaSource.ascentIdentity(location.href))) {
        return;
    }

    const statusId = `bpb-gaia-status-${info.ascentId}`;
    const label = el('span', { class: 'bpb-gaia-label', text: 'Send to Gaia' });
    const button = el('button', {
        type: 'button',
        class: 'bpb-gaia-button',
        'aria-describedby': statusId,
    }, [
        el('span', { class: 'bpb-gaia-icon', 'aria-hidden': 'true' }),
        label,
    ]);
    const status = el('span', {
        id: statusId,
        class: 'bpb-gaia-status',
        role: 'status',
        'aria-live': 'polite',
    });
    const control = el('span', {
        class: 'bpb-gaia-control',
        role: 'group',
        'aria-label': 'Send saved GPX to Gaia GPS',
    }, [button, status]);

    let generation = 0;
    let targetTabId = null;
    let terminal = false;
    let placementObserver = null;

    const render = ({ buttonText, message = '', busy = false, success = false, stop = false }) => {
        label.textContent = buttonText;
        button.disabled = busy || stop;
        button.classList.toggle('bpb-gaia-button-success', success);
        button.setAttribute('aria-busy', String(busy));
        status.textContent = message;
        status.hidden = !message;
        terminal = stop;
    };

    const run = async event => {
        if (event?.isTrusted !== true || terminal) return;
        const currentGeneration = ++generation;
        render({ buttonText: 'Preparing…', message: 'Reading the saved GPX…', busy: true });

        // This must be the first awaited extension call: Chromium can carry
        // the click activation into the worker's permission prompt. Firefox
        // cannot, so the worker opens an extension-owned one-time setup page.
        const permission = await sendBg({ type: 'GAIA_PERMISSION_REQUEST' });
        if (currentGeneration !== generation) return;
        if (permission.kind !== 'response' || !permission.value?.ok) {
            render({
                buttonText: 'Send to Gaia',
                message: permission.kind === 'response' && permission.value?.message
                    ? permission.value.message
                    : 'Gaia access could not be requested. Try again.',
            });
            return;
        }

        const workflow = await TrustedAction.begin(ext, event, 'gaia-import', currentGeneration);
        if (currentGeneration !== generation) {
            if (workflow) void TrustedAction.end(ext, workflow, currentGeneration);
            return;
        }
        if (!workflow) {
            render({ buttonText: 'Try again', message: 'Click the button again to authorize this transfer.' });
            return;
        }

        let source;
        try {
            source = await GaiaSource.readSourceGpx({ pageUrl: location.href, gpxUrl: info.gpxUrl });
        } catch {
            source = { ok: false, message: 'The saved GPX could not be read.' };
        }
        if (!source.ok) {
            void TrustedAction.end(ext, workflow, currentGeneration);
            if (currentGeneration === generation) {
                render({ buttonText: 'Try again', message: source.message });
            }
            return;
        }

        if (currentGeneration !== generation) {
            void TrustedAction.end(ext, workflow, currentGeneration);
            return;
        }
        render({ buttonText: 'Opening Gaia…', message: 'Preparing Gaia’s import preview…', busy: true });
        const response = await sendBg({
            type: 'GAIA_IMPORT_PREPARE',
            ...source,
            grantToken: workflow.grantToken,
            generation: String(currentGeneration),
            ...(Number.isInteger(targetTabId) ? { targetTabId } : {}),
        });
        void TrustedAction.end(ext, workflow, currentGeneration);
        if (currentGeneration !== generation) return;

        if (response.kind !== 'response') {
            render({
                buttonText: 'Check Gaia',
                message: 'The transfer result was lost. Check Gaia before sending again.',
                stop: true,
            });
            return;
        }
        const result = response.value || {};
        if (Number.isInteger(result.targetTabId)) targetTabId = result.targetTabId;
        if (result.ok) {
            render({ buttonText: 'Ready in Gaia', message: result.message, success: true, stop: true });
            return;
        }
        if (result.supplied) {
            render({ buttonText: 'Check Gaia', message: result.message, stop: true });
            return;
        }
        if (result.code !== 'sign-in-required') targetTabId = null;
        render({
            buttonText: result.code === 'sign-in-required' ? 'Try again' : 'Send to Gaia',
            message: result.message || 'Gaia could not prepare this GPX.',
        });
    };

    button.addEventListener('click', run);
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
    PageLifecycle.create({
        onSuspend: stopPlacement,
        onResume: observePlacement,
        onDispose: () => {
            generation++;
            stopPlacement();
        },
    });
})();
