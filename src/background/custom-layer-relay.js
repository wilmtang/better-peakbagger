// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readCustomSource, customUrl, CUSTOM_LIMITS } from '../maps/custom-overlay-schema.js';
import { PRIVATE_LIMITS, privateRequestUrl, publicPrivateSource, readPrivateParameters } from '../maps/custom-overlay-private.js';
import { storageValue as StorageValue } from '../storage/storage-value.js';
import { requestDeadline } from '../net/request-deadline.js';
import { rateLimitError } from '../net/rate-limit.js';
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const token = () => crypto.randomUUID();
const failure = (code = 'private-source') => ({ ok: false, code, error: code === 'approval' ? 'Approve private map access in BPB to load this layer.'
    : code === 'budget' ? 'Private map request allowance reached. Wait before approving more.'
        : code === 'permission' ? 'Allow access to this map provider in BPB Settings.' : 'Private map source unavailable. Check its settings.' });
const encode = bytes => { let value = '';for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));return btoa(value); };
export function createCustomLayerRelay({ ext, privateStore, catalog, isPage, isTerrain, isEditor, isAccess, trustedActions, action, now = () => Date.now(), fetchImpl = globalThis.fetch }) {
    const pending = new Map(), grants = new Map(), jobs = new Map(), cache = new Map(), flights = new Map();let cacheBytes = 0;
    const serial = operation => { const next = queue.then(operation);queue = next.catch(() => {});return next; };let queue = Promise.resolve();
    const owner = sender => `${sender.tab?.id ?? 'settings'}:${sender.frameId || 0}:${sender.documentId || sender.url}`;
    const valid = sender => sender?.id === ext.runtime.id && Number.isInteger(sender.tab?.id) && (isPage(sender) || isTerrain(sender));
    const nativeChild = sender => isPage(sender) && sender.frameId > 0 && /^\/map\/mastermap\.aspx$/i.test(new URL(sender.url).pathname);
    const record = async (id, revision) => {
        const publicSource = (await catalog.snapshot()).registry.sources.find(source => source.id === id && source.revision === revision && source.privateRequests);
        if (!publicSource) throw new Error();
        const saved = (await privateStore.get(id))?.versions?.[revision];
        if (!saved || !StorageValue.same(saved.public, publicSource)) throw new Error();
        return saved;
    };
    const bound = async (message, sender, checkRemaining = true) => {
        const grant = grants.get(`${sender.tab.id}:${message.id}`);
        if (!grant || grant.expires <= now() || grant.revision !== message.revision || grant.documentUrl !== sender.tab.url && sender.tab.url
            || isPage(sender) && grant.owner !== owner(sender) && !nativeChild(sender) || checkRemaining && grant.remaining <= 0) throw Object.assign(new Error(), { relayCode: 'approval' });
        const tab = await ext.tabs.get(sender.tab.id);
        if (tab.url !== grant.documentUrl || !tab.active) throw Object.assign(new Error(), { relayCode: 'approval' });
        return grant;
    };
    const permission = async source => {
        const origins = source.approvedOrigins.map(origin => `https://${new URL(origin).hostname}/*`);
        if (!await ext.permissions.contains({ origins })) throw Object.assign(new Error(), { relayCode: 'permission' });
    };
    const charge = async (source, grant) => {
        // Count attempts, not just successes. The durable ledger cannot be
        // reset by page reload, another tab, edits or worker suspension.
        const host = new URL(source.source.metadataUrl || source.source.dataUrl || source.source.tiles[0]).hostname;
        let denied = false;
        await privateStore.mutate(`budget:${host}`, raw => {
            const stamp = now(), ledger = raw || { start: stamp, hour: stamp, daily: 0, hourly: 0, last: stamp };
            if (!['start', 'hour', 'last', 'daily', 'hourly'].every(key => Number.isSafeInteger(ledger[key]) && ledger[key] >= 0)) { denied = true;return ledger; }
            if (stamp < ledger.last) { denied = true;return ledger; }
            if (stamp - ledger.start >= 86400000) { ledger.start = stamp;ledger.daily = 0; }
            if (stamp - ledger.hour >= 3600000) { ledger.hour = stamp;ledger.hourly = 0; }
            ledger.last = stamp;
            if (ledger.daily >= PRIVATE_LIMITS.dailyRequests || ledger.hourly >= PRIVATE_LIMITS.hourlyRequests || grant && grant.remaining <= 0) { denied = true;return ledger; }
            ledger.daily++;ledger.hourly++;if (grant) grant.remaining--;return ledger;
        });
        if (denied) throw Object.assign(new Error(), { relayCode: 'budget' });
    };
    const download = async (source, parameters, message, signal, grant) => {
        const url = privateRequestUrl(source, parameters, message), limit = message.resource === 'metadata' ? CUSTOM_LIMITS.metadata : CUSTOM_LIMITS[source.kind];
        await permission(source);
        if (await privateStore.get(`cooldown:${new URL(url).hostname}`) > now()) throw Object.assign(new Error(), { relayCode: 'budget' });
        await charge(source, grant);
        const deadline = requestDeadline.createRequestDeadline(CUSTOM_LIMITS.deadline), abort = () => deadline.abort();signal?.addEventListener('abort', abort, { once: true });
        let response, reader;
        try {
            if (signal?.aborted) throw new Error();
            response = await deadline.run(fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: deadline.signal }));
            if (response.status === 429) {
                const retryAt = rateLimitError('Map provider', response).retryAt || now() + 300000;
                await privateStore.put(`cooldown:${new URL(url).hostname}`, Math.max(retryAt, now() + 60000));throw Object.assign(new Error(), { relayCode: 'budget' });
            }
            if (!response.ok) throw Object.assign(new Error(), { httpStatus: response.status });
            if (response.redirected || Number(response.headers.get('content-length')) > limit) throw new Error();
            const type = response.headers.get('content-type')?.split(';')[0] || '';
            if (message.resource === 'metadata' ? !/json/i.test(type) : source.kind === 'raster' ? !/^image\/(png|jpeg|webp)$/.test(type) : /html|javascript|svg/i.test(type)) throw new Error();
            reader = response.body?.getReader();if (!reader) throw new Error();
            const chunks = [];let length = 0;
            while (true) { const chunk = await deadline.run(reader.read());if (chunk.done) break;length += chunk.value.length;if (length > limit) throw new Error();chunks.push(chunk.value); }
            const bytes = new Uint8Array(length);let offset = 0;for (const chunk of chunks) { bytes.set(chunk, offset);offset += chunk.length; }
            if (deadline.signal.aborted) throw new Error();
            return { bytes, type };
        } finally { if (reader) { void reader.cancel().catch(() => {});reader.releaseLock(); } else void response?.body?.cancel().catch(() => {});deadline.clear();signal?.removeEventListener('abort', abort); }
    };
    const metadata = async (saved, signal, grant, discover = false) => {
        const result = await download(saved.source, saved.parameters, { resource: 'metadata' }, signal, grant);
        const data = JSON.parse(new TextDecoder().decode(result.bytes));
        if (!/^([23])\./.test(data.tilejson) || !Array.isArray(data.tiles) || !data.tiles.length || data.tiles.length > 4 || data.tiles.some(url => !customUrl(url, true))) throw new Error();
        const origins = [...new Set(data.tiles.map(url => new URL(url).origin))];
        if (!discover && origins.some(origin => !saved.source.approvedOrigins.includes(origin))) throw Object.assign(new Error(), { relayCode: 'origins' });
        // Only validated numeric/source fields survive. Metadata tile URLs stay
        // private, even when they contain signed tokens unlike the input key.
        const source = readCustomSource({ ...saved.source, approvedOrigins: [...new Set([...saved.source.approvedOrigins, ...origins])], source: { ...saved.source.source, tiles: data.tiles, scheme: data.scheme || 'xyz',
            minNativeZoom: saved.source.source.zoomOrigin.min === 'manual' ? saved.source.source.minNativeZoom : data.minzoom ?? 0,
            maxNativeZoom: saved.source.source.zoomOrigin.max === 'manual' ? saved.source.source.maxNativeZoom : Math.min(22, data.maxzoom ?? 22),
            ...(data.bounds && { bounds: data.bounds }) } });
        if (!source) throw new Error();
        return { ...saved, source };
    };
    const handle = async (message, sender) => {
        const type = message.type;
        try {
            if (type === 'CUSTOM_PRIVATE_CHECK_CANCEL') { if (await isEditor(sender)) jobs.get(`${owner(sender)}:check`)?.abort();return { ok: true }; }
            if (type === 'CUSTOM_PRIVATE_CHECK') {
                if (!await isEditor(sender)) return failure('forbidden');
                const source = readCustomSource(message.source), parameters = readPrivateParameters(message.requestParameters);
                if (!source || jobs.size >= PRIVATE_LIMITS.concurrency) return failure('forbidden');
                const key = `${owner(sender)}:check`, controller = new AbortController();if (jobs.has(key)) return failure('busy');jobs.set(key, controller);
                try {
                    const saved = source.source.metadataUrl ? await metadata({ source, parameters }, controller.signal, null, true) : { source, parameters };
                    return { ok: true, value: { source: saved.source, origins: saved.source.approvedOrigins.filter(origin => !source.approvedOrigins.includes(origin)), layers: [] } };
                } finally { jobs.delete(key); }
            }
            if (type === 'CUSTOM_PRIVATE_OPEN') {
                if (!valid(sender) || !isPage(sender) || !trustedActions.consumeCapability(message, sender, action)) return failure('forbidden');
                const saved = await record(message.id, message.revision), tab = await ext.tabs.get(sender.tab.id);
                if (!tab.active) return failure('forbidden');
                for (const [id, item] of pending) if (item.expires <= now()) pending.delete(id);
                if (pending.size >= 16 || [...pending.values()].some(item => item.tabId === sender.tab.id && item.id === message.id)) return failure('busy');
                const key = token(), item = { id: message.id, revision: message.revision, owner: owner(sender), tabId: sender.tab.id, documentUrl: tab.url, expires: now() + 300000, name: saved.source.name, origins: saved.source.approvedOrigins };
                pending.set(key, item);
                try { const page = await ext.tabs.create({ url: ext.runtime.getURL('custom-overlay/access.html#' + key), active: true });item.accessTab = page.id; }
                catch { pending.delete(key);throw new Error(); }
                return { ok: true };
            }
            if (type === 'CUSTOM_PRIVATE_REVIEW' || type === 'CUSTOM_PRIVATE_APPROVE') {
                const item = pending.get(message.token);
                if (!isAccess(sender) || !item || item.accessTab !== sender.tab?.id || item.expires <= now()) return failure('forbidden');
                await record(item.id, item.revision);
                const tab = await ext.tabs.get(item.tabId);if (tab.url !== item.documentUrl) return failure('forbidden');
                if (type === 'CUSTOM_PRIVATE_REVIEW') return { ok: true, name: item.name, origins: item.origins, remaining: PRIVATE_LIMITS.grantRequests, minutes: PRIVATE_LIMITS.grantMs / 60000 };
                const saved = await record(item.id, item.revision);await permission(saved.source);
                grants.set(`${item.tabId}:${item.id}`, { ...item, remaining: PRIVATE_LIMITS.grantRequests, expires: now() + PRIVATE_LIMITS.grantMs });pending.delete(message.token);
                await ext.tabs.update(item.tabId, { active: true });return { ok: true };
            }
            if (type === 'CUSTOM_PRIVATE_CANCEL') {
                if (valid(sender) && requestId(message.requestId)) jobs.get(`${owner(sender)}:${message.requestId}`)?.abort();return { ok: true };
            }
            if (type !== 'CUSTOM_PRIVATE_GET' || !valid(sender) || !requestId(message.requestId)) return failure('forbidden');
            const jobKey = `${owner(sender)}:${message.requestId}`;
            if (jobs.has(jobKey) || jobs.size >= PRIVATE_LIMITS.concurrency) return failure('busy');
            const controller = new AbortController();jobs.set(jobKey, controller);
            try {
                const saved = await record(message.id, message.revision), grant = await bound(message, sender);
                if (message.resource === 'metadata') {
                    const resolvedKey = `${message.id}:${message.revision}`;
                    const resolved = resolvedSources.get(resolvedKey) || await metadata(saved, controller.signal, grant), projected = publicPrivateSource(resolved.source);
                    // Keep the public descriptor identical to its saved revision;
                    // the private resolved endpoints are internal cache only.
                    const key = `${message.id}:${message.revision}`;resolvedSources.set(key, resolved);
                    const output = { tilejson: '3.0.0', tiles: projected.source.tiles, scheme: resolved.source.source.scheme,
                        minzoom: resolved.source.source.minNativeZoom, maxzoom: resolved.source.source.maxNativeZoom };
                    return { ok: true, bytes: encode(new TextEncoder().encode(JSON.stringify(output))), contentType: 'application/json' };
                }
                const resolved = resolvedSources.get(`${message.id}:${message.revision}`) || saved;
                if (await privateStore.get(`cooldown:${new URL(resolved.source.source.metadataUrl || resolved.source.source.dataUrl || resolved.source.source.tiles[0]).hostname}`) > now()) return failure('budget');
                const url = privateRequestUrl(resolved.source, resolved.parameters, message), key = `${message.id}:${message.revision}:${url}`;
                await permission(resolved.source);
                if (cache.has(key)) { const entry = cache.get(key);cache.delete(key);cache.set(key, entry);return entry.reply; }
                // At most four bounded jobs. In-flight duplicate consumers share
                // one actual GET; only completed response bytes are public.
                let flight = flights.get(key);
                if (!flight) {
                    flight = { controller: new AbortController(), users: 0 };
                    flight.promise = download(resolved.source, resolved.parameters, message, flight.controller.signal, grant).then(result => {
                        const reply = { ok: true, bytes: encode(result.bytes), contentType: result.type };
                        while (cacheBytes + result.bytes.length > PRIVATE_LIMITS.responseCache && cache.size) { const [oldKey, old] = cache.entries().next().value;cache.delete(oldKey);cacheBytes -= old.size; }
                        cache.set(key, { reply, size: result.bytes.length });cacheBytes += result.bytes.length;return reply;
                    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });flights.set(key, flight);
                }
                flight.users++;
                let rejectAbort;const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
                const abort = () => rejectAbort(new Error());controller.signal.addEventListener('abort', abort, { once: true });
                try {
                    if (controller.signal.aborted) throw new Error();
                    const reply = await Promise.race([flight.promise, cancelled]);
                    if (controller.signal.aborted) throw new Error();
                    await record(message.id, message.revision);await bound(message, sender, false);await permission(resolved.source);
                    return reply;
                } finally { controller.signal.removeEventListener('abort', abort);if (--flight.users === 0) flight.controller.abort(); }
            } finally { jobs.delete(jobKey); }
        } catch (error) { return { ...failure(error.relayCode), ...([401, 403, 404, 410].includes(error.httpStatus) && { status: error.httpStatus }) }; }
    };
    const resolvedSources = new Map();
    return { handle: (message, sender) => ['CUSTOM_PRIVATE_OPEN', 'CUSTOM_PRIVATE_APPROVE'].includes(message.type) ? serial(() => handle(message, sender)) : handle(message, sender),
        forgetTab(tabId, closed = true) { for (const [key, item] of pending) if (item.tabId === tabId || closed && item.accessTab === tabId) pending.delete(key);
            for (const [key, item] of grants) if (item.tabId === tabId) grants.delete(key);
            for (const [key, job] of jobs) if (key.startsWith(`${tabId}:`)) job.abort(); },
        revoke() { grants.clear();pending.clear();resolvedSources.clear();cache.clear();cacheBytes = 0;for (const job of jobs.values()) job.abort(); },
    };
}
