// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { readWildfireRecords } from './wildfire-core.js';
import { sentinelTarget } from './sentinel-core.js';

type Fields = Record<string, unknown>;
const finite = (value: unknown): value is number => Number.isFinite(value);
const text = (value: unknown, limit = 400) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
export const readAttributionInset = (value: unknown) => finite(value) && value >= 0 && value <= 1 ? value : 0;
const cooldownEntry = (value: unknown) => finite(value) && value > Date.now() && value <= Date.now() + 86400000 ? value : 0;
export const readLandCooldowns = (input: unknown): Record<string, number> => {
    const value = input as Fields | null | undefined;
    return Object.fromEntries(['us', 'bc', 'ab'].filter(key => cooldownEntry(value?.[key])).map(key => [key, value?.[key] as number]));
};
export const mergeLandCooldowns = (current: unknown, incoming: unknown) => {
    const merged = readLandCooldowns(current);
    for (const [key, deadline] of Object.entries(readLandCooldowns(incoming))) merged[key] = Math.max(merged[key] || 0, deadline);
    return merged;
};
export function readLayerSnapshot(input: unknown) {
    const value = input as (Fields & { revision: number; cooldowns?: Fields; customOpacity?: Record<string, number>; customReloads?: Record<string, number> }) | null | undefined;
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    const cooldowns = Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id,
        cooldownEntry(value.cooldowns?.[id])]));
    return { revision: value.revision, state: Schema.mapOverlayState(value.state), capture: sentinelTarget(value.capture), menuOpen: value.menuOpen === true, cooldowns,
        landCooldowns: readLandCooldowns(value.landCooldowns), landTypes: Schema.mapLandTypes(value.landTypes), custom: Schema.customOverlay.selection(value.custom),
        customSession: typeof value.customSession === 'string' && /^[a-z0-9-]{1,80}$/i.test(value.customSession) ? value.customSession : '',
        customRevision: Number.isSafeInteger(value.customRevision) ? value.customRevision : 0,
        customOpacity: Object.fromEntries(Schema.customOverlay.selection(value.custom).filter(item => Number.isFinite(value.customOpacity?.[item.id]) && value.customOpacity![item.id]! >= 0 && value.customOpacity![item.id]! <= 100).map(item => [item.id, value.customOpacity![item.id]!])),
        customReloads: Object.fromEntries(Schema.customOverlay.selection(value.custom).map(item => [item.id, Number.isSafeInteger(value.customReloads?.[item.id]) ? value.customReloads![item.id]! : 0])) };
}
export function readLayerStatus(input: unknown) {
    const value = input as (Fields & { id: string; count: number; revision: number; loadedAt: number; retryAt: number }) | null | undefined;
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
        retryAt: cooldownEntry(value.retryAt),
        message: text(value.message), capture: text(value.capture, 120), target: sentinelTarget(value.target),
        captures: Array.isArray(value.captures) ? value.captures.slice(0, 100).map((choice: Fields | null | undefined) => ({ id: text(choice?.id, 120), label: text(choice?.label, 180), title: text(choice?.title, 180) })) : undefined };
}
export function readBasemapChoices(value: unknown) {
    if (!Array.isArray(value) || value.length > 100) return [];
    return value.filter(choice => typeof choice?.id === 'string' && choice.id.length <= 80 && typeof choice.label === 'string')
        .map(choice => ({ id: choice.id, label: text(choice.label, 180), disabled: choice.disabled === true }));
}
