// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Compatibility boundary for the packaged MapLibre 6 tile managers. Inspect
// live viewport membership, not feature counts: a loaded empty tile is usable,
// as is a cached parent. Offscreen cached tiles must not hide a complete outage.
export function vectorMapAvailability(map) {
    const managers = map?.style?.tileManagers;
    if (!managers || typeof managers !== 'object' || Array.isArray(managers)) throw new Error('Vector tile availability is unsupported.');
    let requested = false, usable = false;
    for (const manager of Object.values(managers)) {
        if (typeof manager?.getIds !== 'function' || typeof manager.getRenderableIds !== 'function') throw new Error('Vector tile availability is unsupported.');
        const ids = manager.getIds(), renderable = manager.getRenderableIds();
        if (!Array.isArray(ids) || !Array.isArray(renderable)) throw new Error('Unexpected vector tile availability.');
        // Failed TileJSON has no tile IDs at all. Only an active source whose
        // metadata never loaded is unavailable here; old tile errors must not
        // turn a later out-of-coverage view into a failure.
        requested ||= ids.length > 0 || manager.used !== false && manager._sourceErrored === true && manager._sourceLoaded !== true;
        usable ||= renderable.length > 0;
    }
    return { requested, usable };
}
