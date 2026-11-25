// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { canonicalInstagramUrl } from '../reports/instagram-url.ts';
import { trustedActions as TrustedActions } from './trusted-actions.ts';

export interface InstagramFrameSender {
    id?: string;
    url?: string;
    frameId?: number;
    documentId?: string;
    tab?: {
        id?: number;
    };
}

export interface InstagramFrameGrantRecord {
    tabId: number;
    sourceUrl: string;
    documentId: string | null;
    sourceNonce: string;
    url: string;
    automatic: boolean;
    expiresAt: number;
}

export interface InstagramFramesExt {
    runtime: {
        id?: string;
        getURL(path: string): string;
    };
    tabs: {
        get(tabId: number): Promise<{ url?: string }>;
        sendMessage(
            tabId: number,
            message: unknown,
            options?: { frameId?: number; documentId?: string },
        ): Promise<unknown>;
    };
}

export interface InstagramFramesSettingsReader {
    requireCurrent(): Promise<{ loadInstagramAutomatically?: boolean }>;
}

export interface CreateInstagramFramesOptions {
    ext: InstagramFramesExt;
    settings: InstagramFramesSettingsReader;
    trustedActions: {
        consumeCapability(message: object, sender: InstagramFrameSender, action: string): boolean;
    };
    isPeakbaggerSender: (sender: InstagramFrameSender) => boolean;
    mutateMap: <Result = unknown, Value = InstagramFrameGrantRecord>(
        key: string,
        mutate: (records: Record<string, Value>) => Result | Promise<Result>,
    ) => Promise<Result>;
    now?: () => number;
    randomToken?: () => string;
}

export type InstagramFrameMessage = Record<string, unknown>;

export type InstagramFrameIssueResult =
    | { ok: false }
    | { ok: true; token: string };

export type InstagramFrameClaimResult =
    | { ok: false }
    | { ok: true; url: string; parentOrigin: string };

const KEY = 'bpbInstagramFrameGrants';
const TTL = 60_000;
const validToken = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);

export function createInstagramFrames({
    ext,
    settings,
    trustedActions,
    isPeakbaggerSender,
    mutateMap,
    now = Date.now,
    randomToken,
}: CreateInstagramFramesOptions) {
    const token = randomToken || (() => {
        const bytes = new Uint8Array(24);
        globalThis.crypto.getRandomValues(bytes);
        return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    });
    const frameUrl = new URL(ext.runtime.getURL('reports/instagram.html'));
    const source = (sender: InstagramFrameSender): boolean => {
        if (!isPeakbaggerSender(sender) || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return false;
        try {
            return /^\/climber\/ascent(?:edit)?\.aspx$/i.test(new URL(sender.url || '').pathname);
        } catch {
            return false;
        }
    };
    const sameTab = async (record: InstagramFrameGrantRecord): Promise<boolean> => {
        try {
            return (await ext.tabs.get(record.tabId)).url === record.sourceUrl;
        } catch {
            return false;
        }
    };
    const prune = (records: Record<string, InstagramFrameGrantRecord>): void => {
        for (const [key, value] of Object.entries(records)) {
            if (!value || value.expiresAt <= now()) delete records[key];
        }
    };
    const issue = async (
        message: InstagramFrameMessage,
        sender: InstagramFrameSender,
    ): Promise<InstagramFrameIssueResult> => {
        const url = canonicalInstagramUrl(message.url);
        if (!source(sender) || !url || typeof message.sourceNonce !== 'string'
            || !(/^[a-f0-9-]{32,64}$/i.test(message.sourceNonce))) {
            return { ok: false };
        }
        const automatic = message.automatic === true;
        if (automatic) {
            if ((await settings.requireCurrent()).loadInstagramAutomatically !== true) return { ok: false };
        } else if (!trustedActions.consumeCapability(message, sender, TrustedActions.ACTIONS.INSTAGRAM_POST)) {
            return { ok: false };
        }
        const record: InstagramFrameGrantRecord = {
            tabId: sender.tab!.id as number,
            sourceUrl: sender.url!,
            documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
            sourceNonce: message.sourceNonce,
            url,
            automatic,
            expiresAt: now() + TTL,
        };
        if (!await sameTab(record)) return { ok: false };
        return mutateMap<InstagramFrameIssueResult>(KEY, records => {
            prune(records);
            if (Object.keys(records).length >= 128) return { ok: false };
            let key: string;
            do { key = token(); } while (records[key]);
            records[key] = record;
            return { ok: true, token: key };
        });
    };
    const claim = async (
        message: InstagramFrameMessage,
        sender: InstagramFrameSender,
    ): Promise<InstagramFrameClaimResult> => {
        const claimedToken = message.token;
        if (sender.id !== ext.runtime.id || !Number.isInteger(sender.tab?.id)
            || !(typeof sender.frameId === 'number' && sender.frameId > 0)
            || !validToken(claimedToken)) {
            return { ok: false };
        }
        try {
            const url = new URL(sender.url || '');
            if (url.protocol !== frameUrl.protocol || url.host !== frameUrl.host
                || url.pathname !== frameUrl.pathname || url.search || url.hash !== `#${claimedToken}`) {
                return { ok: false };
            }
        } catch {
            return { ok: false };
        }
        return mutateMap<InstagramFrameClaimResult>(KEY, async records => {
            prune(records);
            const record = records[claimedToken];
            if (!record || record.tabId !== sender.tab!.id) return { ok: false };
            delete records[claimedToken];
            if (!await sameTab(record)) return { ok: false };
            let active: unknown;
            try {
                active = await ext.tabs.sendMessage(
                    record.tabId,
                    { type: 'INSTAGRAM_FRAME_SOURCE_CURRENT', nonce: record.sourceNonce },
                    { frameId: 0, ...(record.documentId ? { documentId: record.documentId } : {}) },
                );
            } catch {
                return { ok: false };
            }
            if (!active || typeof active !== 'object' || (active as { ok?: unknown }).ok !== true) {
                return { ok: false };
            }
            if (record.automatic && (await settings.requireCurrent()).loadInstagramAutomatically !== true) {
                return { ok: false };
            }
            return { ok: true, url: record.url, parentOrigin: new URL(record.sourceUrl).origin };
        });
    };
    return {
        handlers: {
            INSTAGRAM_FRAME_ISSUE: issue,
            INSTAGRAM_FRAME_CLAIM: claim,
        },
        forgetTab: (tabId: number) => mutateMap(KEY, records => {
            prune(records);
            for (const [key, record] of Object.entries(records)) {
                if (record.tabId === tabId) delete records[key];
            }
        }),
    };
}
