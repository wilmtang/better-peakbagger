// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    GAIA_MAP_URL,
    GAIA_PERMISSION,
    MAX_GAIA_GPX_BYTES,
    prepareGaiaImport,
} from '../gaia/gaia-import.js';
import { ascentIdentity } from '../gaia/gaia-source.js';

const LOAD_TIMEOUT_MS = 25_000;

const transferIdentity = (message, sender) => {
    const identity = ascentIdentity(sender?.url);
    if (!identity || message?.sourceUrl !== identity.url
        || message?.filename !== `peakbagger-${identity.id}.gpx`
        || typeof message?.gpx !== 'string'
        || new Blob([message.gpx]).size > MAX_GAIA_GPX_BYTES) return null;
    return identity;
};

const isGaiaMapTab = tab => {
    try {
        const url = new URL(tab?.url || '');
        return url.origin === new URL(GAIA_MAP_URL).origin && url.pathname === '/map/';
    } catch { return false; }
};

export function createGaiaRoutes({ ext, isPeakbaggerSender, trustedActions, action }) {
    const running = new Set();

    const waitForComplete = async tabId => {
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        let tab;
        do {
            tab = await ext.tabs.get(tabId);
            if (tab?.status === 'complete') return tab;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error('Gaia did not finish loading.');
    };

    const focus = async tab => {
        if (!Number.isInteger(tab?.id)) return;
        await ext.tabs.update(tab.id, { active: true });
        if (Number.isInteger(tab.windowId) && ext.windows?.update) {
            await ext.windows.update(tab.windowId, { focused: true });
        }
    };

    const reusableTab = async (message, sender) => {
        if (!Number.isInteger(message?.targetTabId)) return null;
        try {
            const tab = await ext.tabs.get(message.targetTabId);
            return tab?.windowId === sender.tab.windowId && isGaiaMapTab(tab) ? tab : null;
        } catch { return null; }
    };

    const requestPermission = async (_message, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender?.tab?.id)) {
            return { ok: false, code: 'forbidden', message: 'Gaia access can only be requested from Peakbagger.' };
        }
        try {
            // Do not await contains() first: an intervening promise loses the
            // user activation required by Chromium's optional-host prompt.
            const granted = await ext.permissions.request(GAIA_PERMISSION);
            return granted
                ? { ok: true }
                : { ok: false, code: 'permission-denied', message: 'Gaia access was not granted.' };
        } catch {
            // Firefox does not propagate a content-page click into the worker.
            // Continue in an extension document where its next click is valid.
            try {
                await ext.tabs.create({
                    url: ext.runtime.getURL('gaia/access.html'),
                    active: true,
                    windowId: sender.tab.windowId,
                });
                return {
                    ok: false,
                    code: 'permission-setup-opened',
                    message: 'Allow Gaia access in the opened tab, then click Send to Gaia again.',
                };
            } catch {
                return {
                    ok: false,
                    code: 'permission-unavailable',
                    message: 'Open Better Peakbagger’s site permissions and allow Gaia, then try again.',
                };
            }
        }
    };

    const prepare = async (message, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender?.tab?.id)
            || !transferIdentity(message, sender)) {
            return {
                ok: false,
                supplied: false,
                code: 'forbidden',
                message: 'Reload this saved ascent and try again.',
            };
        }
        if (!await trustedActions.consumeGrant(message, sender, action, { oneUse: true })) {
            return {
                ok: false,
                supplied: false,
                code: 'activation-required',
                message: 'Click Send to Gaia again.',
            };
        }
        if (!await ext.permissions.contains(GAIA_PERMISSION)) {
            return {
                ok: false,
                supplied: false,
                code: 'permission-required',
                message: 'Gaia access was not granted.',
            };
        }
        if (running.has(sender.tab.id)) {
            return {
                ok: false,
                supplied: false,
                code: 'already-running',
                message: 'An import from this ascent is already running.',
            };
        }

        running.add(sender.tab.id);
        let target = null;
        let injectionStarted = false;
        try {
            target = await reusableTab(message, sender) || await ext.tabs.create({
                url: GAIA_MAP_URL,
                active: false,
                windowId: sender.tab.windowId,
            });
            target = await waitForComplete(target.id);
            if (!isGaiaMapTab(target)) {
                throw new Error('Gaia did not stay on its map.');
            }
            injectionStarted = true;
            const [injection] = await ext.scripting.executeScript({
                target: { tabId: target.id },
                func: prepareGaiaImport,
                args: [{ gpx: message.gpx, filename: message.filename }],
            });
            const outcome = injection?.result;
            if (!outcome || typeof outcome.ok !== 'boolean') {
                throw new Error('Gaia did not return the import result.');
            }
            await focus(target);
            return { ...outcome, targetTabId: target.id };
        } catch (error) {
            if (target) await focus(target).catch(() => {});
            return {
                ok: false,
                supplied: injectionStarted,
                code: injectionStarted ? 'handoff-unconfirmed' : 'gaia-unavailable',
                targetTabId: target?.id,
                message: injectionStarted
                    ? 'The Gaia handoff could not be confirmed. Check this Gaia tab before sending again.'
                    : `${error.message} No GPX was sent.`,
            };
        } finally {
            running.delete(sender.tab.id);
        }
    };

    return {
        handlers: {
            GAIA_PERMISSION_REQUEST: requestPermission,
            GAIA_IMPORT_PREPARE: prepare,
        },
    };
}
