// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settingsSchema as Schema } from '../settings/settings-schema.js';
import { sentinelTarget } from './sentinel-core.js';

const text = (value, limit = 400) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
export function readLayerSnapshot(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    const cooldowns = Object.fromEntries(Schema.MAP_OVERLAY_IDS.map(id => [id,
        Number.isFinite(value.cooldowns?.[id]) && value.cooldowns[id] > Date.now() && value.cooldowns[id] <= Date.now() + 86400000 ? value.cooldowns[id] : 0]));
    return { revision: value.revision, state: Schema.mapOverlayState(value.state), capture: sentinelTarget(value.capture), menuOpen: value.menuOpen === true, cooldowns };
}
export function readLayerStatus(value) {
    if (!value || !Schema.MAP_OVERLAY_IDS.includes(value.id)) return null;
    return { id: value.id, revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
        pending: value.pending === true, error: value.error === true, retry: value.retry === true,
        retryAt: Number.isFinite(value.retryAt) && value.retryAt > Date.now() && value.retryAt <= Date.now() + 86400000 ? value.retryAt : 0,
        message: text(value.message), capture: text(value.capture, 120), target: sentinelTarget(value.target),
        captures: Array.isArray(value.captures) ? value.captures.slice(0, 100).map(choice => ({ id: text(choice?.id, 120), label: text(choice?.label, 180), title: text(choice?.title, 180) })) : undefined };
}
export function readBasemapChoices(value) {
    if (!Array.isArray(value) || value.length > 100) return [];
    return value.filter(choice => typeof choice?.id === 'string' && choice.id.length <= 80 && typeof choice.label === 'string')
        .map(choice => ({ id: choice.id, label: text(choice.label, 180), disabled: choice.disabled === true }));
}
