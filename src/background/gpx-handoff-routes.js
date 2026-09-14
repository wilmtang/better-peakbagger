// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ascentIdentity } from '../gpx/saved-gpx-source.js';

const LOAD_TIMEOUT_MS = 25_000;

export function createGpxHandoffRoutes({
    ext,
    isPeakbaggerSender,
    trustedActions,
    action,
    provider,
}) {
    const running = new Set();
    const transferIdentity = (message, sender) => {
        const identity = ascentIdentity(sender?.url);
        if (!identity || message?.sourceUrl !== identity.url
            || message?.filename !== `peakbagger-${identity.id}.gpx`
            || typeof message?.gpx !== 'string'
            || new Blob([message.gpx]).size > provider.maxBytes) return null;
        return identity;
    };
    const isTargetTab = tab => {
        try { return provider.isTargetUrl(new URL(tab?.url || '')); }
        catch { return false; }
    };
    const waitForComplete = async tabId => {
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        let tab;
        do {
            tab = await ext.tabs.get(tabId);
            if (tab?.status === 'complete') return tab;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`${provider.name} did not finish loading.`);
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
            return tab?.windowId === sender.tab.windowId && isTargetTab(tab) ? tab : null;
        } catch { return null; }
    };
    const requestPermission = async (_message, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender?.tab?.id)) {
            return { ok: false, code: 'forbidden', message: `${provider.name} access can only be requested from Peakbagger.` };
        }
        try {
            // Do not await contains() first: an intervening promise loses the
            // user activation required by Chromium's optional-host prompt.
            const granted = await ext.permissions.request(provider.permission);
            return granted
                ? { ok: true }
                : { ok: false, code: 'permission-denied', message: `${provider.name} access was not granted.` };
        } catch {
            try {
                await ext.tabs.create({
                    url: ext.runtime.getURL(provider.accessPage),
                    active: true,
                    windowId: sender.tab.windowId,
                });
                return {
                    ok: false,
                    code: 'permission-setup-opened',
                    message: `Allow ${provider.name} access in the opened tab, then click ${provider.buttonLabel} again.`,
                };
            } catch {
                return {
                    ok: false,
                    code: 'permission-unavailable',
                    message: `Open Better Peakbagger’s site permissions and allow ${provider.name}, then try again.`,
                };
            }
        }
    };
    const prepare = async (message, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender?.tab?.id)
            || !transferIdentity(message, sender)) {
            return { ok: false, supplied: false, code: 'forbidden', message: 'Reload this saved ascent and try again.' };
        }
        if (!await trustedActions.consumeGrant(message, sender, action, { oneUse: true })) {
            return { ok: false, supplied: false, code: 'activation-required', message: `Click ${provider.buttonLabel} again.` };
        }
        if (!await ext.permissions.contains(provider.permission)) {
            return { ok: false, supplied: false, code: 'permission-required', message: `${provider.name} access was not granted.` };
        }
        if (running.has(sender.tab.id)) {
            return { ok: false, supplied: false, code: 'already-running', message: 'An import from this ascent is already running.' };
        }

        running.add(sender.tab.id);
        let target = null;
        let injectionStarted = false;
        try {
            target = await reusableTab(message, sender) || await ext.tabs.create({
                url: provider.importUrl,
                active: false,
                windowId: sender.tab.windowId,
            });
            target = await waitForComplete(target.id);
            if (!isTargetTab(target)) {
                await focus(target);
                return {
                    ok: false,
                    supplied: false,
                    code: provider.wrongPageCode,
                    targetTabId: target.id,
                    message: provider.wrongPageMessage,
                };
            }
            injectionStarted = true;
            const [injection] = await ext.scripting.executeScript({
                target: { tabId: target.id },
                func: provider.prepareImport,
                args: [{ gpx: message.gpx, filename: message.filename }],
            });
            const outcome = injection?.result;
            if (!outcome || typeof outcome.ok !== 'boolean') {
                throw new Error(`${provider.name} did not return the import result.`);
            }
            await focus(target);
            return { ...outcome, targetTabId: target.id };
        } catch (error) {
            if (target) await focus(target).catch(() => {});
            return {
                ok: false,
                supplied: injectionStarted,
                code: injectionStarted ? 'handoff-unconfirmed' : provider.unavailableCode,
                targetTabId: target?.id,
                message: injectionStarted
                    ? `The ${provider.name} handoff could not be confirmed. Check this ${provider.name} tab before sending again.`
                    : `${error.message} No GPX was sent.`,
            };
        } finally {
            running.delete(sender.tab.id);
        }
    };

    return { handlers: { [provider.permissionType]: requestPermission, [provider.prepareType]: prepare } };
}
