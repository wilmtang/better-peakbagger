// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    CUSTOM_REGISTRY_KEY,
    CUSTOM_PREFERENCES_KEY,
    readCustomRegistry,
    readCustomSource,
    customId,
    type CustomRegistry,
    type CustomSource,
} from '../maps/custom-overlay-schema.ts';
import {
    customLayerBackup,
    readCustomLayerBackup,
    readPrivateLayerFile,
    type CustomLayerSnapshot,
    type PrivateLayerEntry,
} from '../maps/custom-overlay-transfer.ts';
import { storageValue as StorageValue } from '../storage/storage-value.ts';
import {
    readPrivateParameters,
    publicPrivateSource,
    type PrivateParameter,
} from '../maps/custom-overlay-private.ts';

type Sender = chrome.runtime.MessageSender;

const CLEANUP_KEY = 'bpbCustomOverlayCleanup';

export interface PrivateSourceVersion {
    source: CustomSource;
    parameters: PrivateParameter[];
    public: CustomSource;
}

export interface PrivateSourceRecord {
    versions?: Record<number, PrivateSourceVersion>;
}

export interface CustomOverlayStorage {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface CustomOverlayPrivateStore {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<T>;
    mutate<T = unknown, R = T | undefined>(
        key: string,
        mutate: (current: T | undefined) => R,
    ): Promise<R>;
}

export interface CustomOverlayStoreOptions {
    storage: CustomOverlayStorage;
    canRead: (sender: Sender) => boolean;
    canEdit: (sender: Sender) => boolean;
    canReadPrivate?: (sender: Sender) => boolean | Promise<boolean>;
    privateStore?: CustomOverlayPrivateStore | null;
}

export type CustomOverlaySourceView = CustomSource & {
    editSource?: CustomSource;
    requestParameters?: PrivateParameter[];
    reconnect?: boolean;
};

export interface CustomOverlayRegistryView {
    schemaVersion: 1;
    revision: number;
    sources: CustomOverlaySourceView[];
    generation?: number;
}

export interface CustomOverlayCatalog {
    registry: CustomRegistry;
    preferences: Record<string, number>;
    privateSources?: PrivateLayerEntry[];
}

export interface CustomOverlayPrivateSnapshot extends CustomOverlayCatalog {
    privateSources: PrivateLayerEntry[];
}

export type CustomOverlayHandleResult =
    | { ok: false; error: string }
    | {
        ok: true;
        registry?: CustomOverlayRegistryView;
        preferences?: Record<string, number>;
        cleanupPending?: boolean;
    };

export interface CustomOverlayReplaceResult {
    replaced: boolean;
    current: CustomOverlayCatalog;
    cleanupPending?: boolean;
}

interface OverlayMessage {
    type?: unknown;
    mapId?: unknown;
    source?: unknown;
    id?: unknown;
    opacity?: unknown;
    ids?: unknown;
    expectedRevision?: unknown;
    requestParameters?: unknown;
}

// Public registry ownership. Private credentials and constrained fetches live
// separately in custom-private-store.ts and custom-layer-relay.ts.
export function createCustomOverlayStore({
    storage,
    canRead,
    canEdit,
    canReadPrivate = () => false,
    privateStore,
}: CustomOverlayStoreOptions) {
    let queue: Promise<void> = Promise.resolve();
    const previews = new Map<string, { source: CustomSource; expires: number }>();
    const transact = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = queue.then(operation);
        queue = next.then(() => {}, () => {});
        return next;
    };
    const read = async (): Promise<CustomOverlayCatalog> => {
        const data = await storage.get([CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY]);
        const registry = readCustomRegistry(data[CUSTOM_REGISTRY_KEY]);
        if (!registry) throw new Error('Saved overlays are unavailable.');
        const rawPrefs = data[CUSTOM_PREFERENCES_KEY];
        const prefMap = rawPrefs && typeof rawPrefs === 'object' && !Array.isArray(rawPrefs)
            ? (rawPrefs as Record<string, unknown>)
            : undefined;
        const preferences = Object.fromEntries(registry.sources.map(source => {
            const value = prefMap?.[source.id];
            return [
                source.id,
                typeof value === 'number' && Number.isFinite(value)
                    ? Math.max(0, Math.min(100, value))
                    : source.appearance.opacity,
            ];
        }));
        return { registry, preferences };
    };
    const cleanupDebt = async (ids: string[] = []): Promise<string[]> => {
        if (!privateStore) return [];
        const saved = (await storage.get([CLEANUP_KEY]))[CLEANUP_KEY] || [];
        if (!Array.isArray(saved) || saved.some((id): boolean => !customId(id))) {
            throw new Error('Private layer cleanup is unavailable.');
        }
        const next = [...new Set([...(saved as string[]), ...ids])];
        if (next.length > 128) throw new Error('Private layer cleanup is unavailable. Try again after reopening Settings.');
        return next;
    };
    // Cleanup is bookkeeping after an authoritative public commit. Persist
    // its bounded ID-only debt with that commit so worker suspension cannot
    // lose it. Retries follow the current registry, never an old saved revision.
    const reconcileCleanup = async (current: Pick<CustomOverlayCatalog, 'registry'>): Promise<boolean> => {
        if (!privateStore) return false;
        try {
            const pending = await cleanupDebt();
            const remaining: string[] = [];
            for (const id of pending) {
                try {
                    const source = current.registry.sources.find(item => item.id === id);
                    if (source?.privateRequests) {
                        await privateStore.mutate<PrivateSourceRecord, PrivateSourceRecord | null>(id, saved => {
                            const keep = saved?.versions?.[source.revision];
                            return keep ? { versions: { [source.revision]: keep } } : null;
                        });
                    } else {
                        await privateStore.put(id, null);
                    }
                } catch {
                    remaining.push(id);
                }
            }
            if (pending.length !== remaining.length) await storage.set({ [CLEANUP_KEY]: remaining });
            return remaining.length > 0;
        } catch {
            return true;
        }
    };
    const readFileSnapshot = async (): Promise<CustomOverlayPrivateSnapshot> => {
        const base = await read();
        const privateSources: PrivateLayerEntry[] = [];
        for (const source of base.registry.sources) {
            if (!source.privateRequests) continue;
            const saved = (await privateStore?.get<PrivateSourceRecord>(source.id))?.versions?.[source.revision];
            // A descriptor imported from an older/remote backup may have no
            // private definition on this device and remains reconnect-only.
            if (!saved) continue;
            if (!StorageValue.same(saved.public, source)) throw new Error('Private layer configuration is unavailable.');
            privateSources.push({ source: saved.source, parameters: saved.parameters });
        }
        const current: CustomOverlayPrivateSnapshot = { ...base, privateSources };
        if (!readPrivateLayerFile(current.privateSources, customLayerBackup(current))) {
            throw new Error('Private layer configuration is unavailable.');
        }
        return current;
    };
    const handle = (message: unknown, sender: Sender): Promise<CustomOverlayHandleResult> => {
        const msg = (message && typeof message === 'object' ? message : {}) as OverlayMessage;
        const mutation = msg.type !== 'CUSTOM_OVERLAYS_GET';
        if (!(mutation ? canEdit(sender) || (msg.type === 'CUSTOM_OVERLAYS_OPACITY' && canRead(sender)) : canRead(sender))) {
            return Promise.resolve({ ok: false, error: 'forbidden' });
        }
        const operation = async (): Promise<CustomOverlayHandleResult> => {
            try {
                const current = await read();
                const cleanupPending = await reconcileCleanup(current);
                const mapKey = `${sender?.tab?.id}:${String(msg.mapId)}`;
                if (!mutation) {
                    const preview = previews.get(mapKey);
                    if (preview && preview.expires > Date.now()) {
                        current.registry.sources = [
                            ...current.registry.sources.filter(source => source.id !== preview.source.id),
                            preview.source,
                        ];
                    } else {
                        previews.delete(mapKey);
                    }
                    let sources: CustomOverlaySourceView[] = current.registry.sources;
                    if (privateStore && await canReadPrivate(sender)) {
                        sources = await Promise.all(current.registry.sources.map(async (source): Promise<CustomOverlaySourceView> => {
                            if (!source.privateRequests) return source;
                            const saved = (await privateStore.get<PrivateSourceRecord>(source.id))?.versions?.[source.revision];
                            return saved && StorageValue.same(saved.public, source)
                                ? { ...source, editSource: saved.source, requestParameters: saved.parameters }
                                : { ...source, reconnect: true, requestParameters: [] };
                        }));
                    }
                    return {
                        ok: true,
                        registry: { ...current.registry, sources },
                        preferences: current.preferences,
                        ...(cleanupPending ? { cleanupPending: true } : {}),
                    };
                }
                if (msg.type === 'CUSTOM_OVERLAYS_PREVIEW') {
                    if (typeof msg.mapId !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(msg.mapId)) {
                        throw new Error('Invalid map.');
                    }
                    for (const [key, entry] of previews) {
                        if (entry.expires <= Date.now()) previews.delete(key);
                    }
                    if (msg.source == null) {
                        previews.delete(mapKey);
                    } else {
                        const source = readCustomSource(msg.source);
                        if (!source || previews.size >= 32
                            || (current.registry.sources.length >= 20 && !current.registry.sources.some(item => item.id === source.id))) {
                            throw new Error('Invalid preview.');
                        }
                        previews.set(mapKey, { source, expires: Date.now() + 300000 });
                    }
                    return { ok: true };
                }
                if (msg.type === 'CUSTOM_OVERLAYS_OPACITY') {
                    if (!customId(msg.id) || !current.registry.sources.some(source => source.id === msg.id)
                        || typeof msg.opacity !== 'number' || !Number.isFinite(msg.opacity)
                        || msg.opacity < 0 || msg.opacity > 100) {
                        throw new Error('Invalid opacity.');
                    }
                    current.preferences[msg.id] = msg.opacity;
                    await storage.set({ [CUSTOM_PREFERENCES_KEY]: current.preferences });
                    return { ok: true, ...current };
                }
                if (msg.type === 'CUSTOM_OVERLAYS_REORDER') {
                    const ids = msg.ids;
                    if (msg.expectedRevision !== current.registry.revision) {
                        throw new Error('The layer list changed. Try reordering again.');
                    }
                    const byId = new Map(current.registry.sources.map(source => [source.id, source]));
                    if (!Array.isArray(ids) || ids.length !== current.registry.sources.length || new Set(ids).size !== ids.length
                        || ids.some((id): boolean => typeof id !== 'string' || !byId.has(id))) {
                        throw new Error('Invalid layer order.');
                    }
                    const reordered: CustomSource[] = [];
                    for (const id of ids) {
                        const found = typeof id === 'string' ? byId.get(id) : undefined;
                        if (!found) throw new Error('Invalid layer order.');
                        reordered.push(found);
                    }
                    current.registry.sources = reordered;
                    current.registry.revision++;
                    if (!readCustomRegistry(current.registry)) throw new Error('Layer order could not be saved.');
                    await storage.set({ [CUSTOM_REGISTRY_KEY]: current.registry });
                    return { ok: true, ...current };
                }
                const cleanup = await cleanupDebt(typeof msg.id === 'string' ? [msg.id] : []);
                const index = current.registry.sources.findIndex(source => source.id === msg.id);
                if (index >= 0 ? current.registry.sources[index].revision !== msg.expectedRevision : msg.expectedRevision !== 0) {
                    throw new Error('This overlay changed. Reload its settings.');
                }
                if (msg.type === 'CUSTOM_OVERLAYS_REMOVE') {
                    if (index < 0) throw new Error('Overlay no longer exists.');
                    const removedId = current.registry.sources[index].id;
                    current.registry.sources.splice(index, 1);
                    delete current.preferences[removedId];
                } else if (msg.type === 'CUSTOM_OVERLAYS_SAVE') {
                    const expectedRevision = msg.expectedRevision as number;
                    const rawSource = msg.source && typeof msg.source === 'object' && !Array.isArray(msg.source)
                        ? (msg.source as Record<string, unknown>)
                        : {};
                    const validatedSource = readCustomSource({
                        ...rawSource,
                        id: msg.id,
                        revision: expectedRevision + 1,
                        privateRequests: false,
                    });
                    if (!validatedSource) throw new Error('Check the source settings.');
                    let source: CustomSource = validatedSource;
                    const parameters = readPrivateParameters(msg.requestParameters || []);
                    if (parameters.length || current.registry.sources[index]?.privateRequests) {
                        if (!Array.isArray(msg.requestParameters)) throw new Error('Open Settings to review this private source.');
                        if (!await canReadPrivate(sender)) throw new Error('Open BPB Settings to edit private parameters.');
                        if (!privateStore) throw new Error('Private layer storage is unavailable.');
                        const projected = publicPrivateSource(source as Parameters<typeof publicPrivateSource>[0]) as unknown as CustomSource;
                        // Store secrets first. A failed public write leaves an
                        // unreachable private revision; reads fail closed.
                        await privateStore.mutate<PrivateSourceRecord, PrivateSourceRecord>(source.id, previous => ({
                            versions: {
                                ...(current.registry.sources[index]?.privateRequests && previous?.versions?.[expectedRevision]
                                    ? { [expectedRevision]: previous.versions[expectedRevision] }
                                    : {}),
                                [source.revision]: { source, parameters, public: projected },
                            },
                        }));
                        source = projected;
                    } else if (source.kind === 'geojson'
                        ? source.source.dataUrl.includes('relay.bpb.example')
                        : source.source.tiles.some(url => url.includes('relay.bpb.example'))) {
                        throw new Error('Reconnect this layer with its provider URL.');
                    }
                    if (index < 0) current.registry.sources.push(source);
                    else current.registry.sources[index] = source;
                } else {
                    throw new Error('Unknown overlay operation.');
                }
                current.registry.revision++;
                if (!readCustomRegistry(current.registry)) throw new Error('Overlay library is full.');
                await storage.set({
                    [CUSTOM_REGISTRY_KEY]: current.registry,
                    [CUSTOM_PREFERENCES_KEY]: current.preferences,
                    ...(privateStore ? { [CLEANUP_KEY]: cleanup } : {}),
                });
                const pending = await reconcileCleanup(current);
                return { ok: true, ...current, ...(pending ? { cleanupPending: true } : {}) };
            } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        };
        return transact(operation);
    };
    return {
        handle,
        snapshot: ({ includePrivate = false }: { includePrivate?: boolean } = {}): Promise<CustomOverlayCatalog> =>
            transact(async () => {
                const current = await read();
                await reconcileCleanup(current);
                return includePrivate ? readFileSnapshot() : current;
            }),
        replaceIfCurrent: (expected: unknown, next: unknown): Promise<CustomOverlayReplaceResult> =>
            transact(async () => {
                const includePrivate = !!expected && typeof expected === 'object' && Object.hasOwn(expected, 'privateSources');
                const current = await (includePrivate ? readFileSnapshot() : read());
                await reconcileCleanup(current);
                if (!StorageValue.same(current, expected)) return { replaced: false, current };
                const nextRecord = (next && typeof next === 'object' && !Array.isArray(next) ? next : null) as {
                    registry?: CustomLayerSnapshot['registry'];
                    preferences?: Record<string, unknown>;
                    privateSources?: unknown;
                } | null;
                const backup = nextRecord?.registry
                    ? customLayerBackup(nextRecord as CustomLayerSnapshot)
                    : readCustomLayerBackup(next);
                if (!backup) throw new Error('Invalid custom layers backup.');
                const privateSources = readPrivateLayerFile(nextRecord?.privateSources || [], backup);
                if (!privateSources || (privateSources.length > 0 && !privateStore)) {
                    throw new Error('Invalid private layer settings.');
                }
                const registry: CustomRegistry = {
                    schemaVersion: 1,
                    revision: current.registry.revision + 1,
                    generation: (current.registry.generation || 0) + 1,
                    sources: backup.sources.map(source => ({
                        ...source,
                        revision: (current.registry.sources.find(item => item.id === source.id)?.revision || 0) + 1,
                    })),
                };
                const installedPrivate: PrivateLayerEntry[] = [];
                // Write the next private revision before publishing its descriptor.
                // Keep the old revision until the public write commits so failures
                // cannot disable the previously saved source or expose its key.
                if (privateSources.length) {
                    if (!privateStore) throw new Error('Invalid private layer settings.');
                    for (const entry of privateSources) {
                        const index = registry.sources.findIndex(source => source.id === entry.source.id);
                        if (index < 0) throw new Error('Invalid private layer settings.');
                        const source: CustomSource = { ...entry.source, revision: registry.sources[index].revision };
                        const projected = publicPrivateSource(source as Parameters<typeof publicPrivateSource>[0]) as unknown as CustomSource;
                        await privateStore.mutate<PrivateSourceRecord, PrivateSourceRecord>(source.id, previous => ({
                            versions: {
                                ...previous?.versions,
                                [source.revision]: { source, parameters: entry.parameters, public: projected },
                            },
                        }));
                        registry.sources[index] = projected;
                        installedPrivate.push({ source, parameters: entry.parameters });
                    }
                }
                if (!readCustomRegistry(registry)) throw new Error('Invalid custom layers backup.');
                const cleanup = await cleanupDebt([...current.registry.sources, ...registry.sources].map(source => source.id));
                await storage.set({
                    [CUSTOM_REGISTRY_KEY]: registry,
                    [CUSTOM_PREFERENCES_KEY]: backup.preferences,
                    ...(privateStore ? { [CLEANUP_KEY]: cleanup } : {}),
                });
                previews.clear();
                const cleanupPending = await reconcileCleanup({ registry });
                return {
                    replaced: true,
                    current: {
                        registry,
                        preferences: backup.preferences,
                        ...(includePrivate ? { privateSources: installedPrivate } : {}),
                    },
                    ...(cleanupPending ? { cleanupPending: true } : {}),
                };
            }),
    };
}

export type CustomOverlayStore = ReturnType<typeof createCustomOverlayStore>;
