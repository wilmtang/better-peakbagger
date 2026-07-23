// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reliable handoff from Peakbagger's native Delete Ascent submitters to the
// background worker's two-phase GitHub cleanup transaction. The editor page
// records intent before Peakbagger receives the destructive POST; the worker
// will not touch GitHub until an authenticated, complete My Ascents list proves
// that the ascent no longer exists.

import { settings as Settings } from '../settings/settings.js';

const DELETE_BUTTON_IDS = new Set(['DeleteButton', 'DeleteButton2']);
const SUBMITTING_EVENT = 'bpb:ascent-delete-submitting';

const positiveAid = value => /^\d+$/.test(String(value || '')) && Number(value) > 0
    ? Number(value)
    : null;

const isDeleteSubmitter = submitter => !!submitter && DELETE_BUTTON_IDS.has(submitter.id);

export const ascentDeletion = {
    DELETE_BUTTON_IDS,
    SUBMITTING_EVENT,
    positiveAid,
    isDeleteSubmitter,
};

(() => {
    'use strict';

    if (typeof document === 'undefined' || typeof location === 'undefined') return;
    const ext = globalThis.browser || globalThis.chrome;
    if (!ext?.runtime?.sendMessage || !/\/climber\/ascentedit\.aspx$/i.test(location.pathname)) return;

    const aid = positiveAid(new URL(location.href).searchParams.get('aid'));
    const form = document.getElementById('Form1');
    if (!aid || !form) return;

    let resubmitting = null;
    let preparing = false;
    const submitNative = submitter => {
        resubmitting = submitter;
        form.requestSubmit(submitter);
    };

    form.addEventListener('submit', event => {
        const submitter = event.submitter;
        if (!isDeleteSubmitter(submitter)) return;
        if (resubmitting === submitter) {
            resubmitting = null;
            preparing = false;
            return;
        }

        // Pause the destructive POST while the setting is read and, when
        // enabled, the intent is durably recorded. Repeated clicks stay inert.
        event.preventDefault();
        if (preparing) return;
        preparing = true;

        void Settings.get().then(async current => {
            if (!current.enableGithubBackup || !current.removeGithubBackupOnDelete) {
                submitNative(submitter);
                return;
            }

            const confirmed = globalThis.confirm(
                'Delete this ascent from Peakbagger and remove its Better Peakbagger backup files from GitHub?\n\n'
                + 'Peakbagger deletion cannot be undone. GitHub history keeps the backup recoverable, '
                + 'and files you added to its folder will remain.'
            );
            if (!confirmed) {
                preparing = false;
                submitter.focus();
                return;
            }

            let response = null;
            try {
                response = await ext.runtime.sendMessage({
                    type: 'GITHUB_ASCENT_DELETE_INTENT',
                    aid,
                });
            } catch (_error) { /* handled by the actionable message below */ }
            if (!response?.ok) {
                preparing = false;
                globalThis.alert(
                    'GitHub cleanup could not be prepared, so Peakbagger was not changed. '
                    + 'Check the GitHub connection in Better Peakbagger Settings and try again.'
                );
                submitter.focus();
                return;
            }

            document.dispatchEvent(new CustomEvent(SUBMITTING_EVENT, { detail: { aid } }));
            submitNative(submitter);
        }).catch(() => {
            preparing = false;
            globalThis.alert(
                'Better Peakbagger could not read its deletion setting, so Peakbagger was not changed. '
                + 'Reload the page and try again.'
            );
            submitter.focus();
        });
    }, true);
})();
