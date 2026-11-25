// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BC_LAND_PERMISSION, bcLandTileUrl, landCoverage } from '../maps/canadian-land.ts';
import { tileBounds } from '../maps/map-overlay-providers.ts';
import { readBCTileCoordinates } from '../maps/bc-land-client.ts';
import { requestDeadline, type RequestDeadline } from '../net/request-deadline.ts';
import { rateLimitError, cancelResponseBody } from '../net/rate-limit.ts';
import { temporaryHttpStatus } from '../net/retry-transient.ts';
import { settingsSchema as Schema } from '../settings/settings-schema.ts';

export type BCLandFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface BCLandSender {
    id?: string;
    tab?: {
        id?: number;
        windowId?: number;
        url?: string;
    };
    frameId?: number;
    url?: string;
}

export interface BCLandRouteOptions {
    ext: typeof chrome;
    isPeakbaggerSender: (sender: chrome.runtime.MessageSender) => boolean;
    isTerrainSender?: (sender: chrome.runtime.MessageSender) => boolean;
    fetchImpl?: BCLandFetch;
}

export type BCLandTileResult =
    | { ok: true; image: string }
    | { ok: false; code?: string; retryAt?: number };

export interface BCLandCancelResult {
    ok: true;
}

export interface BCLandPermissionResult {
    ok: boolean;
    code?: string;
}

export function createBCLandRoutes({
    ext,
    isPeakbaggerSender,
    isTerrainSender = () => false,
    fetchImpl = globalThis.fetch,
}: BCLandRouteOptions) {
    const jobs = new Map<string, RequestDeadline>();
    const setupTabs = new Map<number, number>();
    let retryAt = 0;
    const validSender = (
        sender: BCLandSender | null | undefined,
    ): sender is BCLandSender & { tab: { id: number; windowId?: number; url?: string } } =>
        !!sender && typeof sender.tab?.id === 'number' && Number.isInteger(sender.tab.id)
        && (isPeakbaggerSender(sender as chrome.runtime.MessageSender) || isTerrainSender(sender as chrome.runtime.MessageSender));
    const key = (
        message: Record<string, unknown>,
        sender: BCLandSender & { tab: { id: number } },
    ): string => `${sender.tab.id}:${sender.frameId || 0}:${String(message.requestId)}`;
    const validId = (value: unknown): value is string =>
        typeof value === 'string' && /^[a-z0-9-]{1,80}$/i.test(value);
    const get = async (
        message: Record<string, unknown>,
        sender: BCLandSender,
    ): Promise<BCLandTileResult> => {
        const coordinates = readBCTileCoordinates(message.coordinates);
        if (!validSender(sender) || !validId(message.requestId) || !coordinates) return { ok: false, code: 'forbidden' };
        const bbox = tileBounds(coordinates);
        const latitude = (value: number): number => Math.atan(Math.sinh(value / 6378137)) * 180 / Math.PI;
        if (!landCoverage([
            bbox[0] / 20037508.342789244 * 180,
            latitude(bbox[1]),
            bbox[2] / 20037508.342789244 * 180,
            latitude(bbox[3]),
        ]).includes('bc')) return { ok: false, code: 'forbidden' };
        const id = key(message, sender);
        if (jobs.has(id) || jobs.size >= 16) return { ok: false, code: 'busy' };
        if (retryAt > Date.now()) return { ok: false, code: 'rate-limit', retryAt };
        const deadline = requestDeadline.createRequestDeadline();
        jobs.set(id, deadline);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let response: Response | undefined;
        try {
            if (!await deadline.run(ext.permissions.contains(BC_LAND_PERMISSION))) {
                return { ok: false, code: 'bc-permission-required' };
            }
            if (deadline.signal?.aborted) return { ok: false };
            response = await deadline.run(fetchImpl(
                bcLandTileUrl(bbox, Schema.mapLandTypes(message.landTypes)),
                { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' },
            ));
            if (response.status === 429) {
                // Retry-After can be absent or invalid. Share a local backoff
                // across tabs, and never let an older flight shorten it.
                retryAt = Math.max(retryAt, rateLimitError('BC maps', response).retryAt ?? Date.now() + 300000);
                return { ok: false, code: 'rate-limit', retryAt };
            }
            if (temporaryHttpStatus(response.status)) return { ok: false, code: 'temporary' };
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')
                || Number(response.headers.get('content-length')) > 1048576 || !response.body) {
                return { ok: false };
            }
            reader = response.body.getReader();
            let length = 0;
            const chunks: Uint8Array[] = [];
            while (true) {
                const chunk = await deadline.run(reader.read());
                if (chunk.done) break;
                length += chunk.value.length;
                if (length > 1048576) return { ok: false };
                chunks.push(chunk.value);
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            if (length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
                || new DataView(bytes.buffer).getUint32(16) !== 256 || new DataView(bytes.buffer).getUint32(20) !== 256
                || deadline.signal?.aborted) return { ok: false };
            let encoded = '';
            for (let i = 0; i < length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return { ok: true, image: btoa(encoded) };
        } catch (error) {
            const failure = error && typeof error === 'object' ? error as { name?: unknown } : null;
            return { ok: false, ...(failure?.name === 'TimeoutError' || error instanceof TypeError ? { code: 'temporary' } : {}) };
        } finally {
            if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            cancelResponseBody(response);
            deadline.clear();
            jobs.delete(id);
        }
    };
    const cancel = (
        message: Record<string, unknown>,
        sender: BCLandSender,
    ): BCLandCancelResult => {
        if (validSender(sender) && validId(message.requestId)) jobs.get(key(message, sender))?.abort();
        return { ok: true };
    };
    const permission = async (
        _message: Record<string, unknown>,
        sender: BCLandSender,
    ): Promise<BCLandPermissionResult> => {
        const sourceTab = sender?.tab;
        const sourceTabId = sourceTab?.id;
        if (!sender || !isPeakbaggerSender(sender as chrome.runtime.MessageSender)
            || !sourceTab || typeof sourceTabId !== 'number' || !Number.isInteger(sourceTabId)) {
            return { ok: false };
        }
        // Keep the trusted click's activation: no await before the prompt.
        try { return { ok: await ext.permissions.request(BC_LAND_PERMISSION) }; }
        catch {
            // Firefox does not propagate a web-page click's activation to the
            // worker. A packaged page provides its own explicit Allow click.
            const url = ext.runtime.getURL(`bc-land/access.html?tab=${sourceTabId}`);
            try {
                const existing = setupTabs.get(sourceTabId);
                let tab: chrome.tabs.Tab | null = null;
                if (existing) {
                    try { tab = await ext.tabs.get(existing); } catch { /* Closed setup. */ }
                    if (tab?.url !== url) tab = null;
                }
                if (tab && existing !== undefined) await ext.tabs.update(tab.id ?? existing, { active: true });
                else {
                    tab = await ext.tabs.create({ url, active: true, windowId: sourceTab.windowId });
                    if (typeof tab.id === 'number') setupTabs.set(sourceTabId, tab.id);
                }
                return { ok: false, code: 'permission-setup-opened' };
            } catch { return { ok: false }; }
        }
    };
    return {
        handlers: {
            BC_LAND_TILE_GET: get,
            BC_LAND_TILE_CANCEL: cancel,
            BC_LAND_PERMISSION_REQUEST: permission,
        },
        cancelTab(tabId: number): void {
            for (const [id, deadline] of jobs) if (id.startsWith(`${tabId}:`)) deadline.abort();
            setupTabs.delete(tabId);
            for (const [owner, setup] of setupTabs) if (setup === tabId) setupTabs.delete(owner);
        },
    };
}
