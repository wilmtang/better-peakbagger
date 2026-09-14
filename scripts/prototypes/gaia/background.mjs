// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global chrome */

import { ascentIdentity, MAX_PROTOTYPE_BYTES } from './source.mjs';
import { prepareGaiaImport } from './adapter.mjs';

const GAIA_PERMISSION = { origins: ['https://www.gaiagps.com/*'] };
let running = false;

async function prepare(sourceTabId) {
    if (running) return { ok: false, message: 'An import is already running. Check Gaia before starting another.' };
    running = true;
    let gaiaTab;
    try {
        if (!await chrome.permissions.contains(GAIA_PERMISSION)) throw new Error('Allow access to Gaia to prepare the GPX.');
        const sourceTab = await chrome.tabs.get(sourceTabId);
        const identity = ascentIdentity(sourceTab.url);
        if (!identity) throw new Error('Open a Peakbagger ascent with a saved GPS track.');
        const [read] = await chrome.scripting.executeScript({ target: { tabId: sourceTabId }, files: ['source.js'] });
        const payload = read?.result;
        if (!payload?.ok) throw new Error(payload?.message || 'Could not read this ascent’s saved GPX.');
        if (payload.sourceUrl !== identity.url || new Blob([payload.gpx]).size > MAX_PROTOTYPE_BYTES) {
            throw new Error('The ascent changed during the GPX read. Return to the ascent and try again.');
        }
        gaiaTab = await chrome.tabs.create({ url: 'https://www.gaiagps.com/map/', active: false, windowId: sourceTab.windowId });
        const deadline = Date.now() + 25_000;
        let current;
        do {
            current = await chrome.tabs.get(gaiaTab.id);
            if (current.status === 'complete') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        if (current.status !== 'complete') throw new Error('Gaia did not finish loading. Open the Gaia tab to check it.');
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: gaiaTab.id },
            func: prepareGaiaImport,
            args: [{ gpx: payload.gpx, filename: payload.filename }],
        });
        const outcome = result?.result || { ok: false, message: 'Gaia’s response was lost. Check its tab before sending again.' };
        return { ...outcome, targetTabId: gaiaTab.id };
    } catch (error) {
        return { ok: false, targetTabId: gaiaTab?.id, message: gaiaTab
            ? 'The Gaia transfer could not be confirmed. Check its tab before sending again; saving was not verified.'
            : error.message };
    } finally {
        running = false;
    }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
    if (message?.type !== 'GAIA_PREPARE' || !Number.isInteger(message.sourceTabId)) return false;
    void prepare(message.sourceTabId).then(async result => {
        // Store status only. Neither GPX nor credentials are persisted.
        await chrome.storage.session.set({ gaiaPrototypeResult: result });
        respond(result);
    }).catch(() => respond({ ok: false, message: 'The transfer response was lost. Check Gaia before sending again.' }));
    return true;
});
