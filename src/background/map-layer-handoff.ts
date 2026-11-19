// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readLayerSnapshot } from '../maps/map-layer-protocol.ts';

type Sender = chrome.runtime.MessageSender;
type LayerSnapshot = NonNullable<ReturnType<typeof readLayerSnapshot>>;

export interface MapLayerHandoffStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface MapLayerHandoffOptions {
    storage: MapLayerHandoffStorage;
    isPeakbaggerSender: (sender: Sender) => boolean;
    now?: () => number;
}

interface HandoffRecord {
    source: number;
    window: number | undefined;
    target: string;
    expires: number;
    snapshot: LayerSnapshot;
}

export type MapLayerHandoffResult =
    | { ok: false }
    | { ok: true; snapshot?: LayerSnapshot | null };

const KEY = 'bpbMapLayerHandoffsV1';

const contextKey = async (value: string): Promise<string> => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
).map(byte => byte.toString(16).padStart(2, '0')).join('');

const destination = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !['peakbagger.com', 'www.peakbagger.com'].includes(url.hostname)
            || !/\/map\/bigmap\.aspx$/i.test(url.pathname) || url.href.length > 2048 || url.username || url.password) {
            return null;
        }
        url.hash = '';
        url.searchParams.sort();
        return url.href;
    } catch {
        return null;
    }
};

export function createMapLayerHandoff({ storage, isPeakbaggerSender, now = Date.now }: MapLayerHandoffOptions) {
    let queue: Promise<void> = Promise.resolve();
    const transact = <T>(operation: (records: HandoffRecord[]) => Promise<T>): Promise<T> => {
        const next = queue.then(async () => {
            const records = (await storage.get(KEY))[KEY];
            const live: HandoffRecord[] = Array.isArray(records)
                ? records.filter((record): record is HandoffRecord =>
                    !!record && typeof record === 'object'
                    && typeof (record as HandoffRecord).expires === 'number'
                    && (record as HandoffRecord).expires > now(),
                ).slice(-31)
                : [];
            const result = await operation(live);
            await storage.set({ [KEY]: live });
            return result;
        });
        queue = next.then(() => {}, () => {});
        return next;
    };
    return {
        prepare(message: unknown, sender: Sender): MapLayerHandoffResult | Promise<MapLayerHandoffResult> {
            const raw = (message && typeof message === 'object' ? message : null) as {
                destination?: unknown;
                snapshot?: unknown;
            } | null;
            const target = destination(raw?.destination);
            const snapshot = readLayerSnapshot(raw?.snapshot);
            const tab = sender?.tab;
            const tabId = tab?.id;
            if (!isPeakbaggerSender(sender) || typeof tabId !== 'number' || !Number.isInteger(tabId)
                || !tab || !target || !snapshot) {
                return { ok: false };
            }
            return transact(async records => {
                for (let i = records.length - 1; i >= 0; i--) {
                    if (records[i].source === tabId) records.splice(i, 1);
                }
                records.push({
                    source: tabId,
                    window: tab.windowId,
                    target: await contextKey(target),
                    expires: now() + 30000,
                    snapshot: { ...snapshot, menuOpen: false },
                });
                return { ok: true };
            });
        },
        consume(_message: unknown, sender: Sender): MapLayerHandoffResult | Promise<MapLayerHandoffResult> {
            const target = destination(sender?.url);
            const tab = sender?.tab;
            const tabId = tab?.id;
            if (!isPeakbaggerSender(sender) || !target || typeof tabId !== 'number' || !Number.isInteger(tabId) || !tab) {
                return { ok: false };
            }
            return transact(async records => {
                const key = await contextKey(target);
                const index = records.findIndex(record => record.target === key && record.window === tab.windowId
                    && (record.source === tabId || record.source === tab.openerTabId));
                if (index < 0) return { ok: false };
                const [record] = records.splice(index, 1);
                return { ok: true, snapshot: readLayerSnapshot(record.snapshot) };
            });
        },
    };
}

export type MapLayerHandoff = ReturnType<typeof createMapLayerHandoff>;
