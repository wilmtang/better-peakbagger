// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    readCustomSource,
    CUSTOM_LIMITS,
    type CustomRegistry,
    type CustomSource,
} from '../maps/custom-overlay-schema.ts';
import {
    resolveCustomSourceDocument,
    type ResolveCustomSourceOptions,
} from '../maps/custom-overlay-source.ts';
import {
    PRIVATE_LIMITS,
    privateRequestUrl,
    publicPrivateSource,
    readPrivateParameters,
    type PrivateParameter,
} from '../maps/custom-overlay-private.ts';
import { storageValue as StorageValue } from '../storage/storage-value.ts';
import { requestDeadline } from '../net/request-deadline.ts';
import { rateLimitError } from '../net/rate-limit.ts';
import type {
    CustomOverlayPrivateStore,
    PrivateSourceRecord,
    PrivateSourceVersion,
} from './custom-overlay-store.ts';

type Sender = chrome.runtime.MessageSender;
type ValidSender = Sender & { tab: chrome.tabs.Tab & { id: number } };
type RelayError = Error & { relayCode?: string; httpStatus?: number };

export interface RelayExt {
    runtime: {
        id?: string;
        getURL(path: string): string;
    };
    permissions: {
        contains(permissions: { origins: string[] }): Promise<boolean>;
    };
    tabs: {
        get(tabId: number): Promise<{ url?: string; active?: boolean }>;
        create(createProperties: { url: string; active?: boolean }): Promise<{ id?: number }>;
        update(tabId: number, updateProperties: { active?: boolean }): Promise<unknown>;
    };
}

export interface CustomLayerRelayOptions {
    ext: RelayExt;
    privateStore: CustomOverlayPrivateStore;
    catalog: { snapshot(): Promise<{ registry: CustomRegistry }> };
    isPage: (sender: Sender) => boolean;
    isTerrain: (sender: Sender) => boolean;
    isEditor: (sender: Sender) => boolean | Promise<boolean>;
    isAccess: (sender: Sender) => boolean;
    trustedActions: {
        consumeCapability(message: Record<string, unknown>, sender: Sender, action: string): boolean;
    };
    action: string;
    refreshAction?: string;
    now?: () => number;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface PendingAccess {
    id: string;
    revision: number;
    owner: string;
    tabId: number;
    documentUrl: string | undefined;
    expires: number;
    name: string;
    origins: string[];
    accessTab?: number;
}

interface RelayGrant extends PendingAccess {
    remaining: number;
}

interface RelayJob {
    controller: AbortController;
    sourceKey?: string;
}

interface CacheReply {
    ok: true;
    bytes: string;
    contentType: string;
}

interface CacheEntry {
    reply: CacheReply;
    size: number;
}

interface InFlightRequest {
    controller: AbortController;
    users: number;
    promise: Promise<CacheReply>;
}

interface BudgetLedger {
    start: number;
    hour: number;
    daily: number;
    hourly: number;
    last: number;
}

interface ResolvedPrivateSource {
    source: CustomSource;
    parameters: PrivateParameter[];
    layers?: string[];
}

interface RelayMessage extends Record<string, unknown> {
    type?: unknown;
    id?: unknown;
    revision?: unknown;
    requestId?: unknown;
    resource?: unknown;
    coordinates?: unknown;
    source?: unknown;
    requestParameters?: unknown;
    detection?: unknown;
    token?: unknown;
}

export type CustomLayerRelayFailure = {
    ok: false;
    code: string;
    error: string;
    status?: number;
};

export type CustomLayerRelayResponse =
    | CustomLayerRelayFailure
    | { ok: true; epoch?: string }
    | { ok: true; value: { source: CustomSource; origins: string[]; layers: string[] } }
    | { ok: true; name: string; origins: string[]; remaining: number; minutes: number }
    | CacheReply;

const requestId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);

const token = (): string => crypto.randomUUID();

const failure = (code = 'private-source'): CustomLayerRelayFailure => ({
    ok: false,
    code,
    error: code === 'approval' ? 'Approve private map access in BPB to load this layer.'
        : code === 'budget' ? 'Private map request allowance reached. Wait before approving more.'
            : code === 'permission' ? 'Allow access to this map provider in BPB Settings.'
                : 'Private map source unavailable. Check its settings.',
});

const relayError = (relayCode?: string, httpStatus?: number): RelayError => Object.assign(
    new Error(),
    { ...(relayCode ? { relayCode } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}) },
);

