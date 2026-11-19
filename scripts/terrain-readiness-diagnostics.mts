/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */

export interface TerrainLifecycleEntry {
    time: number;
    type: string;
    dir?: unknown;
    reason?: unknown;
}

interface TerrainLifecycleEventData {
    __bpbTerrain?: unknown;
    __bpbTerrainFrame?: unknown;
    type?: unknown;
    dir?: unknown;
    reason?: unknown;
}

interface TerrainTestMap {
    getCanvas(): HTMLCanvasElement;
    loaded(): boolean;
    isStyleLoaded(): boolean;
    isMoving(): boolean;
    areTilesLoaded(): boolean;
    getZoom(): number;
    getLayer(id: string): unknown;
    getStyle(): { sources?: Record<string, unknown> } | undefined;
    isSourceLoaded(id: string): boolean;
}

export interface TerrainReadinessReport {
    url: string;
    visibility: DocumentVisibilityState;
    toggle: {
        text: string | null;
        title: string;
        disabled: boolean;
    } | null;
    frame: { opacity: string } | null;
    lifecycle: TerrainLifecycleEntry[];
    surface?: {
        readyState: DocumentReadyState | undefined;
        theme: string | undefined;
        canvas: { width: number; height: number } | null;
        renderer: string | null;
        contextLost: boolean | undefined;
    };
    map?: {
        loaded: boolean;
        styleLoaded: boolean;
        moving: boolean;
        tilesLoaded: boolean;
        zoom: number;
        layers: string[];
        sources: Record<string, boolean>;
    } | null;
    probeError?: string;
}

type TerrainDiagnosticsGlobal = typeof globalThis & {
    __bpbTerrainLifecycle?: TerrainLifecycleEntry[];
    addEventListener(type: string, listener: (event: MessageEvent<TerrainLifecycleEventData | undefined>) => void): void;
};

export function installTerrainLifecycleProbe(): void {
    const target = globalThis as TerrainDiagnosticsGlobal;
    target.__bpbTerrainLifecycle = [];
    target.addEventListener('message', (event: MessageEvent<TerrainLifecycleEventData | undefined>) => {
        const data = event.data;
        if (!(data?.__bpbTerrain || data?.__bpbTerrainFrame)
            || typeof data.type !== 'string'
            || !['init', 'ready', 'loaded', 'error', 'destroy', 'destroyed', 'resume'].includes(data.type)) return;
        target.__bpbTerrainLifecycle!.push({
            time: Math.round(performance.now()), type: data.type,
            dir: data.dir, reason: data.reason,
        });
        if (target.__bpbTerrainLifecycle!.length > 40) target.__bpbTerrainLifecycle!.shift();
    });
}

// Self-contained so CDP and Playwright can evaluate the same probe in the page.
// Only read state: a timeout must not reset the map or conceal the failed view.
export function readTerrainReadiness(): TerrainReadinessReport {
    const frame = document.getElementById('bpb-terrain-frame') as HTMLIFrameElement | null;
    const toggle = document.getElementById('bpb-terrain-toggle') as HTMLButtonElement | null;
    const result: TerrainReadinessReport = {
        url: document.URL,
        visibility: document.visibilityState,
        toggle: toggle ? {
            text: toggle.textContent, title: toggle.title, disabled: toggle.disabled,
        } : null,
        frame: frame ? { opacity: frame.style.opacity } : null,
        lifecycle: (globalThis as TerrainDiagnosticsGlobal).__bpbTerrainLifecycle || [],
    };
    try {
        const doc = frame?.contentDocument;
        const map = (frame?.contentWindow as (Window & { __bpbTerrainTestMap?: TerrainTestMap }) | null | undefined)?.__bpbTerrainTestMap;
        const surface = doc?.getElementById('bpb-terrain-map');
        const canvas = map?.getCanvas();
        const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        result.surface = {
            readyState: doc?.readyState,
            theme: surface?.dataset.theme,
            canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
            renderer: gl ? gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as string | null : null,
            contextLost: gl?.isContextLost(),
        };
        result.map = map ? {
            loaded: map.loaded(), styleLoaded: map.isStyleLoaded(), moving: map.isMoving(),
            tilesLoaded: map.areTilesLoaded(), zoom: map.getZoom(),
            layers: ['bpb-route', 'bpb-peaks-ring'].filter(id => map.getLayer(id)),
            sources: Object.fromEntries(Object.keys(map.getStyle()?.sources || {})
                .map(id => [id, map.isSourceLoaded(id)])),
        } : null;
    } catch (error) {
        // Detached/cross-origin frames are useful evidence too; preserve the
        // original timeout instead of replacing it with a diagnostic exception.
        result.probeError = String(error);
    }
    return result;
}
