// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { customTileAt, type CustomClient } from './custom-overlay-client.ts';
import type { CustomSource } from './custom-overlay-schema.ts';

export interface CustomProbeView {
    center?: { lat: number; lng: number } | null;
    zoom: number;
}

export type CustomProbeMode = '2D' | '3D';

export interface CustomProbeClient {
    tile: CustomClient['tile'];
}

export interface CustomProbeResult {
    message: string;
}

// Sampling is explicit, local to the visible area and never infers global coverage.
export async function probeCustomSource(
    client: CustomProbeClient,
    source: CustomSource,
    view: CustomProbeView | null | undefined,
    signal: AbortSignal | null | undefined,
    mode: CustomProbeMode,
): Promise<CustomProbeResult> {
    if (!view?.center || source.kind === 'geojson') throw new Error('Choose a visible map to test tiles.');
    const size = source.kind === 'raster' ? source.source.tileSize : 512;
    const zoom = view.zoom + (mode === '3D' ? size === 256 ? 1 : 0 : size === 512 ? -1 : 0);
    const z = Math.max(source.source.minNativeZoom, Math.min(source.source.maxNativeZoom, Math.floor(zoom)));
    const levels = [...new Set([z, z - 1, z + 1, source.source.minNativeZoom, source.source.maxNativeZoom, z + 2])]
        .filter(level => level >= source.source.minNativeZoom && level <= source.source.maxNativeZoom).slice(0, 6);
    const results: string[] = [];
    for (const level of levels) {
        try {
            const tile = await client.tile(source, customTileAt(view.center.lat, view.center.lng, level), signal, false);
            tile.image?.close();
            results.push(`${level}: ${tile.features?.length === 0 ? 'valid empty tile' : 'loaded'}`);
        } catch (error) {
            const detail = (error && typeof error === 'object' ? error : null) as { code?: unknown; name?: unknown; status?: unknown } | null;
            if (detail?.code === 'access' || detail?.code === 'rate-limit' || detail?.name === 'AbortError') throw error;
            results.push(`${level}: ${typeof detail?.status === 'number' && [404, 410].includes(detail.status) ? 'not found' : 'could not check'}`);
        }
    }
    return { message: `This area (${mode}): ${results.join('; ')}. Other zooms and locations remain unchecked.` };
}
