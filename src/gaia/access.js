// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GAIA_PERMISSION } from './gaia-import.js';

(() => {
    const ext = globalThis.browser || globalThis.chrome;
    const button = document.getElementById('allow-gaia');
    const close = document.getElementById('close-gaia');
    const status = document.getElementById('gaia-access-status');
    if (!ext?.permissions || !button || !status) return;

    button.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        button.disabled = true;
        status.textContent = 'Waiting for the browser…';
        try {
            const granted = await ext.permissions.request(GAIA_PERMISSION);
            if (!granted) {
                status.textContent = 'Gaia access was not granted.';
                button.disabled = false;
                return;
            }
            button.textContent = 'Gaia access enabled';
            button.classList.add('is-complete');
            status.textContent = 'Return to the Peakbagger ascent and click Send to Gaia again.';
            close.hidden = false;
            close.focus();
        } catch {
            status.textContent = 'The browser could not change Gaia access. Use the extension’s site permissions instead.';
            button.disabled = false;
        }
    });

    close.addEventListener('click', event => {
        if (event.isTrusted) globalThis.close();
    });
})();