const encode = (bytes: Uint8Array): string => {
    let value = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        value += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(value);
};

const primaryEndpoint = (source: CustomSource): string => source.kind === 'geojson'
    ? source.source.dataUrl
    : (source.source.metadataUrl || source.source.tiles[0]);

const hasValidRevision = (id: unknown, revision: unknown): id is string =>
    typeof id === 'string' && typeof revision === 'number' && Number.isSafeInteger(revision);

export function createCustomLayerRelay({
    ext,
    privateStore,
    catalog,
    isPage,
    isTerrain,
    isEditor,
    isAccess,
    trustedActions,
    action,
    refreshAction = action,
    now = () => Date.now(),
    fetchImpl = globalThis.fetch,
}: CustomLayerRelayOptions) {
    const pending = new Map<string, PendingAccess>();
    const grants = new Map<string, RelayGrant>();
    const jobs = new Map<string, RelayJob>();
    const cache = new Map<string, CacheEntry>();
    const flights = new Map<string, InFlightRequest>();
    let cacheBytes = 0;
    const epochs = new Map<string, number>();
    let revokeEpoch = 0;
    const resolvedSources = new Map<string, ResolvedPrivateSource>();
    let queue: Promise<void> = Promise.resolve();

    const sourceKey = (id: string, revision: number): string => `${id}:${revision}`;
    const epoch = (id: string, revision: number): string => `${revokeEpoch}:${epochs.get(sourceKey(id, revision)) || 0}`;
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = queue.then(operation);
        queue = next.then(() => {}, () => {});
        return next;
    };
    const owner = (sender: Sender): string => `${sender?.tab?.id ?? 'settings'}:${sender?.frameId || 0}:${sender?.documentId || sender?.url}`;
    const valid = (sender: Sender): sender is ValidSender =>
        sender?.id === ext.runtime.id && typeof sender.tab?.id === 'number' && Number.isInteger(sender.tab.id)
        && (isPage(sender) || isTerrain(sender));
    const nativeChild = (sender: Sender): boolean =>
        isPage(sender) && typeof sender.frameId === 'number' && sender.frameId > 0
        && typeof sender.url === 'string' && /^\/map\/mastermap\.aspx$/i.test(new URL(sender.url).pathname);

    const record = async (id: string, revision: number): Promise<PrivateSourceVersion> => {
        const publicSource = (await catalog.snapshot()).registry.sources.find(
            source => source.id === id && source.revision === revision && source.privateRequests,
        );
        if (!publicSource) throw new Error();
        const saved = (await privateStore.get<PrivateSourceRecord>(id))?.versions?.[revision];
        if (!saved || !StorageValue.same(saved.public, publicSource)) throw new Error();
        return saved;
    };

    const bound = async (
        id: string,
        revision: number,
        sender: ValidSender,
        checkRemaining = true,
    ): Promise<RelayGrant> => {
        const grant = grants.get(`${sender.tab.id}:${id}`);
        if (!grant || grant.expires <= now() || grant.revision !== revision
            || (grant.documentUrl !== sender.tab.url && sender.tab.url)
            || (isPage(sender) && grant.owner !== owner(sender) && !nativeChild(sender))
            || (checkRemaining && grant.remaining <= 0)) {
            throw relayError('approval');
        }
        const tab = await ext.tabs.get(sender.tab.id);
        if (tab.url !== grant.documentUrl || !tab.active) throw relayError('approval');
        return grant;
    };

    const permission = async (source: CustomSource): Promise<void> => {
        const origins = source.approvedOrigins.map(origin => `https://${new URL(origin).hostname}/*`);
        if (!await ext.permissions.contains({ origins })) throw relayError('permission');
    };

    const charge = async (source: CustomSource, grant: RelayGrant | null): Promise<void> => {
        // Count attempts, not just successes. The durable ledger cannot be
        // reset by page reload, another tab, edits or worker suspension.
        const host = new URL(primaryEndpoint(source)).hostname;
        let denied = false;
        const ledgerKeys = ['start', 'hour', 'last', 'daily', 'hourly'] as const;
        await privateStore.mutate<BudgetLedger, BudgetLedger>(`budget:${host}`, raw => {
            const stamp = now();
            const ledger: BudgetLedger = raw || { start: stamp, hour: stamp, daily: 0, hourly: 0, last: stamp };
            if (!ledger || typeof ledger !== 'object'
                || !ledgerKeys.every(key => Number.isSafeInteger(ledger[key]) && ledger[key] >= 0)) {
                denied = true;
                return ledger;
            }
            if (stamp < ledger.last) {
                denied = true;
                return ledger;
            }
            if (stamp - ledger.start >= 86400000) {
                ledger.start = stamp;
                ledger.daily = 0;
            }
            if (stamp - ledger.hour >= 3600000) {
                ledger.hour = stamp;
                ledger.hourly = 0;
            }
            ledger.last = stamp;
            if (ledger.daily >= PRIVATE_LIMITS.dailyRequests || ledger.hourly >= PRIVATE_LIMITS.hourlyRequests
                || (grant && grant.remaining <= 0)) {
                denied = true;
                return ledger;
            }
            ledger.daily++;
            ledger.hourly++;
            if (grant) grant.remaining--;
            return ledger;
        });
        if (denied) throw relayError('budget');
    };

    const download = async (
        source: CustomSource,
        parameters: readonly PrivateParameter[],
        message: { resource?: unknown; coordinates?: Record<string, unknown> },
        signal: AbortSignal | undefined,
        grant: RelayGrant | null,
    ): Promise<{ bytes: Uint8Array; type: string }> => {
        const url = privateRequestUrl(source as Parameters<typeof privateRequestUrl>[0], parameters, message);
        const limit = message.resource === 'metadata' ? CUSTOM_LIMITS.metadata : CUSTOM_LIMITS[source.kind];
        await permission(source);
        const cooldown = await privateStore.get<number>(`cooldown:${new URL(url).hostname}`);
        if (typeof cooldown === 'number' && cooldown > now()) throw relayError('budget');
        await charge(source, grant);
        const deadline = requestDeadline.createRequestDeadline(CUSTOM_LIMITS.deadline);
        const abort = () => deadline.abort();
        signal?.addEventListener('abort', abort, { once: true });
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            if (signal?.aborted) throw new Error();
            response = await deadline.run(fetchImpl(url, {
                method: 'GET',
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
                signal: deadline.signal,
            }));
            if (response.status === 429) {
                const retryAt = rateLimitError('Map provider', response).retryAt || now() + 300000;
                await privateStore.put(`cooldown:${new URL(url).hostname}`, Math.max(retryAt, now() + 60000));
                throw relayError('budget');
            }
            if (!response.ok) throw relayError(undefined, response.status);
            if (response.redirected || Number(response.headers.get('content-length')) > limit) throw new Error();
            const contentType = response.headers.get('content-type')?.split(';')[0] || '';
            if (message.resource === 'metadata'
                ? !/json/i.test(contentType)
                : source.kind === 'raster'
                    ? !/^image\/(png|jpeg|webp)$/.test(contentType)
                    : /html|javascript|svg/i.test(contentType)) {
                throw new Error();
            }
            reader = response.body?.getReader();
            if (!reader) throw new Error();
            const chunks: Uint8Array[] = [];
            let length = 0;
            while (true) {
                const chunk = await deadline.run(reader.read());
                if (chunk.done) break;
                length += chunk.value.length;
                if (length > limit) throw new Error();
                chunks.push(chunk.value);
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            if (deadline.signal?.aborted) throw new Error();
            return { bytes, type: contentType };
        } finally {
            if (reader) {
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            } else {
                void response?.body?.cancel().catch(() => {});
            }
            deadline.clear();
            signal?.removeEventListener('abort', abort);
        }
    };

    const metadata = async (
        saved: ResolvedPrivateSource,
        signal: AbortSignal,
        grant: RelayGrant | null,
        discover = false,
        options: ResolveCustomSourceOptions = {},
    ): Promise<ResolvedPrivateSource & { layers: string[] }> => {
        const result = await download(
            saved.source,
            saved.parameters,
            { resource: saved.source.kind === 'geojson' ? 'data' : 'metadata' },
            signal,
            grant,
        );
        const data: unknown = JSON.parse(new TextDecoder().decode(result.bytes));
        const resolved = resolveCustomSourceDocument(saved.source, data, options);
        if (!discover && resolved.origins.length) throw relayError('origins');
        // Only validated numeric/source fields survive. Metadata tile URLs stay
        // private, even when they contain signed tokens unlike the input key.
        return { ...saved, source: resolved.source, layers: resolved.layers };
    };

    const handle = async (message: unknown, sender: Sender): Promise<CustomLayerRelayResponse> => {
        const msg = (message && typeof message === 'object' ? message : {}) as RelayMessage;
        const type = msg.type;
        try {
            if (type === 'CUSTOM_PRIVATE_REFRESH') {
                if (!valid(sender) || !isPage(sender) || !requestId(msg.requestId)
                    || !trustedActions.consumeCapability(msg, sender, refreshAction)) {
                    return failure('forbidden');
                }
                if (!hasValidRevision(msg.id, msg.revision)) throw new Error();
                const id = msg.id;
                const revision = msg.revision as number;
                const stamp = epoch(id, revision);
                const saved = await record(id, revision);
                const grant = await bound(id, revision, sender);
                await permission(saved.source);
                const host = new URL(primaryEndpoint(saved.source)).hostname;
                const cooldown = await privateStore.get<number>(`cooldown:${host}`);
                if (typeof cooldown === 'number' && cooldown > now()) return failure('budget');
                await record(id, revision);
                await bound(id, revision, sender);
                if (stamp !== epoch(id, revision) || grants.get(`${sender.tab.id}:${id}`) !== grant) {
                    return failure('approval');
                }
                const key = sourceKey(id, revision);
                epochs.set(key, (epochs.get(key) || 0) + 1);
                resolvedSources.delete(key);
                for (const [cacheKey, value] of cache) {
                    if (cacheKey.startsWith(key + ':')) {
                        cache.delete(cacheKey);
                        cacheBytes -= value.size;
                    }
                }
                for (const [flightKey, flight] of flights) {
                    if (flightKey.startsWith(key + ':')) {
                        flight.controller.abort();
                        flights.delete(flightKey);
                    }
                }
                for (const job of jobs.values()) {
                    if (job.sourceKey === key) job.controller.abort();
                }
                return { ok: true, epoch: epoch(id, revision) };
            }
            if (type === 'CUSTOM_PRIVATE_CHECK_CANCEL') {
                if (await isEditor(sender)) jobs.get(`${owner(sender)}:check`)?.controller.abort();
                return { ok: true };
            }
            if (type === 'CUSTOM_PRIVATE_CHECK') {
                if (!await isEditor(sender)) return failure('forbidden');
                const source = readCustomSource(msg.source);
                const parameters = readPrivateParameters(msg.requestParameters);
                if (!source || jobs.size >= PRIVATE_LIMITS.concurrency) return failure('forbidden');
                const key = `${owner(sender)}:check`;
                const controller = new AbortController();
                if (jobs.has(key)) return failure('busy');
                jobs.set(key, { controller });
                try {
                    const detection = msg.detection && typeof msg.detection === 'object' && !Array.isArray(msg.detection)
                        ? (msg.detection as ResolveCustomSourceOptions)
                        : {};
                    const hasRemoteDoc = source.kind === 'geojson' || Boolean(source.source.metadataUrl);
                    const saved: ResolvedPrivateSource = hasRemoteDoc
                        ? await metadata({ source, parameters }, controller.signal, null, true, detection)
                        : { source, parameters };
                    return {
                        ok: true,
                        value: {
                            source: saved.source,
                            origins: saved.source.approvedOrigins.filter(origin => !source.approvedOrigins.includes(origin)),
                            layers: saved.layers || [],
                        },
                    };
                } finally {
                    jobs.delete(key);
                }
            }
            if (type === 'CUSTOM_PRIVATE_OPEN') {
                if (!valid(sender) || !isPage(sender) || !trustedActions.consumeCapability(msg, sender, action)) {
                    return failure('forbidden');
                }
                if (!hasValidRevision(msg.id, msg.revision)) throw new Error();
                const id = msg.id;
                const revision = msg.revision as number;
                const saved = await record(id, revision);
                const tab = await ext.tabs.get(sender.tab.id);
                if (!tab.active) return failure('forbidden');
                for (const [pendingId, item] of pending) {
                    if (item.expires <= now()) pending.delete(pendingId);
                }
                if (pending.size >= 16 || [...pending.values()].some(item => item.tabId === sender.tab.id && item.id === id)) {
                    return failure('busy');
                }
                const key = token();
                const item: PendingAccess = {
                    id,
                    revision,
                    owner: owner(sender),
                    tabId: sender.tab.id,
                    documentUrl: tab.url,
                    expires: now() + 300000,
                    name: saved.source.name,
                    origins: saved.source.approvedOrigins,
                };
                pending.set(key, item);
                try {
                    const page = await ext.tabs.create({
                        url: ext.runtime.getURL('custom-overlay/access.html#' + key),
                        active: true,
                    });
                    item.accessTab = page.id;
                } catch {
                    pending.delete(key);
                    throw new Error();
                }
                return { ok: true };
            }
            if (type === 'CUSTOM_PRIVATE_REVIEW' || type === 'CUSTOM_PRIVATE_APPROVE') {
                const accessToken = typeof msg.token === 'string' ? msg.token : '';
                const item = accessToken ? pending.get(accessToken) : undefined;
                if (!isAccess(sender) || !item || item.accessTab !== sender.tab?.id || item.expires <= now()) {
                    return failure('forbidden');
                }
                await record(item.id, item.revision);
                const tab = await ext.tabs.get(item.tabId);
                if (tab.url !== item.documentUrl) return failure('forbidden');
                if (type === 'CUSTOM_PRIVATE_REVIEW') {
                    return {
                        ok: true,
                        name: item.name,
                        origins: item.origins,
                        remaining: PRIVATE_LIMITS.grantRequests,
                        minutes: PRIVATE_LIMITS.grantMs / 60000,
                    };
                }
                const saved = await record(item.id, item.revision);
                await permission(saved.source);
                grants.set(`${item.tabId}:${item.id}`, {
                    ...item,
                    remaining: PRIVATE_LIMITS.grantRequests,
                    expires: now() + PRIVATE_LIMITS.grantMs,
                });
                pending.delete(accessToken);
                await ext.tabs.update(item.tabId, { active: true });
                return { ok: true };
            }
            if (type === 'CUSTOM_PRIVATE_CANCEL') {
                if (valid(sender) && requestId(msg.requestId)) {
                    jobs.get(`${owner(sender)}:${msg.requestId}`)?.controller.abort();
                }
                return { ok: true };
            }
            if (type !== 'CUSTOM_PRIVATE_GET' || !valid(sender) || !requestId(msg.requestId)) {
                return failure('forbidden');
            }
            const jobKey = `${owner(sender)}:${msg.requestId}`;
            if (jobs.has(jobKey) || jobs.size >= PRIVATE_LIMITS.concurrency) return failure('busy');
            if (!hasValidRevision(msg.id, msg.revision)) throw new Error();
            const id = msg.id;
            const revision = msg.revision as number;
            const controller = new AbortController();
            const sourceIdentifier = sourceKey(id, revision);
            jobs.set(jobKey, { controller, sourceKey: sourceIdentifier });
            const stamp = epoch(id, revision);
            const current = () => {
                if (controller.signal.aborted || stamp !== epoch(id, revision)) throw new Error();
            };
            const requestMessage = {
                resource: msg.resource,
                coordinates: msg.coordinates && typeof msg.coordinates === 'object' && !Array.isArray(msg.coordinates)
                    ? (msg.coordinates as Record<string, unknown>)
                    : undefined,
            };
            try {
                const saved = await record(id, revision);
                const grant = await bound(id, revision, sender);
                current();
                if (msg.resource === 'metadata') {
                    if (saved.source.kind === 'geojson' || !saved.source.source.metadataUrl) return failure('forbidden');
                    const resolved = resolvedSources.get(sourceIdentifier)
                        || await metadata(saved, controller.signal, grant);
                    if (resolved.source.kind === 'geojson') return failure('forbidden');
                    const projected = publicPrivateSource(resolved.source as Parameters<typeof publicPrivateSource>[0]);
                    await record(id, revision);
                    await bound(id, revision, sender, false);
                    await permission(resolved.source);
                    current();
                    // Keep the public descriptor identical to its saved revision;
                    // the private resolved endpoints are internal cache only.
                    resolvedSources.set(sourceIdentifier, resolved);
                    const output = {
                        tilejson: '3.0.0',
                        tiles: 'tiles' in projected.source ? projected.source.tiles : [],
                        scheme: resolved.source.source.scheme,
                        minzoom: resolved.source.source.minNativeZoom,
                        maxzoom: resolved.source.source.maxNativeZoom,
                        ...(resolved.source.source.bounds ? { bounds: resolved.source.source.bounds } : {}),
                        ...(resolved.source.kind === 'raster' && resolved.source.source.tileSize
                            ? { tileSize: resolved.source.source.tileSize }
                            : {}),
                    };
                    return {
                        ok: true,
                        bytes: encode(new TextEncoder().encode(JSON.stringify(output))),
                        contentType: 'application/json',
                    };
                }
                const resolved = resolvedSources.get(sourceIdentifier) || saved;
                const cooldown = await privateStore.get<number>(`cooldown:${new URL(primaryEndpoint(resolved.source)).hostname}`);
                if (typeof cooldown === 'number' && cooldown > now()) return failure('budget');
                const url = privateRequestUrl(
                    resolved.source as Parameters<typeof privateRequestUrl>[0],
                    resolved.parameters,
                    requestMessage,
                );
                const key = `${id}:${revision}:${url}`;
                await permission(resolved.source);
                current();
                const cached = cache.get(key);
                if (cached) {
                    cache.delete(key);
                    cache.set(key, cached);
                    return cached.reply;
                }
                // At most four bounded jobs. In-flight duplicate consumers share
                // one actual GET; only completed response bytes are public.
                let flight = flights.get(key);
                if (!flight) {
                    const flightController = new AbortController();
                    const promise = download(
                        resolved.source,
                        resolved.parameters,
                        requestMessage,
                        flightController.signal,
                        grant,
                    ).then((result): CacheReply => {
                        if (flightController.signal.aborted || stamp !== epoch(id, revision)) throw new Error();
                        const reply: CacheReply = { ok: true, bytes: encode(result.bytes), contentType: result.type };
                        while (cacheBytes + result.bytes.length > PRIVATE_LIMITS.responseCache && cache.size) {
                            const oldest = cache.entries().next().value;
                            if (!oldest) break;
                            cache.delete(oldest[0]);
                            cacheBytes -= oldest[1].size;
                        }
                        cache.set(key, { reply, size: result.bytes.length });
                        cacheBytes += result.bytes.length;
                        return reply;
                    }).finally(() => {
                        if (flights.get(key) === flight) flights.delete(key);
                    });
                    flight = { controller: flightController, users: 0, promise };
                    flights.set(key, flight);
                }
                flight.users++;
                let rejectAbort!: (reason?: unknown) => void;
                const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
                const abort = () => rejectAbort(new Error());
                controller.signal.addEventListener('abort', abort, { once: true });
                try {
                    current();
                    const reply = await Promise.race([flight.promise, cancelled]);
                    current();
                    await record(id, revision);
                    await bound(id, revision, sender, false);
                    await permission(resolved.source);
                    current();
                    return reply;
                } finally {
                    controller.signal.removeEventListener('abort', abort);
                    if (--flight.users === 0) flight.controller.abort();
                }
            } finally {
                jobs.delete(jobKey);
            }
        } catch (error) {
            const relayErr = error as RelayError | null | undefined;
            const status = relayErr?.httpStatus;
            return {
                ...failure(relayErr?.relayCode),
                ...(typeof status === 'number' && [401, 403, 404, 410].includes(status) ? { status } : {}),
            };
        }
    };

    return {
        handle: (message: unknown, sender: Sender): Promise<CustomLayerRelayResponse> => {
            const type = (message && typeof message === 'object' ? (message as RelayMessage).type : undefined);
            return typeof type === 'string' && ['CUSTOM_PRIVATE_OPEN', 'CUSTOM_PRIVATE_APPROVE', 'CUSTOM_PRIVATE_REFRESH'].includes(type)
                ? serial(() => handle(message, sender))
                : handle(message, sender);
        },
        forgetTab(tabId: number, closed = true): void {
            for (const [key, item] of pending) {
                if (item.tabId === tabId || (closed && item.accessTab === tabId)) pending.delete(key);
            }
            for (const [key, item] of grants) {
                if (item.tabId === tabId) grants.delete(key);
            }
            for (const [key, job] of jobs) {
                if (key.startsWith(`${tabId}:`)) job.controller.abort();
            }
        },
        revoke(): void {
            revokeEpoch++;
            epochs.clear();
            grants.clear();
            pending.clear();
            resolvedSources.clear();
            cache.clear();
            cacheBytes = 0;
            for (const job of jobs.values()) job.controller.abort();
        },
    };
}

export type CustomLayerRelay = ReturnType<typeof createCustomLayerRelay>;
