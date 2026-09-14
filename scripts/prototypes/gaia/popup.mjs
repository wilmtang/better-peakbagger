// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome, document */

import { ascentIdentity } from './source.mjs';

const send = document.getElementById('send');
const open = document.getElementById('open');
const status = document.getElementById('status');
let sourceTab;
let targetTabId;

open.addEventListener('click', async () => {
    try { await chrome.tabs.update(targetTabId, { active: true }); }
    catch { status.textContent = 'That Gaia tab was closed. Check Saved Items in Gaia before sending again.'; }
});

send.addEventListener('click', async event => {
    if (!event.isTrusted || !sourceTab) return;
    send.disabled = true;
    status.textContent = 'Preparing GPX…';
    try {
        // Request directly in the activation handler to preserve user gesture.
        const granted = await chrome.permissions.request({ origins: ['https://www.gaiagps.com/*'] });
        if (!granted) {
            status.textContent = 'Gaia access was not granted. No GPX was sent.';
            send.disabled = false;
            return;
        }
        const result = await chrome.runtime.sendMessage({ type: 'GAIA_PREPARE', sourceTabId: sourceTab.id });
        status.textContent = result.message;
        targetTabId = result.targetTabId;
        open.hidden = !Number.isInteger(targetTabId);
        // Do not offer a blind retry after supplying the file.
        send.disabled = !!result.supplied || !!targetTabId;
        if (result.ok) await chrome.tabs.update(targetTabId, { active: true });
    } catch {
        status.textContent = 'The response was lost. Check Gaia before sending again.';
    }
});

async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (ascentIdentity(tab?.url)) {
        sourceTab = tab;
        send.disabled = false;
    } else {
        status.textContent = 'Open a Peakbagger ascent with a saved GPS track.';
    }
    const { gaiaPrototypeResult: previous } = await chrome.storage.session.get('gaiaPrototypeResult');
    if (previous?.targetTabId) {
        targetTabId = previous.targetTabId;
        open.hidden = false;
        if (!sourceTab) status.textContent = previous.message;
    }
}
void init().catch(() => { status.textContent = 'Could not read the active tab. Reopen this popup.'; });
