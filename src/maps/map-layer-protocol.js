// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { readWildfireRecords } from './wildfire-core.js';
import { sentinelTarget } from './sentinel-core.js';

const text = (value, limit = 400) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
export const readLandCooldowns = value => Object.fromEntries(['us', 'bc', 'ab'].filter(key => Number.isFinite(value?.[key])
    && value[key] > Date.now() && value[key] <= Date.now() + 86400000).map(key => [key, value[key]]));
export const mergeLandCooldowns = (current, incoming) => {
    const merged = readLandCooldowns(current);
    for (const [key, deadline] of Object.entries(readLandCooldowns(incoming))) merged[key] = Math.max(merged[key] || 0, deadline);
    return merged;
};
export function readLayerSnapshot(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    const cooldowns = Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id,
        Number.isFinite(value.cooldowns?.[id]) && value.cooldowns[id] > Date.now() && value.cooldowns[id] <= Date.now() + 86400000 ? value.cooldowns[id] : 0]));
    return { revision: value.revision, state: Schema.mapOverlayState(value.state), capture: sentinelTarget(value.capture), menuOpen: value.menuOpen === true, cooldowns,
        landCooldowns: readLandCooldowns(value.landCooldowns), landTypes: Schema.mapLandTypes(value.landTypes) };
}
export function readLayerStatus(value) {
    if (!value || !Schema.MAP_OVERLAY_IDS.includes(value.id)) return null;
    return { id: value.id, revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
        pending: value.pending === true,
        ...(value.id === 'wildfire' ? { count: Number.isInteger(value.count) && value.count >= 0 && value.count <= 4000 ? value.count : 0,
            saved: value.saved === true, overflow: value.overflow === true, fires: readWildfireRecords(value.fires),
            loadedAt: Number.isFinite(value.loadedAt) && value.loadedAt > 0 && value.loadedAt <= Date.now() + 300000 ? value.loadedAt : 0 } : {}), capturePending: value.id === 'sentinel' && value.capturePending === true,
        error: value.error === true, partial: value.id !== 'snotel' && value.partial === true,
        captureError: value.id === 'sentinel' && value.captureError === true,
        providerCooldowns: value.id === 'land' ? readLandCooldowns(value.providerCooldowns) : {},
        retry: value.retry === true, permission: value.id === 'land' && value.permission === true,
        retryAt: Number.isFinite(value.retryAt) && value.retryAt > Date.now() && value.retryAt <= Date.now() + 86400000 ? value.retryAt : 0,
        message: text(value.message), capture: text(value.capture, 120), target: sentinelTarget(value.target),
        captures: Array.isArray(value.captures) ? value.captures.slice(0, 100).map(choice => ({ id: text(choice?.id, 120), label: text(choice?.label, 180), title: text(choice?.title, 180) })) : undefined };
}
export function readBasemapChoices(value) {
    if (!Array.isArray(value) || value.length > 100) return [];
    return value.filter(choice => typeof choice?.id === 'string' && choice.id.length <= 80 && typeof choice.label === 'string')
        .map(choice => ({ id: choice.id, label: text(choice.label, 180), disabled: choice.disabled === true }));
}
