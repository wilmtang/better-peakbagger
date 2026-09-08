// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */

// Self-contained so CDP and Playwright can evaluate the same probe in the page.
// Only read state: a timeout must not reset the map or conceal the failed view.
export function readTerrainReadiness() {
    const frame = document.getElementById('bpb-terrain-frame');
    const toggle = document.getElementById('bpb-terrain-toggle');
    const result = {
        url: document.URL,
        visibility: document.visibilityState,
        toggle: toggle ? {
            text: toggle.textContent, title: toggle.title, disabled: toggle.disabled,
        } : null,
        frame: frame ? { opacity: frame.style.opacity } : null,
    };
    try {
        const doc = frame?.contentDocument;
        const map = frame?.contentWindow?.__bpbTerrainTestMap;
        const surface = doc?.getElementById('bpb-terrain-map');
        const canvas = map?.getCanvas();
        const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        result.surface = {
            readyState: doc?.readyState,
            theme: surface?.dataset.theme,
            canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
            renderer: gl ? gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null,
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
