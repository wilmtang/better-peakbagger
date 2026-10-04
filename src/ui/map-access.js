// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const initMapAccess = ({ id, name, permission }) => {
    const ext = globalThis.browser || globalThis.chrome;
    const button = document.getElementById(`allow-${id}`);
    const close = document.getElementById(`close-${id}`);
    const status = document.getElementById(`${id}-access-status`);
    if (!ext?.permissions || !button || !close || !status) return;

    button.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        button.disabled = true;
        status.textContent = 'Waiting for the browser…';
        try {
            const granted = await ext.permissions.request(permission);
            if (!granted) {
                status.textContent = `${name} access was not granted.`;
                button.disabled = false;
                return;
            }
            button.textContent = `${name} access enabled`;
            button.classList.add('is-complete');
            status.textContent = `Return to the Peakbagger ascent and click Send to ${name} again.`;
            close.hidden = false;
            close.focus();
        } catch {
            status.textContent = `The browser could not change ${name} access. Use the extension’s site permissions instead.`;
            button.disabled = false;
        }
    });

    close.addEventListener('click', event => {
        if (event.isTrusted) globalThis.close();
    });
};
