// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A one-shot reveal after an explicit layer activation, shared by the native
// Leaflet map and the isolated terrain renderer. Catalog order is nearest-first.
export function createSnotelMapReveal({ getMap, window: win, terrain = false }) {
    let animatedMap = null;
    const finished = () => {
        animatedMap?.off?.('moveend', finished);
        animatedMap = null;
    };
    const cancel = () => {
        const previous = animatedMap;
        finished();
        previous?.stop?.();
    };
    const show = stations => {
        const map = getMap();
        if (!map || !stations.length) return false;
        try {
            const center = map.getCenter(), zoom = map.getZoom();
            const size = terrain ? map.getContainer() : map.getSize();
            const width = terrain ? size.clientWidth : size.x, height = terrain ? size.clientHeight : size.y;
            if (![center.lat, center.lng, zoom, width, height].every(Number.isFinite) || width < 80 || height < 80) return false;
            // Keep Alaska's stations in the world copy nearest the camera.
            const longitude = lon => lon + 360 * Math.round((center.lng - lon) / 360);
            const points = stations.map(station => [longitude(station.longitude), station.latitude]);
            if (points.some(([lon, lat]) => {
                const point = terrain ? map.project([lon, lat]) : map.latLngToContainerPoint([lat, lon]);
                return point.x >= 12 && point.x <= width - 12 && point.y >= 12 && point.y <= height - 12;
            })) return false;
            const nearby = [[center.lng, center.lat], ...points.slice(0, 3)];
            const bounds = [
                [Math.min(...nearby.map(point => point[0])), Math.min(...nearby.map(point => point[1]))],
                [Math.max(...nearby.map(point => point[0])), Math.max(...nearby.map(point => point[1]))],
            ];
            const padding = { left: Math.min(64, width / 4), top: Math.min(88, height / 3),
                right: Math.min(116, width / 3), bottom: Math.min(48, height / 4) };
            const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
            cancel();
            animatedMap = map;
            map.on?.('moveend', finished);
            if (terrain) map.fitBounds(bounds, { padding, maxZoom: zoom, pitch: map.getPitch(), bearing: map.getBearing(),
                linear: true, duration: reduced ? 0 : 450 });
            else map.flyToBounds(bounds.map(([lon, lat]) => [lat, lon]), { maxZoom: zoom,
                paddingTopLeft: [padding.left, padding.top], paddingBottomRight: [padding.right, padding.bottom],
                animate: !reduced, duration: reduced ? 0 : 0.45 });
            if (reduced) finished();
            return true;
        } catch {
            finished();
            return false;
        }
    };
    return { show, cancel };
}
