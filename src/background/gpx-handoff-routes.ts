// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ascentIdentity, type AscentIdentity } from '../gpx/saved-gpx-source.ts';

const LOAD_TIMEOUT_MS = 25_000;

export interface GpxHandoffTrustedActions {
    consumeGrant(
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
        action: string,
        options?: { oneUse?: boolean },
    ): boolean | Promise<boolean>;
}

export interface GpxHandoffImportResult {
    ok: boolean;
    code: string;
    supplied: boolean;
    message: string;
}

export interface GpxHandoffPermissionProvider {
    name: string;
    buttonLabel: string;
    permission: chrome.permissions.Permissions;
    accessPage: string;
    permissionType: string;
}

export interface GpxHandoffImportProvider extends GpxHandoffPermissionProvider {
    prepareType: string;
    importUrl: string;
    maxBytes: number;
    prepareImport: (options: { gpx: string; filename: string }) => Promise<GpxHandoffImportResult>;
    isTargetUrl: (url: URL) => boolean;
    wrongPageCode: string;
    wrongPageMessage: string;
    unavailableCode: string;
}

export interface GpxHandoffCallerOptions {
    ext: typeof chrome;
    isPeakbaggerSender: (sender: chrome.runtime.MessageSender) => boolean;
    trustedActions: GpxHandoffTrustedActions;
    action: string;
}

export interface GpxHandoffPermissionRouteOptions extends GpxHandoffCallerOptions {
    provider: GpxHandoffPermissionProvider;
}

export interface GpxHandoffImportRouteOptions extends GpxHandoffCallerOptions {
    provider: GpxHandoffImportProvider;
}

export type GpxHandoffPermissionResult =
    | { ok: true }
    | { ok: false; code: string; message: string };

export interface GpxHandoffPrepareResult {
    ok: boolean;
    supplied: boolean;
    code: string;
    message: string;
    targetTabId?: number;
}

export type GpxHandoffPermissionHandler = (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
) => Promise<GpxHandoffPermissionResult>;

export type GpxHandoffPrepareHandler = (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
) => Promise<GpxHandoffPrepareResult>;

export type GpxHandoffRouteHandler = (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
) => Promise<GpxHandoffPermissionResult | GpxHandoffPrepareResult>;

interface TransferPayload extends AscentIdentity {
    gpx: string;
    filename: string;
}

