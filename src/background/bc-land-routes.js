// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BC_LAND_PERMISSION, bcLandTileUrl, landCoverage } from '../maps/canadian-land.js';
import { tileBounds } from '../maps/map-overlay-providers.js';
import { readBCTileCoordinates } from '../maps/bc-land-client.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';

export function createBCLandRoutes({ ext, isPeakbaggerSender, isTerrainSender = () => false, fetchImpl = globalThis.fetch }) {
    const jobs = new Map();
    const setupTabs = new Map();
    let retryAt = 0;
    const validSender = sender => Number.isInteger(sender?.tab?.id) && (isPeakbaggerSender(sender) || isTerrainSender(sender));
    const key = (message, sender) => `${sender.tab.id}:${sender.frameId || 0}:${message.requestId}`;
    const validId = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/i.test(value);
    const get = async (message, sender) => {
        const coordinates = readBCTileCoordinates(message.coordinates);
        if (!validSender(sender) || !validId(message.requestId) || !coordinates) return { ok: false, code: 'forbidden' };
        const bbox = tileBounds(coordinates), latitude = value => Math.atan(Math.sinh(value / 6378137)) * 180 / Math.PI;
        if (!landCoverage([bbox[0] / 20037508.342789244 * 180, latitude(bbox[1]), bbox[2] / 20037508.342789244 * 180, latitude(bbox[3])]).includes('bc')) return { ok: false, code: 'forbidden' };
        const id = key(message, sender);
        if (jobs.has(id) || jobs.size >= 16) return { ok: false, code: 'busy' };
        if (retryAt > Date.now()) return { ok: false, code: 'rate-limit', retryAt };
        const deadline = requestDeadline.createRequestDeadline(); jobs.set(id, deadline);
        let reader;
        try {
            if (!await deadline.run(ext.permissions.contains(BC_LAND_PERMISSION))) return { ok: false, code: 'bc-permission-required' };
            if (deadline.signal.aborted) return { ok: false };
            const response = await deadline.run(fetchImpl(bcLandTileUrl(bbox), { signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }));
            if (response.status === 429) { retryAt = rateLimitError('BC maps', response).retryAt; return { ok: false, code: 'rate-limit', retryAt }; }
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png') || Number(response.headers.get('content-length')) > 1048576) return { ok: false };
            reader = response.body.getReader(); let length = 0; const chunks = [];
            while (true) {
                const chunk = await deadline.run(reader.read()); if (chunk.done) break;
                length += chunk.value.length; if (length > 1048576) return { ok: false }; chunks.push(chunk.value);
            }
            const bytes = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            if (length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
                || new DataView(bytes.buffer).getUint32(16) !== 256 || new DataView(bytes.buffer).getUint32(20) !== 256 || deadline.signal.aborted) return { ok: false };
            let encoded = ''; for (let i = 0; i < length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return { ok: true, image: btoa(encoded) };
        } catch { return { ok: false }; }
        finally { if (reader) void reader.cancel().catch(() => {}); deadline.clear(); jobs.delete(id); }
    };
    const cancel = (message, sender) => {
        if (validSender(sender) && validId(message.requestId)) jobs.get(key(message, sender))?.abort();
        return { ok: true };
    };
    const permission = async (_message, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender?.tab?.id)) return { ok: false };
        // Keep the trusted click's activation: no await before the prompt.
        try { return { ok: await ext.permissions.request(BC_LAND_PERMISSION) }; }
        catch {
            // Firefox does not propagate a web-page click's activation to the
            // worker. A packaged page provides its own explicit Allow click.
            const url = ext.runtime.getURL(`bc-land/access.html?tab=${sender.tab.id}`);
            try {
                const existing = setupTabs.get(sender.tab.id);
                let tab;
                if (existing) {
                    try { tab = await ext.tabs.get(existing); } catch { /* Closed setup. */ }
                    if (tab?.url !== url) tab = null;
                }
                if (tab) await ext.tabs.update(tab.id, { active: true });
                else { tab = await ext.tabs.create({ url, active: true, windowId: sender.tab.windowId }); setupTabs.set(sender.tab.id, tab.id); }
                return { ok: false, code: 'permission-setup-opened' };
            } catch { return { ok: false }; }
        }
    };
    return { handlers: { BC_LAND_TILE_GET: get, BC_LAND_TILE_CANCEL: cancel, BC_LAND_PERMISSION_REQUEST: permission },
        cancelTab(tabId) {
            for (const [id, deadline] of jobs) if (id.startsWith(`${tabId}:`)) deadline.abort();
            setupTabs.delete(tabId); for (const [owner, setup] of setupTabs) if (setup === tabId) setupTabs.delete(owner);
        } };
}
