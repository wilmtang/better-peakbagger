// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUSTOM_REGISTRY_KEY, CUSTOM_PREFERENCES_KEY, readCustomRegistry, readCustomSource, customId } from '../maps/custom-overlay-schema.js';

// The worker owns configuration only. There is deliberately no provider-fetch route.
export function createCustomOverlayStore({ storage, canRead, canEdit }) {
    let queue = Promise.resolve();
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
                if (!mutation) return { ok: true, ...current };
                if (message.type === 'CUSTOM_OVERLAYS_OPACITY') {
                    if (!customId(message.id) || !current.registry.sources.some(source => source.id === message.id)
                        || !Number.isFinite(message.opacity) || message.opacity < 0 || message.opacity > 100) throw new Error('Invalid opacity.');
                    current.preferences[message.id] = message.opacity;
                    await storage.set({ [CUSTOM_PREFERENCES_KEY]: current.preferences });
                    return { ok: true, ...current };
                }
                const index = current.registry.sources.findIndex(source => source.id === message.id);
                if (index >= 0 ? current.registry.sources[index].revision !== message.expectedRevision : message.expectedRevision !== 0) throw new Error('This overlay changed. Reload its settings.');
                if (message.type === 'CUSTOM_OVERLAYS_REMOVE') {
                    if (index < 0) throw new Error('Overlay no longer exists.');
                    current.registry.sources.splice(index, 1); delete current.preferences[message.id];
                } else if (message.type === 'CUSTOM_OVERLAYS_SAVE') {
                    const source = readCustomSource({ ...message.source, id: message.id, revision: message.expectedRevision + 1 });
                    if (!source) throw new Error('Check the source settings.');
                    if (index < 0) current.registry.sources.push(source); else current.registry.sources[index] = source;
                } else throw new Error('Unknown overlay operation.');
                current.registry.revision++;
                if (!readCustomRegistry(current.registry)) throw new Error('Overlay library is full.');
                await storage.set({ [CUSTOM_REGISTRY_KEY]: current.registry, [CUSTOM_PREFERENCES_KEY]: current.preferences });
                return { ok: true, ...current };
            } catch (error) { return { ok: false, error: error.message }; }
        };
        const next = queue.then(operation); queue = next.catch(() => {}); return next;
    };
    return { handle };
}