export function createGpxHandoffRoutes(
    options: GpxHandoffPermissionRouteOptions,
): { handlers: Record<string, GpxHandoffPermissionHandler> };
export function createGpxHandoffRoutes(
    options: GpxHandoffImportRouteOptions,
): { handlers: Record<string, GpxHandoffRouteHandler> };
export function createGpxHandoffRoutes({
    ext,
    isPeakbaggerSender,
    trustedActions,
    action,
    provider,
}: GpxHandoffPermissionRouteOptions | GpxHandoffImportRouteOptions): {
    handlers: Record<string, GpxHandoffPermissionHandler> | Record<string, GpxHandoffRouteHandler>;
} {
    const running = new Set<number>();

    const requestPermission: GpxHandoffPermissionHandler = async (_message, sender) => {
        const sourceTab = sender?.tab;
        if (!sender || !isPeakbaggerSender(sender) || !sourceTab || !Number.isInteger(sourceTab.id)) {
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
            // Firefox may reject request() without a propagated user gesture
            // even when access already exists. Check only after the request,
            // preserving Chromium's activation on the normal prompt path.
            if (await ext.permissions.contains(provider.permission).catch(() => false)) return { ok: true };
            try {
                await ext.tabs.create({
                    url: ext.runtime.getURL(provider.accessPage),
                    active: true,
                    windowId: sourceTab.windowId,
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

    if (!('prepareType' in provider) || !provider.prepareType) {
        return { handlers: { [provider.permissionType]: requestPermission } };
    }

    const transferIdentity = (
        message: Record<string, unknown>,
        sender: chrome.runtime.MessageSender,
    ): TransferPayload | null => {
        const identity = ascentIdentity(sender?.url);
        if (!identity || message?.sourceUrl !== identity.url
            || typeof message?.filename !== 'string'
            || message.filename !== `peakbagger-${identity.id}.gpx`
            || typeof message?.gpx !== 'string'
            || new Blob([message.gpx]).size > provider.maxBytes) return null;
        return { ...identity, gpx: message.gpx, filename: message.filename };
    };
    const isTargetTab = (tab: chrome.tabs.Tab | null | undefined): boolean => {
        try { return provider.isTargetUrl(new URL(tab?.url || '')); }
        catch { return false; }
    };
    const waitForComplete = async (tabId: number): Promise<chrome.tabs.Tab> => {
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        let tab: chrome.tabs.Tab;
        do {
            tab = await ext.tabs.get(tabId);
            if (tab?.status === 'complete' && tab.url && tab.url !== 'about:blank') return tab;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`${provider.name} did not finish loading.`);
    };
    const focus = async (tab: chrome.tabs.Tab | null | undefined): Promise<void> => {
        if (!tab || typeof tab.id !== 'number' || !Number.isInteger(tab.id)) return;
        await ext.tabs.update(tab.id, { active: true });
        if (typeof tab.windowId === 'number' && Number.isInteger(tab.windowId) && ext.windows?.update) {
            await ext.windows.update(tab.windowId, { focused: true });
        }
    };
    const reusableTab = async (
        message: Record<string, unknown>,
        windowId: number | undefined,
    ): Promise<chrome.tabs.Tab | null> => {
        const targetTabId = message?.targetTabId;
        if (typeof targetTabId !== 'number' || !Number.isInteger(targetTabId)) return null;
        try {
            const tab = await ext.tabs.get(targetTabId);
            return tab?.windowId === windowId && isTargetTab(tab) ? tab : null;
        } catch { return null; }
    };

    const prepare: GpxHandoffPrepareHandler = async (message, sender) => {
        const sourceTab = sender?.tab;
        const sourceTabId = sourceTab?.id;
        const payload = transferIdentity(message, sender);
        if (!sender || !isPeakbaggerSender(sender) || !sourceTab
            || typeof sourceTabId !== 'number' || !Number.isInteger(sourceTabId) || !payload) {
            return { ok: false, supplied: false, code: 'forbidden', message: 'Reload this saved ascent and try again.' };
        }
        if (!await trustedActions.consumeGrant(message, sender, action, { oneUse: true })) {
            return { ok: false, supplied: false, code: 'activation-required', message: `Click ${provider.buttonLabel} again.` };
        }
        if (!await ext.permissions.contains(provider.permission)) {
            return { ok: false, supplied: false, code: 'permission-required', message: `${provider.name} access was not granted.` };
        }
        if (running.has(sourceTabId)) {
            return { ok: false, supplied: false, code: 'already-running', message: 'An import from this ascent is already running.' };
        }

        running.add(sourceTabId);
        let target: chrome.tabs.Tab | null = null;
        let injectionStarted = false;
        try {
            target = await reusableTab(message, sourceTab.windowId) || await ext.tabs.create({
                url: provider.importUrl,
                active: false,
                windowId: sourceTab.windowId,
            });
            if (typeof target.id !== 'number' || !Number.isInteger(target.id)) {
                throw new Error(`${provider.name} tab has no id.`);
            }
            const initialTabId = target.id;
            target = await waitForComplete(initialTabId);
            const targetId = typeof target.id === 'number' && Number.isInteger(target.id) ? target.id : initialTabId;
            if (!isTargetTab(target)) {
                await focus(target);
                return {
                    ok: false,
                    supplied: false,
                    code: provider.wrongPageCode,
                    targetTabId: targetId,
                    message: provider.wrongPageMessage,
                };
            }
            injectionStarted = true;
            const [injection] = await ext.scripting.executeScript({
                target: { tabId: targetId },
                func: provider.prepareImport,
                args: [{ gpx: payload.gpx, filename: payload.filename }],
            });
            const outcome = injection?.result;
            if (!outcome || typeof outcome.ok !== 'boolean') {
                throw new Error(`${provider.name} did not return the import result.`);
            }
            await focus(target);
            return { ...outcome, targetTabId: targetId };
        } catch (error) {
            if (target) await focus(target).catch(() => {});
            const detail = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                supplied: injectionStarted,
                code: injectionStarted ? 'handoff-unconfirmed' : provider.unavailableCode,
                targetTabId: target?.id,
                message: injectionStarted
                    ? `The ${provider.name} handoff could not be confirmed. Check this ${provider.name} tab before sending again.`
                    : `${detail} No GPX was sent.`,
            };
        } finally {
            running.delete(sourceTabId);
        }
    };

    return { handlers: { [provider.permissionType]: requestPermission, [provider.prepareType]: prepare } };
}
