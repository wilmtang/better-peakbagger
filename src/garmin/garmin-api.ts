// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
export const GARMIN_ORIGIN = 'https://personal.connectapi.garmin.com';
export const GARMIN_PERMISSION = `${GARMIN_ORIGIN}/*`;
export const garminActivityLabel = (type: string): string => ({  hiking: 'Hike', walking: 'Walk', trail_running: 'Trail run', mountaineering: 'Mountaineering',
    rock_climbing: 'Rock climb', backcountry_skiing_snowboarding: 'Backcountry ski / snowboard', cycling: 'Ride', running: 'Run' } as Record<string, string>)[type] || 'Activity';
export const cleanGarminKey = (value: unknown): string | null => typeof value === 'string' && value.trim().length >= 20
    && value.trim().length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(value.trim()) ? value.trim() : null;
export class GarminError extends Error {
    code: string;
    retryAt: number;
    constructor(code: string, retryAt = 0) {
        super(({ disabled: 'Garmin activity inbox is off. Enable it in General settings to continue.',
            'key-rejected': 'Garmin needs a new API key. Imports paused; your drafts are safe.',
            permission: 'Allow Garmin access in Settings to resume imports.',
            offline: 'Could not reach Garmin. Your drafts are safe. Check your connection and try again.',
            rate: 'Garmin asked us to wait. Your drafts are safe; checking will resume after the cooldown.',
            access: 'Garmin could not authorize this activity. Check your connection in Settings.',
            identity: 'The Garmin account could not be verified. Your previous connection is unchanged.',
            response: 'Garmin returned an unexpected response. Try again later.',
            cancelled: 'Garmin checking was cancelled.',
            capacity: 'Your activity inbox is full. Review or remove activities to make room.',
            peakbagger: 'Open Peakbagger, sign in to your selected climber, then try again.',
            handoff: 'Review the previous draft forms and saved ascents before continuing. Your activity stays in the inbox.',
            duplicate: 'This activity is already in your import history. Review it in the activity inbox.',
        } as Record<string, string>)[code] || 'Garmin could not be checked. Try again.');
        this.name = 'GarminError'; this.code = code; this.retryAt = retryAt;
    }
}
export const positiveId = (value: unknown): string | null => /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;
export async function boundedGarminBytes(response: Response, limit: number): Promise<Uint8Array> {
    if (Number(response.headers.get('content-length')) > limit) throw new GarminError('response');
    const reader = response.body?.getReader(); if (!reader) throw new GarminError('response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > limit) throw new GarminError('response'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}
type GarminClientOptions = { key?: unknown, fetcher?: typeof fetch, clock?: () => number, signal?: AbortSignal };
type RequestOptions = { token?: boolean, binary?: boolean };
// Garmin's JSON responses are untrusted and validated field by field below.
type GarminRecord = Record<string, unknown>;

export function createGarminClient({ key, fetcher = globalThis.fetch, clock = Date.now, signal }: GarminClientOptions = {}) {
    if (!cleanGarminKey(key)) throw new GarminError('key-rejected');
    let bearer: string | null = null; let expires = 0; let exchange: Promise<string> | null = null; let subject: string | null = null;
    const request = async (path: string, authorization: string, { token = false, binary = false }: RequestOptions = {}): Promise<unknown> => {
        signal?.throwIfAborted();
        let response: Response;
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
    const token = async (force = false): Promise<string> => {
        if (!force && bearer && expires > clock() + 60000) return bearer;
        if (exchange) return exchange;
        exchange = (async () => {
            const value = await request('/personalapitoken-service/personal-api/personal-api-key/token', `ApiKey ${key}`, { token: true });
            try {
                const payload = JSON.parse(atob((value as string).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
                if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= clock()) throw new Error();
                subject = typeof payload.garmin_guid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.garmin_guid) ? payload.garmin_guid : null;
                expires = Math.min(payload.exp * 1000, clock() + 86400000); bearer = value as string; return bearer;
            } catch { throw new GarminError('response'); }
        })();
        try { return await exchange; } finally { exchange = null; }
    };
    const get = async (path: string, options?: RequestOptions): Promise<unknown> => {
        let result = await request(path, `Bearer ${await token()}`, options);
        if (result === null) result = await request(path, `Bearer ${await token(true)}`, options);
        if (result === null) throw new GarminError('access');
        return result;
    };
    return {
        async owner() {
            const data = await get('/userprofile-service/userprofile/settings') as GarminRecord | null;
            // The real settings response has display/locale preferences, no
            // numeric profile ID. Do not use its display name as identity.
            // Establish token usability with that authenticated API response,
            // then corroborate numeric activity ownership through list+detail.
            if (!subject || typeof data?.displayName !== 'string' || !data.displayName) throw new GarminError('identity');
            const rows = await get('/activitylist-service/activities/search/activities?start=0&limit=1');
            if (!Array.isArray(rows) || rows.length > 1) throw new GarminError('identity');
            let owner: string | null = null;
            if (rows.length) {
                const row = rows[0] as GarminRecord;
                const id = positiveId(row.activityId);
                if (!id) throw new GarminError('identity');
                const detail = await get(`/activity-service/activity/${id}`) as GarminRecord | null;
                owner = positiveId(detail?.userProfileId);
                if (!owner || positiveId(detail?.activityId) !== id || (positiveId(row.ownerId) && positiveId(row.ownerId) !== owner)) throw new GarminError('identity');
            }
            return { subject, owner }; // Empty accounts still have a stable binding.
        },
        async list({ start = 0, from, to }: { start?: number, from: string, to: string }) {
            if (!Number.isSafeInteger(start) || start < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new GarminError('response');
            const query = new URLSearchParams({ start: String(start), limit: '50', startDate: from, endDate: to, sortBy: 'startLocal', sortOrder: 'desc' });
            const data = await get(`/activitylist-service/activities/search/activities?${query}`);
            if (!Array.isArray(data) || data.length > 50) throw new GarminError('response');
            return data.map((item: GarminRecord) => {
                const id = positiveId(item.activityId), owner = positiveId(item.ownerId);
                // RegExp.test applies String() itself; it is explicit only for the type checker.
                if (!id || !/^\d{4}-\d{2}-\d{2}[ T]/.test(String(item.startTimeLocal || ''))) throw new GarminError('response');
                const localStart = item.startTimeLocal as string;
                return { id, owner, date: localStart.slice(0, 10), localStart: localStart.slice(0, 19),
                    utcStart: typeof item.startTimeGMT === 'string' ? item.startTimeGMT.slice(0, 19) : '',
                    type: String((item.activityType as GarminRecord | undefined)?.typeKey || '').slice(0, 60) };
            });
        },
        async recording(id: string, expectedOwner: string): Promise<Uint8Array> {
            if (!positiveId(id) || !positiveId(expectedOwner)) throw new GarminError('identity');
            const detail = await get(`/activity-service/activity/${id}`) as GarminRecord | null;
            if (positiveId(detail?.activityId) !== id || positiveId(detail?.userProfileId) !== expectedOwner) throw new GarminError('identity');
            return get(`/download-service/files/activity/${id}`, { binary: true }) as Promise<Uint8Array>;
        },
    };
}
