// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface MapAccessOptions {
    id: string;
    name: string;
    permission: chrome.permissions.Permissions | {
        readonly origins?: readonly string[];
        readonly permissions?: readonly string[];
    };
}

export const initMapAccess = ({ id, name, permission }: MapAccessOptions): void => {
    const ext = globalThis.browser || globalThis.chrome;
    const button = document.getElementById(`allow-${id}`) as HTMLButtonElement | null;
    const close = document.getElementById(`close-${id}`);
    const status = document.getElementById(`${id}-access-status`);
    if (!ext?.permissions || !button || !close || !status) return;

    button.addEventListener('click', async event => {
        if (!event.isTrusted || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('aria-busy', 'true');
        status.textContent = 'Waiting for the browser…';
        try {
            const granted = await ext.permissions.request(permission as chrome.permissions.Permissions);
            if (!granted) {
                status.textContent = `${name} access was not granted.`;
                return;
            }
            const ownsFocus = document.activeElement === button;
            button.disabled = true;
            button.textContent = `${name} access enabled`;
            button.classList.add('is-complete');
            status.textContent = `Return to the Peakbagger ascent and click Send to ${name} again.`;
            close.hidden = false;
            if (ownsFocus) close.focus({ preventScroll: true });
        } catch {
            status.textContent = `The browser could not change ${name} access. Use the extension’s site permissions instead.`;
        } finally {
            button.setAttribute('aria-disabled', String(button.disabled));
            button.setAttribute('aria-busy', 'false');
        }
    });

    close.addEventListener('click', event => {
        if (event.isTrusted) globalThis.close();
    });
};
