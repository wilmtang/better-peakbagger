// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { customId, customUrl, readCustomSource } from './custom-overlay-schema.js';
export const RELAY_HOST = 'relay.bpb.example';
export const PRIVATE_LIMITS = Object.freeze({ parameters: 12, grantRequests: 256, grantMs: 600000,
    hourlyRequests: 1024, dailyRequests: 4096, concurrency: 4, responseCache: 16777216 });
export function readPrivateParameters(value) {
    if (!Array.isArray(value) || value.length > PRIVATE_LIMITS.parameters) throw new Error('Use up to 12 request parameters.');
    const names = new Set();
    return value.map(item => {
        if (!item || typeof item.key !== 'string' || !/^[A-Za-z0-9_.~-]{1,80}$/.test(item.key)
            || names.has(item.key.toLowerCase()) || typeof item.value !== 'string' || !item.value.length
            || item.value.length > 2048 || /[\u0000-\u001f\u007f]/.test(item.value)) throw new Error('Each parameter needs a unique name and a value (up to 2,048 characters).');
        names.add(item.key.toLowerCase());return { key: item.key, value: item.value };
    });
}
export function relayResource(source, kind, coordinates) {
    const root = `https://${RELAY_HOST}/${source.id}/${source.revision}`;
    return kind === 'tile' ? `${root}/tile/${coordinates.z}/${coordinates.x}/${coordinates.y}` : `${root}/${kind}`;
}
export function publicPrivateSource(source) {
    const normalized = readCustomSource(source);if (!normalized) throw new Error('Invalid private source.');
    const prefix = `https://${RELAY_HOST}/${source.id}/${source.revision}`;
    return { ...normalized, privateRequests: true, approvedOrigins: [`https://${RELAY_HOST}`], source: source.kind === 'geojson'
        ? { dataUrl: `${prefix}/data`, bounds: normalized.source.bounds }
        : { ...normalized.source, tiles: normalized.source.tiles.length ? [`${prefix}/tile/{z}/{x}/{y}`] : [], ...(normalized.source.metadataUrl && { metadataUrl: `${prefix}/metadata` }) } };
}
export function readRelayResource(value) {
    try {
        const url = new URL(value), parts = url.pathname.slice(1).split('/');
        if (url.origin !== `https://${RELAY_HOST}` || url.search || url.hash || !customId(parts[0]) || !/^[1-9]\d*$/.test(parts[1])) return null;
        const revision = Number(parts[1]);if (!Number.isSafeInteger(revision)) return null;
        if (parts.length === 3 && ['metadata', 'data'].includes(parts[2])) return { id: parts[0], revision, resource: parts[2] };
        if (parts.length !== 6 || parts[2] !== 'tile' || !parts.slice(3).every(part => /^(0|[1-9]\d*)$/.test(part))) return null;
        const [z, x, y] = parts.slice(3).map(Number);
        if (z > 22 || x >= 2 ** z || y >= 2 ** z) return null;
        return { id: parts[0], revision, resource: 'tile', coordinates: { z, x, y } };
    } catch { return null; }
}
export function privateRequestUrl(source, parameters, message) {
    const kind = message.resource;
    let endpoint = kind === 'data' && source.kind === 'geojson' ? source.source.dataUrl
        : kind === 'metadata' && source.kind !== 'geojson' ? source.source.metadataUrl
            : kind === 'tile' && source.kind !== 'geojson' ? source.source.tiles[0] : null;
    if (!endpoint) throw new Error('Unsupported map resource.');
    if (kind === 'tile') {
        const { z, x, y } = message.coordinates || {};
        if (![z, x, y].every(Number.isInteger) || z < source.source.minNativeZoom || z > source.source.maxNativeZoom
            || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new Error('Invalid tile coordinates.');
        endpoint = endpoint.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y);
    }
    if (!customUrl(endpoint)) throw new Error('Invalid map endpoint.');
    const url = new URL(endpoint);
    if (!source.approvedOrigins.includes(url.origin)) throw new Error('Unapproved map host.');
    // Credentials are attached ONLY to the original input host. TileJSON may
    // name a different approved host; that host never inherits the parameters.
    const primary = source.source.metadataUrl || source.source.dataUrl || source.source.tiles[0];
    if (url.origin === new URL(primary).origin) for (const { key, value } of parameters) url.searchParams.set(key, value);
    return url.href;
}
