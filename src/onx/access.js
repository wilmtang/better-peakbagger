// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ONX_PERMISSION } from './onx-import.js';

(() => {
    const ext = globalThis.browser || globalThis.chrome;
    const button = document.getElementById('allow-onx');
    const close = document.getElementById('close-onx');
    const status = document.getElementById('onx-access-status');
    if (!ext?.permissions || !button || !status) return;

    button.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        button.disabled = true;
        status.textContent = 'Waiting for the browser…';
        try {
            const granted = await ext.permissions.request(ONX_PERMISSION);
            if (!granted) {
                status.textContent = 'onX access was not granted.';
                button.disabled = false;
                return;
            }
            button.textContent = 'onX access enabled';
            button.classList.add('is-complete');
            status.textContent = 'Return to the Peakbagger ascent and click Send to onX again.';
            close.hidden = false;
            close.focus();
        } catch {
            status.textContent = 'The browser could not change onX access. Use the extension’s site permissions instead.';
            button.disabled = false;
        }
    });

    close.addEventListener('click', event => {
        if (event.isTrusted) globalThis.close();
    });
})();
