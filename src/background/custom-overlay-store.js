// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY, readCustomRegistry, readCustomSource, customId } from '../maps/custom-overlay-schema.js';
import { customLayerBackup, readCustomLayerBackup, readPrivateLayerFile } from '../maps/custom-overlay-transfer.js';
import { storageValue as StorageValue } from '../storage/storage-value.js';
import { readPrivateParameters, publicPrivateSource } from '../maps/custom-overlay-private.js';

const CLEANUP_KEY = 'bpbCustomOverlayCleanup';

// Public registry ownership. Private credentials and constrained fetches live
// separately in custom-private-store.js and custom-layer-relay.js.
export function createCustomOverlayStore({ storage, canRead, canEdit, canReadPrivate = () => false, privateStore }) {
    let queue = Promise.resolve();
    const previews = new Map();
    const transact = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
    const read = async () => {
        const data = await storage.get([CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY]);
        const registry = readCustomRegistry(data[CUSTOM_REGISTRY_KEY]);
        if (!registry) throw new Error('Saved overlays are unavailable.');
        const preferences = Object.fromEntries(registry.sources.map(source => [source.id,
            Number.isFinite(data[CUSTOM_PREFERENCES_KEY]?.[source.id]) ? Math.max(0, Math.min(100, data[CUSTOM_PREFERENCES_KEY][source.id])) : source.appearance.opacity]));
        return { registry, preferences };
    };
    const cleanupDebt = async (ids = []) => {
        if (!privateStore) return [];
        const saved = (await storage.get([CLEANUP_KEY]))[CLEANUP_KEY] || [];
        if (!Array.isArray(saved) || saved.some(id => !customId(id))) throw new Error('Private layer cleanup is unavailable.');
        const next = [...new Set([...saved, ...ids])];
        if (next.length > 128) throw new Error('Private layer cleanup is unavailable. Try again after reopening Settings.');
        return next;
    };
    // Cleanup is bookkeeping after an authoritative public commit. Persist
    // its bounded ID-only debt with that commit so worker suspension cannot
    // lose it. Retries follow the current registry, never an old saved revision.
    const reconcileCleanup = async current => {
        if (!privateStore) return false;
        try {
            const pending = await cleanupDebt(), remaining = [];
            for (const id of pending) {
                try {
                    const source = current.registry.sources.find(item => item.id === id);
                    if (source?.privateRequests) await privateStore.mutate(id, saved => {
                        const keep = saved?.versions?.[source.revision];
                        return keep ? { versions: { [source.revision]: keep } } : null;
                    });
                    else await privateStore.put(id, null);
                } catch { remaining.push(id); }
            }
            if (pending.length !== remaining.length) await storage.set({ [CLEANUP_KEY]: remaining });
            return remaining.length > 0;
        } catch { return true; }
    };
    const readFileSnapshot = async () => {
        const current = await read();current.privateSources = [];
        for (const source of current.registry.sources) {
            if (!source.privateRequests) continue;
            const saved = (await privateStore?.get(source.id))?.versions?.[source.revision];
            // A descriptor imported from an older/remote backup may have no
            // private definition on this device and remains reconnect-only.
            if (!saved) continue;
            if (!StorageValue.same(saved.public, source)) throw new Error('Private layer configuration is unavailable.');
            current.privateSources.push({ source: saved.source, parameters: saved.parameters });
        }
        if (!readPrivateLayerFile(current.privateSources, customLayerBackup(current))) throw new Error('Private layer configuration is unavailable.');
        return current;
    };
    const handle = (message, sender) => {
        const mutation = message.type !== 'CUSTOM_OVERLAYS_GET';
        if (!(mutation ? canEdit(sender) || message.type === 'CUSTOM_OVERLAYS_OPACITY' && canRead(sender) : canRead(sender))) return Promise.resolve({ ok: false, error: 'forbidden' });
        const operation = async () => {
            try {
                const current = await read();
                const cleanupPending = await reconcileCleanup(current);
                const mapKey = `${sender.tab?.id}:${message.mapId}`;
                if (!mutation) {
                    const preview = previews.get(mapKey);
                    if (preview?.expires > Date.now()) current.registry.sources = [...current.registry.sources.filter(source => source.id !== preview.source.id), preview.source];
                    else previews.delete(mapKey);
                    if (privateStore && await canReadPrivate(sender)) current.registry.sources = await Promise.all(current.registry.sources.map(async source => {
                        if (!source.privateRequests) return source;
                        const saved = (await privateStore.get(source.id))?.versions?.[source.revision];
                        return saved && StorageValue.same(saved.public, source) ? { ...source, editSource: saved.source, requestParameters: saved.parameters }
                            : { ...source, reconnect: true, requestParameters: [] };
                    }));
                    return { ok: true, ...current, ...(cleanupPending && { cleanupPending: true }) };
                }
                if (message.type === 'CUSTOM_OVERLAYS_PREVIEW') {
                    if (typeof message.mapId !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(message.mapId)) throw new Error('Invalid map.');
                    for (const [key, entry] of previews) if (entry.expires <= Date.now()) previews.delete(key);
                    if (message.source == null) previews.delete(mapKey);
                    else {
                        const source = readCustomSource(message.source); if (!source || previews.size >= 32 || current.registry.sources.length >= 20 && !current.registry.sources.some(item => item.id === source.id)) throw new Error('Invalid preview.');
                        previews.set(mapKey, { source, expires: Date.now() + 300000 });
                    }
                    return { ok: true };
                }
                if (message.type === 'CUSTOM_OVERLAYS_OPACITY') {
                    if (!customId(message.id) || !current.registry.sources.some(source => source.id === message.id)
                        || !Number.isFinite(message.opacity) || message.opacity < 0 || message.opacity > 100) throw new Error('Invalid opacity.');
                    current.preferences[message.id] = message.opacity;
                    await storage.set({ [CUSTOM_PREFERENCES_KEY]: current.preferences });
                    return { ok: true, ...current };
                }
                if (message.type === 'CUSTOM_OVERLAYS_REORDER') {
                    const ids = message.ids;
                    if (message.expectedRevision !== current.registry.revision) throw new Error('The layer list changed. Try reordering again.');
                    if (!Array.isArray(ids) || ids.length !== current.registry.sources.length || new Set(ids).size !== ids.length
                        || ids.some(id => !current.registry.sources.some(source => source.id === id))) throw new Error('Invalid layer order.');
                    current.registry.sources = ids.map(id => current.registry.sources.find(source => source.id === id));
                    current.registry.revision++;
                    if (!readCustomRegistry(current.registry)) throw new Error('Layer order could not be saved.');
                    await storage.set({ [CUSTOM_REGISTRY_KEY]: current.registry });
                    return { ok: true, ...current };
                }
                const cleanup = await cleanupDebt([message.id]);
                const index = current.registry.sources.findIndex(source => source.id === message.id);
                if (index >= 0 ? current.registry.sources[index].revision !== message.expectedRevision : message.expectedRevision !== 0) throw new Error('This overlay changed. Reload its settings.');
                if (message.type === 'CUSTOM_OVERLAYS_REMOVE') {
                    if (index < 0) throw new Error('Overlay no longer exists.');
                    current.registry.sources.splice(index, 1); delete current.preferences[message.id];
                } else if (message.type === 'CUSTOM_OVERLAYS_SAVE') {
                    let source = readCustomSource({ ...message.source, id: message.id, revision: message.expectedRevision + 1, privateRequests: false });
                    if (!source) throw new Error('Check the source settings.');
                    const parameters = readPrivateParameters(message.requestParameters || []);
                    if (parameters.length || current.registry.sources[index]?.privateRequests) {
                        if (!Array.isArray(message.requestParameters)) throw new Error('Open Settings to review this private source.');
                        if (!await canReadPrivate(sender)) throw new Error('Open BPB Settings to edit private parameters.');
                        if (!privateStore) throw new Error('Private layer storage is unavailable.');
                        const projected = publicPrivateSource(source);
                        // Store secrets first. A failed public write leaves an
                        // unreachable private revision; reads fail closed.
                        await privateStore.mutate(source.id, previous => ({ versions: {
                            ...(current.registry.sources[index]?.privateRequests && previous?.versions?.[message.expectedRevision]
                                ? { [message.expectedRevision]: previous.versions[message.expectedRevision] } : {}),
                            [source.revision]: { source, parameters, public: projected },
                        } }));
                        source = projected;
                    } else if (source.source.dataUrl?.includes('relay.bpb.example') || source.source.tiles?.some(url => url.includes('relay.bpb.example'))) {
                        throw new Error('Reconnect this layer with its provider URL.');
                    }
                    if (index < 0) current.registry.sources.push(source); else current.registry.sources[index] = source;
                } else throw new Error('Unknown overlay operation.');
                current.registry.revision++;
                if (!readCustomRegistry(current.registry)) throw new Error('Overlay library is full.');
                await storage.set({ [CUSTOM_REGISTRY_KEY]: current.registry, [CUSTOM_PREFERENCES_KEY]: current.preferences,
                    ...(privateStore && { [CLEANUP_KEY]: cleanup }) });
                const pending = await reconcileCleanup(current);
                return { ok: true, ...current, ...(pending && { cleanupPending: true }) };
            } catch (error) { return { ok: false, error: error.message }; }
        };
        return transact(operation);
    };
    return { handle, snapshot: ({ includePrivate = false } = {}) => transact(async () => {
        const current = await read(); await reconcileCleanup(current);
        return includePrivate ? readFileSnapshot() : current;
    }), replaceIfCurrent: (expected, next) => transact(async () => {
        const includePrivate = Object.hasOwn(expected, 'privateSources');
        const current = await (includePrivate ? readFileSnapshot() : read());
        await reconcileCleanup(current);
        if (!StorageValue.same(current, expected)) return { replaced: false, current };
        const backup = next?.registry ? customLayerBackup(next) : readCustomLayerBackup(next);
        if (!backup) throw new Error('Invalid custom layers backup.');
        const privateSources = readPrivateLayerFile(next.privateSources || [], backup);
        if (!privateSources || privateSources.length && !privateStore) throw new Error('Invalid private layer settings.');
        const registry = { schemaVersion: 1, revision: current.registry.revision + 1, generation: (current.registry.generation || 0) + 1,
            sources: backup.sources.map(source => ({ ...source, revision: (current.registry.sources.find(item => item.id === source.id)?.revision || 0) + 1 })) };
        const installedPrivate = [];
        // Write the next private revision before publishing its descriptor.
        // Keep the old revision until the public write commits so failures
        // cannot disable the previously saved source or expose its key.
        for (const entry of privateSources) {
            const index = registry.sources.findIndex(source => source.id === entry.source.id);
            const source = { ...entry.source, revision: registry.sources[index].revision }, projected = publicPrivateSource(source);
            await privateStore.mutate(source.id, previous => ({ versions: { ...previous?.versions,
                [source.revision]: { source, parameters: entry.parameters, public: projected } } }));
            registry.sources[index] = projected;
            installedPrivate.push({ source, parameters: entry.parameters });
        }
        if (!readCustomRegistry(registry)) throw new Error('Invalid custom layers backup.');
        const cleanup = await cleanupDebt([...current.registry.sources, ...registry.sources].map(source => source.id));
        await storage.set({ [CUSTOM_REGISTRY_KEY]: registry, [CUSTOM_PREFERENCES_KEY]: backup.preferences,
            ...(privateStore && { [CLEANUP_KEY]: cleanup }) });
        previews.clear();
        const cleanupPending = await reconcileCleanup({ registry });
        return { replaced: true, current: { registry, preferences: backup.preferences, ...(includePrivate && { privateSources: installedPrivate }) }, ...(cleanupPending && { cleanupPending: true }) };
    }) };
}
