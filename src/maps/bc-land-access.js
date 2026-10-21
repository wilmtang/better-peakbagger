// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BC_LAND_PERMISSION } from './canadian-land.js';

export function initBCLandAccess({ document: doc = document, ext = globalThis.browser || globalThis.chrome, close = () => globalThis.close() } = {}) {
    const button = doc.getElementById('allow-bc-land'), status = doc.getElementById('bc-land-access-status');
    if (!button || !status || !ext?.permissions) return;
    let busy = false, allowed = false;
    button.addEventListener('click', async event => {
        if (!event.isTrusted || busy) return;
        if (allowed) { close(); return; }
        busy = true; button.setAttribute('aria-disabled', 'true'); status.textContent = 'Waiting for the browser…';
        try {
            if (!await ext.permissions.request(BC_LAND_PERMISSION)) { status.textContent = 'Access not granted. Try again.'; return; }
            allowed = true; button.textContent = 'Return to map'; status.textContent = 'Access enabled.';
            const tabId = Number(new URL(doc.URL).searchParams.get('tab'));
            if (Number.isSafeInteger(tabId) && tabId > 0) {
                try { await ext.tabs.sendMessage(tabId, { type: 'BC_LAND_PERMISSION_GRANTED' }); } catch { /* The map may have closed. */ }
            }
        } catch { status.textContent = 'Could not allow access. Try again.'; }
        finally { busy = false; button.setAttribute('aria-disabled', 'false'); }
    });
}
if (typeof document !== 'undefined') initBCLandAccess();
