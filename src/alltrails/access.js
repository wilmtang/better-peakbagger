// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ALLTRAILS_PERMISSION } from './alltrails-import.js';

(() => {
    const ext = globalThis.browser || globalThis.chrome;
    const button = document.getElementById('allow-alltrails');
    const close = document.getElementById('close-alltrails');
    const status = document.getElementById('alltrails-access-status');
    if (!ext?.permissions || !button || !status) return;

    button.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        button.disabled = true;
        status.textContent = 'Waiting for the browser…';
        try {
            const granted = await ext.permissions.request(ALLTRAILS_PERMISSION);
            if (!granted) {
                status.textContent = 'AllTrails access was not granted.';
                button.disabled = false;
                return;
            }
            button.textContent = 'AllTrails access enabled';
            button.classList.add('is-complete');
            status.textContent = 'Return to the Peakbagger ascent and click Send to AllTrails again.';
            close.hidden = false;
            close.focus();
        } catch {
            status.textContent = 'The browser could not change AllTrails access. Use the extension’s site permissions instead.';
            button.disabled = false;
        }
    });

    close.addEventListener('click', event => {
        if (event.isTrusted) globalThis.close();
    });
})();
