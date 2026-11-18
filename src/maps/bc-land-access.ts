// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BC_LAND_PERMISSION } from './canadian-land.ts';

export interface BCLandAccessExtension {
    permissions?: {
        request(permissions: chrome.permissions.Permissions): Promise<boolean>;
    };
    tabs?: {
        sendMessage(tabId: number, message: unknown): Promise<unknown>;
    };
}

export interface BCLandAccessOptions {
    document?: Document;
    ext?: BCLandAccessExtension | null;
    close?: () => void;
}

export function initBCLandAccess({
    document: doc = typeof document !== 'undefined' ? document : undefined,
    ext = globalThis.browser || globalThis.chrome,
    close = () => globalThis.close(),
}: BCLandAccessOptions = {}): void {
    const button = doc?.getElementById('allow-bc-land');
    const status = doc?.getElementById('bc-land-access-status');
    if (!doc || !button || !status || !ext?.permissions) return;
    const permissions = ext.permissions;
    let busy = false;
    let allowed = false;
    button.addEventListener('click', async event => {
        if (!event.isTrusted || busy) return;
        if (allowed) { close(); return; }
        busy = true;
        button.setAttribute('aria-disabled', 'true');
        status.textContent = 'Waiting for the browser…';
        try {
            if (!await permissions.request(BC_LAND_PERMISSION as chrome.permissions.Permissions)) {
                status.textContent = 'Access not granted. Try again.';
                return;
            }
            allowed = true;
            button.textContent = 'Return to map';
            status.textContent = 'Access enabled.';
            const tabId = Number(new URL(doc.URL).searchParams.get('tab'));
            if (Number.isSafeInteger(tabId) && tabId > 0) {
                try {
                    await ext.tabs?.sendMessage(tabId, { type: 'BC_LAND_PERMISSION_GRANTED' });
                } catch { /* The map may have closed. */ }
            }
        } catch {
            status.textContent = 'Could not allow access. Try again.';
        } finally {
            busy = false;
            button.setAttribute('aria-disabled', 'false');
        }
    });
}

if (typeof document !== 'undefined') initBCLandAccess();
