/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Serialized into the fixture page. This establishes a settled 2D baseline for
// mode-switch geometry checks; it does not exercise early clicks during startup.
export function readTerrainToggleReadiness() {
    const toggle = document.getElementById('bpb-terrain-toggle') as HTMLButtonElement | null;
    const nativeMap = document.querySelector<HTMLIFrameElement>('iframe[src*="MasterMap.aspx" i]');
    const rect = toggle?.getBoundingClientRect();
    const positive = (value: DOMRect | undefined) => !!value
        && [value.left, value.top, value.bottom, value.width, value.height].every(Number.isFinite) && value.width > 0 && value.height > 0;
    let nativeReady = false, gap: number | null = null, zoomVisible = false, nativeDocumentReadyState = 'unavailable';
    try {
        const nativeWindow = nativeMap?.contentWindow as (Window & { mapsPlaceholder?: unknown }) | null;
        nativeReady = !!nativeWindow?.mapsPlaceholder;
        nativeDocumentReadyState = nativeMap?.contentDocument?.readyState ?? 'unavailable';
        const zoom = nativeMap?.contentDocument?.querySelector<HTMLElement>('.leaflet-control-zoom');
        const zoomRect = zoom?.getBoundingClientRect(), iframeRect = nativeMap?.getBoundingClientRect();
        const style = zoom && nativeWindow?.getComputedStyle(zoom);
        const frameStyle = nativeMap && getComputedStyle(nativeMap);
        zoomVisible = positive(zoomRect) && positive(iframeRect) && style?.display !== 'none' && style?.visibility !== 'hidden'
            && frameStyle?.display !== 'none' && frameStyle?.visibility !== 'hidden';
        if (zoomVisible && positive(rect)) gap = iframeRect!.top + nativeMap!.clientTop + zoomRect!.top - rect!.bottom;
    } catch { /* A missing or cross-origin native frame cannot prove its control geometry. */ }
    const style = toggle && getComputedStyle(toggle);
    const idle2d = toggle?.textContent?.trim() === '3D' && toggle.getAttribute('aria-pressed') === 'false'
        && toggle.getAttribute('aria-busy') !== 'true';
    return {
        ready: !!toggle && idle2d && !toggle.disabled && positive(rect) && style?.display !== 'none' && style?.visibility !== 'hidden'
            && nativeReady && zoomVisible && gap !== null && Number.isFinite(gap) && gap >= 7,
        left: rect?.left, top: rect?.top, width: rect?.width, height: rect?.height, nativeReady, zoomVisible, gap,
        nativeFrameId: nativeMap?.id ?? null, nativeFrameConnected: !!nativeMap?.isConnected, nativeDocumentReadyState,
        toggleText: toggle?.textContent ?? null, togglePressed: toggle?.getAttribute('aria-pressed') ?? null, toggleBusy: toggle?.getAttribute('aria-busy') ?? null
    };
}
