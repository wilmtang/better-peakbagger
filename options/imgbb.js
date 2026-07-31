// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — device-local ImgBB API key setting.
//
// The same worker routes the photo page uses own the credential; this page
// only configures it. A saved key is never read back here — the status line
// reports whether one exists, and the field stays entry-only. The optional
// api.imgbb.com permission is requested from the Save click itself, so a key
// saved in Settings is actually usable when the photo editor uploads.

import { imgbbClient as ImgbbClient } from '../src/photos/imgbb-client.js';
import { runtimeMessage as RuntimeMessage } from '../src/ui/runtime-message.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

export const IMGBB_ORIGINS = ['https://api.imgbb.com/*'];

export const initImgbbKey = ({ extensionApi = globalThis.browser || globalThis.chrome, flash } = {}) => {
    const keyEl = document.getElementById('imgbb-key');
    const saveEl = document.getElementById('imgbb-key-save');
    const removeEl = document.getElementById('imgbb-key-remove');
    const statusEl = document.getElementById('imgbb-key-status');
    if (!extensionApi?.runtime || OptionsUtils.logMissingElements('ImgBB key setting', {
        'imgbb-key': keyEl,
        'imgbb-key-save': saveEl,
        'imgbb-key-remove': removeEl,
        'imgbb-key-status': statusEl,
    })) return { refresh() {} };

    const send = RuntimeMessage.bind(extensionApi);
    let busy = false;
    let configured = false;

    const setStatus = (message, tone = '') => {
        statusEl.textContent = message;
        statusEl.classList.toggle('is-set', tone === 'set');
        statusEl.classList.toggle('is-error', tone === 'error');
    };

    const setBusy = value => {
        busy = value;
        saveEl.disabled = value;
        removeEl.disabled = value;
    };

    // Three states worth distinguishing: no key, a key that can upload, and a
    // key whose host permission was declined — the last is the one a user
    // would otherwise only discover at upload time.
    const render = ({ permissionGranted }) => {
        removeEl.hidden = !configured;
        if (!configured) {
            setStatus('No key saved on this device.');
            return;
        }
        if (permissionGranted) setStatus('ImgBB is configured on this device.', 'set');
        else setStatus('ImgBB is configured, but upload permission is not granted.', 'error');
    };

    const refresh = async () => {
        const response = await send({ type: 'PHOTO_IMGBB_STATUS' });
        if (!response?.ok) {
            configured = false;
            removeEl.hidden = true;
            setStatus('The key could not be checked. Reload Settings and try again.', 'error');
            return;
        }
        configured = !!response.configured;
        render({ permissionGranted: !!response.permissionGranted });
    };

    // permissions.request() needs the click's own user gesture, and an awaited
    // message can spend it, so ask before anything else in the handler.
    const requestPermission = async () => {
        try {
            return !!(await extensionApi.permissions?.contains({ origins: IMGBB_ORIGINS })
                || await extensionApi.permissions?.request({ origins: IMGBB_ORIGINS }));
        } catch {
            return false;
        }
    };

    const save = async () => {
        if (busy) return;
        const key = ImgbbClient.cleanKey(keyEl.value);
        if (!key) {
            setStatus('Enter the API key from ImgBB, with no spaces.', 'error');
            keyEl.focus();
            return;
        }
        setBusy(true);
        try {
            if (!await requestPermission()) {
                setStatus('Allow access to api.imgbb.com, then choose Save key again.', 'error');
                return;
            }
            const response = await send({ type: 'PHOTO_IMGBB_SAVE_KEY', key });
            if (!response?.ok) {
                setStatus(response?.error?.message || 'The key could not be saved. Try again.', 'error');
                return;
            }
            keyEl.value = '';
            configured = true;
            render({ permissionGranted: true });
            flash?.('ImgBB key saved');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const response = await send({ type: 'PHOTO_IMGBB_REMOVE_KEY' });
            if (!response?.ok) {
                setStatus('The key could not be removed. Try again.', 'error');
                return;
            }
            keyEl.value = '';
            configured = false;
            removeEl.hidden = true;
            setStatus('No key saved on this device.');
            // Uploaded photos keep their public URLs; only new uploads stop.
            flash?.('ImgBB key removed. Uploaded photos are unchanged.');
        } finally {
            setBusy(false);
        }
    };

    saveEl.addEventListener('click', () => { void save(); });
    removeEl.addEventListener('click', () => { void remove(); });
    keyEl.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void save(); }
    });
    // The photo page can add or remove the key while Settings stays open.
    window.addEventListener('focus', () => { void refresh(); });

    void refresh();
    return { refresh };
};
