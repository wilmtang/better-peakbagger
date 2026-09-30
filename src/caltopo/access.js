// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CALTOPO_PERMISSION } from './caltopo-import.js';

(() => {
    const ext = globalThis.browser || globalThis.chrome;
    const button = document.getElementById('allow-caltopo');
    const close = document.getElementById('close-caltopo');
    const status = document.getElementById('caltopo-access-status');
    if (!ext?.permissions || !button || !status) return;

    button.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        button.disabled = true;
        status.textContent = 'Waiting for the browser…';
        try {
            const granted = await ext.permissions.request(CALTOPO_PERMISSION);
            if (!granted) {
                status.textContent = 'CalTopo access was not granted.';
                button.disabled = false;
                return;
            }
            button.textContent = 'CalTopo access enabled';
            button.classList.add('is-complete');
            status.textContent = 'Return to the Peakbagger ascent and click Send to CalTopo again.';
            close.hidden = false;
            close.focus();
        } catch {
            status.textContent = 'The browser could not change CalTopo access. Use the extension’s site permissions instead.';
            button.disabled = false;
        }
    });

    close.addEventListener('click', event => {
        if (event.isTrusted) globalThis.close();
    });
})();
