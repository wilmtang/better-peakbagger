// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
export const GARMIN_ORIGIN = 'https://personal.connectapi.garmin.com';
export const GARMIN_PERMISSION = `${GARMIN_ORIGIN}/*`;
export const GARMIN_KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
export const cleanGarminKey = value => typeof value === 'string' && value.trim().length >= 20
    && value.trim().length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(value.trim()) ? value.trim() : null;
export class GarminError extends Error {
    constructor(code, retryAt = 0) {
        super(({ 'key-rejected': 'Garmin needs a new API key. Imports paused; your drafts are safe.',
            permission: 'Allow Garmin access in Settings to resume imports.',
            offline: 'Could not reach Garmin. Your drafts are safe. Check your connection and try again.',
            rate: 'Garmin asked us to wait. Your drafts are safe; checking will resume after the cooldown.',
            access: 'Garmin could not authorize this activity. Check your connection in Settings.',
            identity: 'The Garmin account could not be verified. Your previous connection is unchanged.',
            response: 'Garmin returned an unexpected response. Try again later.',
            cancelled: 'Garmin checking was cancelled.',
            capacity: 'Your activity inbox is full. Review or remove activities to make room.',
        })[code] || 'Garmin could not be checked. Try again.');
        this.name = 'GarminError'; this.code = code; this.retryAt = retryAt;
    }
}
export const positiveId = value => /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;
export async function boundedGarminBytes(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) throw new GarminError('response');
    const reader = response.body?.getReader(); if (!reader) throw new GarminError('response');
    const chunks = []; let size = 0;
    try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > limit) throw new GarminError('response'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}
export function createGarminClient({ key, fetcher = globalThis.fetch, clock = Date.now, signal } = {}) {
    if (!cleanGarminKey(key)) throw new GarminError('key-rejected');
    let bearer = null; let expires = 0; let exchange = null;
    const request = async (path, authorization, { token = false, binary = false } = {}) => {
        signal?.throwIfAborted();
        let response;
        try {
            response = await fetcher(`${GARMIN_ORIGIN}${path}`, { method: token ? 'POST' : 'GET',
                headers: { Authorization: authorization, Accept: '*/*' }, credentials: 'omit', cache: 'no-store',
                redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
        } catch { throw new GarminError(signal?.aborted ? 'cancelled' : 'offline'); }
        if (response.status === 429) {
            const seconds = Number(response.headers.get('retry-after'));
            throw new GarminError('rate', clock() + Math.min(86400, Math.max(60, seconds || 300)) * 1000);
        }
        if (response.status === 401) { if (token) throw new GarminError('key-rejected'); return null; }
        if (response.status === 403) throw new GarminError('access');
        if (!response.ok || response.redirected) throw new GarminError('response');
        const bytes = await boundedGarminBytes(response, binary ? 8 * 1024 * 1024 : token ? 32768 : 2 * 1024 * 1024);
        if (binary) return bytes;
        const text = new TextDecoder().decode(bytes);
        if (token) return text.trim();
        try { return JSON.parse(text); } catch { throw new GarminError('response'); }
    };
    const token = async (force = false) => {
        if (!force && bearer && expires > clock() + 60000) return bearer;
        if (exchange) return exchange;
        exchange = (async () => {
            const value = await request('/personalapitoken-service/personal-api/personal-api-key/token', `ApiKey ${key}`, { token: true });
            try {
                const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
                if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= clock()) throw new Error();
                expires = Math.min(payload.exp * 1000, clock() + 86400000); bearer = value; return bearer;
            } catch { throw new GarminError('response'); }
        })();
        try { return await exchange; } finally { exchange = null; }
    };
    const get = async (path, options) => {
        let result = await request(path, `Bearer ${await token()}`, options);
        if (result === null) result = await request(path, `Bearer ${await token(true)}`, options);
        if (result === null) throw new GarminError('access');
        return result;
    };
    return {
        async owner() {
            const data = await get('/userprofile-service/userprofile/settings');
            const owner = positiveId(data?.userData?.userProfilePk);
            if (!owner) throw new GarminError('identity'); return owner;
        },
        async list({ start = 0, from, to }) {
            if (!Number.isSafeInteger(start) || start < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new GarminError('response');
            const query = new URLSearchParams({ start, limit: 50, startDate: from, endDate: to, sortBy: 'startLocal', sortOrder: 'desc' });
            const data = await get(`/activitylist-service/activities/search/activities?${query}`);
            if (!Array.isArray(data) || data.length > 50) throw new GarminError('response');
            return data.map(item => {
                const id = positiveId(item.activityId), owner = positiveId(item.ownerId);
                if (!id || !/^\d{4}-\d{2}-\d{2}[ T]/.test(item.startTimeLocal || '')) throw new GarminError('response');
                return { id, owner, date: item.startTimeLocal.slice(0, 10), localStart: item.startTimeLocal.slice(0, 19),
                    utcStart: typeof item.startTimeGMT === 'string' ? item.startTimeGMT.slice(0, 19) : '',
                    type: String(item.activityType?.typeKey || '').slice(0, 60) };
            });
        },
        async recording(id, expectedOwner) {
            if (!positiveId(id) || !positiveId(expectedOwner)) throw new GarminError('identity');
            const detail = await get(`/activity-service/activity/${id}`);
            if (positiveId(detail?.activityId) !== id || positiveId(detail?.userProfileId) !== expectedOwner) throw new GarminError('identity');
            return get(`/download-service/files/activity/${id}`, { binary: true });
        },
    };
}
