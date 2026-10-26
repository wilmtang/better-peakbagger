// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY, readCustomRegistry, readCustomSource, customId } from '../maps/custom-overlay-schema.js';
import { customLayerBackup, readCustomLayerBackup } from '../maps/custom-overlay-transfer.js';
import { storageValue as StorageValue } from '../storage/storage-value.js';
import { readPrivateParameters, publicPrivateSource } from '../maps/custom-overlay-private.js';

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
    const handle = (message, sender) => {
        const mutation = message.type !== 'CUSTOM_OVERLAYS_GET';
        if (!(mutation ? canEdit(sender) || message.type === 'CUSTOM_OVERLAYS_OPACITY' && canRead(sender) : canRead(sender))) return Promise.resolve({ ok: false, error: 'forbidden' });
        const operation = async () => {
            try {
                const current = await read();
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
                    return { ok: true, ...current };
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
                await storage.set({ [CUSTOM_REGISTRY_KEY]: current.registry, [CUSTOM_PREFERENCES_KEY]: current.preferences });
                if (privateStore && message.type === 'CUSTOM_OVERLAYS_SAVE' && current.registry.sources.find(source => source.id === message.id)?.privateRequests) {
                    // Once the public CAS commits, discard previous credentials.
                    // Before that point the prior revision remains recoverable.
                    await privateStore.mutate(message.id, saved => ({ versions: { [message.expectedRevision + 1]: saved.versions[message.expectedRevision + 1] } }));
                }
                if (privateStore && (message.type === 'CUSTOM_OVERLAYS_REMOVE' || message.type === 'CUSTOM_OVERLAYS_SAVE' && !current.registry.sources.find(source => source.id === message.id)?.privateRequests)) await privateStore.put(message.id, null);
                return { ok: true, ...current };
            } catch (error) { return { ok: false, error: error.message }; }
        };
        return transact(operation);
    };
    return { handle, snapshot: () => transact(read), replaceIfCurrent: (expected, next) => transact(async () => {
        const current = await read();
        if (!StorageValue.same(current, expected)) return { replaced: false, current };
        const backup = next?.registry ? customLayerBackup(next) : readCustomLayerBackup(next);
        if (!backup) throw new Error('Invalid custom layers backup.');
        const registry = { schemaVersion: 1, revision: current.registry.revision + 1, generation: (current.registry.generation || 0) + 1,
            sources: backup.sources.map(source => ({ ...source, revision: (current.registry.sources.find(item => item.id === source.id)?.revision || 0) + 1 })) };
        if (!readCustomRegistry(registry)) throw new Error('Invalid custom layers backup.');
        await storage.set({ [CUSTOM_REGISTRY_KEY]: registry, [CUSTOM_PREFERENCES_KEY]: backup.preferences });
        previews.clear(); return { replaced: true, current: { registry, preferences: backup.preferences } };
    }) };
}
