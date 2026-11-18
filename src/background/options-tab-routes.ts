// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — worker routes that open or reuse extension pages from a
// Peakbagger page: the Settings tab (beta and custom-layer sections, one
// registered tab reused across requests) and the report drafts manager. Both
// require a Peakbagger sender and a trusted user-activation capability.

import { trustedActions as TrustedActions } from './trusted-actions.js';

type Ext = typeof chrome;
type Sender = chrome.runtime.MessageSender;
// Runtime messages cross a trust boundary; fields stay unchecked until read.
type TabMessage = Record<string, unknown> & { disposition?: unknown };
type PublicFailure = { code: string; message: string; retryAt?: number };

interface OptionsTabRouteOptions {
    ext: Ext;
    isPeakbaggerSender: (sender: Sender | null | undefined) => boolean;
    isExtensionPage: (sender: Sender | null | undefined) => boolean;
    trustedActions: { consumeCapability(message: object, sender: Sender, action: string): boolean };
    publicFailure: (context: string, error: unknown, fallback: { code: string; message: string }) => PublicFailure;
    readMap: <Value>(key: string) => Promise<Record<string, Value>>;
    mutateMap: <Result, Value>(key: string, mutate: (map: Record<string, Value>) => Result | Promise<Result>) => Promise<Result>;
}

const BETA_SETTINGS_TABS_KEY = 'bpbBetaSettingsTabs';
const DRAFT_MANAGER_OPEN_ERROR = Object.freeze({
    code: 'draft-manager-open-failed',
    message: 'Report drafts could not be opened. Try again.',
});
const BETA_SETTINGS_OPEN_ERROR = Object.freeze({
    code: 'beta-settings-open-failed',
    message: 'Settings could not be opened. Try again.',
});

export function createOptionsTabRoutes({
    ext, isPeakbaggerSender, isExtensionPage, trustedActions, publicFailure, readMap, mutateMap,
}: OptionsTabRouteOptions) {
    const openDraftsManager = async (message: TabMessage, sender: Sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return {
                ok: false,
                error: {
                    code: 'forbidden',
                    message: 'Report drafts can only be opened from a Peakbagger page.',
                },
            };
        }
        if (!trustedActions.consumeCapability(
            message,
            sender,
            TrustedActions.ACTIONS.DRAFT_MANAGER,
        )) {
            return {
                ok: false,
                error: {
                    code: 'activation-required',
                    message: 'Use the report editor button to open report drafts.',
                },
            };
        }
        try {
            const tab = await ext.tabs.create({
                url: ext.runtime.getURL('options/drafts.html')
            });
            return { ok: true, tabId: Number.isInteger(tab?.id) ? tab.id : null };
        } catch (error) {
            return {
                ok: false,
                error: publicFailure('report drafts manager tab opening', error, DRAFT_MANAGER_OPEN_ERROR),
            };
        }
    };

    const optionsPageUrl = ext.runtime.getURL('options/options.html');
    const isOptionsPageUrl = (value: unknown) => {
        try {
            const actual = new URL(value as string);
            const expected = new URL(optionsPageUrl);
            return actual.origin === expected.origin && actual.pathname === expected.pathname;
        } catch { return false; }
    };
    const rememberBetaSettingsTab = (tabId: number | undefined) => mutateMap(BETA_SETTINGS_TABS_KEY, (tabs: Record<string, { owned: boolean }>) => {
        for (const key of Object.keys(tabs)) delete tabs[key];
        if (Number.isInteger(tabId)) tabs[tabId as number] = { owned: true };
    });
    const forgetBetaSettingsTab = async (tabId: number) => {
        const records = await readMap<{ owned: boolean }>(BETA_SETTINGS_TABS_KEY);
        if (!Object.hasOwn(records, tabId)) return;
        await mutateMap(BETA_SETTINGS_TABS_KEY, (tabs: Record<string, { owned: boolean }>) => { delete tabs[tabId]; });
    };
    const registeredBetaSettingsTab = async () => {
        const records = await readMap<{ owned: boolean }>(BETA_SETTINGS_TABS_KEY);
        const tabId = Number(Object.keys(records)[0]);
        if (!Number.isInteger(tabId)) return null;
        try {
            const tab = await ext.tabs.get(tabId);
            if (tab?.url && !isOptionsPageUrl(tab.url)) {
                await forgetBetaSettingsTab(tabId);
                return null;
            }
            return Number.isInteger(tab?.id) ? tab : null;
        } catch {
            await forgetBetaSettingsTab(tabId);
            return null;
        }
    };
    const registerBetaSettingsTab = async (sender: Sender) => {
        if (!isExtensionPage(sender) || !isOptionsPageUrl(sender?.url)
            || !Number.isInteger(sender?.tab?.id)) {
            return { ok: false, error: { code: 'forbidden' } };
        }
        await rememberBetaSettingsTab(sender.tab!.id);
        return { ok: true };
    };

    let betaSettingsQueue: Promise<unknown> = Promise.resolve();
    const openBetaSettings = async (message: TabMessage, sender: Sender, { action = TrustedActions.ACTIONS.BETA_SETTINGS as string, section = 'beta' }: { action?: string; section?: string } = {}) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return {
                ok: false,
                error: {
                    code: 'forbidden',
                    message: 'Beta settings can only be opened from a Peakbagger page.',
                },
            };
        }
        if (!trustedActions.consumeCapability(message, sender, action)) {
            return { ok: false, error: { code: 'activation-required' } };
        }
        const disposition = ['foreground-tab', 'background-tab', 'new-window'].includes(message?.disposition as string)
            ? message.disposition
            : null;
        if (!disposition) return { ok: false, error: { code: 'invalid-request' } };

        const operation = betaSettingsQueue.then(async () => {
            try {
                const targetUrl = ext.runtime.getURL(`options/options.html#${section}`);
                const optionsUrl = new URL(ext.runtime.getURL('options/options.html'));
                const tabs = await ext.tabs.query({});
                const existing = await registeredBetaSettingsTab() || tabs.find(tab => {
                    try {
                        const url = new URL(tab.url as string);
                        return url.origin === optionsUrl.origin && url.pathname === optionsUrl.pathname;
                    } catch { return false; }
                });

                if (existing && Number.isInteger(existing.id)) {
                    await ext.tabs.update(existing.id, {
                        url: targetUrl,
                        ...(disposition === 'foreground-tab' ? { active: true } : {}),
                    });
                    if (disposition === 'new-window') {
                        await ext.windows.create({ tabId: existing.id, focused: true });
                    } else if (disposition === 'foreground-tab'
                        && Number.isInteger(existing.windowId)) {
                        await ext.windows.update(existing.windowId, { focused: true });
                    }
                    await rememberBetaSettingsTab(existing.id);
                    return { ok: true, tabId: existing.id, reused: true };
                }

                if (disposition === 'new-window') {
                    const createdWindow = await ext.windows.create({ url: targetUrl, focused: true });
                    const tab = createdWindow?.tabs?.[0];
                    if (Number.isInteger(tab?.id)) await rememberBetaSettingsTab(tab!.id);
                    return { ok: true, tabId: Number.isInteger(tab?.id) ? tab!.id : null, reused: false };
                }
                const tab = await ext.tabs.create({
                    url: targetUrl,
                    active: disposition === 'foreground-tab',
                    ...(Number.isInteger(sender.tab!.windowId) ? { windowId: sender.tab!.windowId } : {}),
                });
                if (Number.isInteger(tab?.id)) await rememberBetaSettingsTab(tab.id);
                return { ok: true, tabId: Number.isInteger(tab?.id) ? tab.id : null, reused: false };
            } catch (error) {
                return {
                    ok: false,
                    error: publicFailure('beta settings tab opening', error, BETA_SETTINGS_OPEN_ERROR),
                };
            }
        });
        betaSettingsQueue = operation.catch(() => {});
        return operation;
    };

    return { isOptionsPageUrl, forgetBetaSettingsTab, registerBetaSettingsTab, openBetaSettings, openDraftsManager };
}
