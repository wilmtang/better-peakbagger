// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { nearbySnotelStations } from './snotel-data.js';
import { readSnotelMapOcclusions } from './snotel-map-data.js';

const viewFrame = (width, height, obstacles, vector) => {
    const margin = 24;
    let frames = [[margin, margin, width - margin, height - margin]];
    for (const [left, top, right, bottom] of obstacles) {
        frames = frames.flatMap(frame => {
            const [l, t, r, b] = frame;
            if (r <= left - 12 || l >= right + 12 || b <= top - 12 || t >= bottom + 12) return [frame];
            return [[l, t, Math.min(r, left - 12), b], [Math.max(l, right + 12), t, r, b],
                [l, t, r, Math.min(b, top - 12)], [l, Math.max(t, bottom + 12), r, b]];
        }).filter(([l, t, r, b]) => r - l >= 32 && b - t >= 32);
        // Controls overlap (for example a native picker inside its surround).
        // Keep only maximal rectangles and bound work even on modified pages.
        frames = frames.filter((frame, index, all) => !all.some((other, j) => j !== index && other[0] <= frame[0] && other[1] <= frame[1]
            && other[2] >= frame[2] && other[3] >= frame[3] && (j < index || other.some((value, k) => value !== frame[k])))).slice(0, 64);
    }
    // Prefer the free area that needs the least zooming out for this pair.
    return frames.map(frame => ({ frame, scale: Math.min(1, (frame[2] - frame[0]) / Math.max(1, Math.abs(vector.x)),
        (frame[3] - frame[1]) / Math.max(1, Math.abs(vector.y))), area: (frame[2] - frame[0]) * (frame[3] - frame[1]) }))
        .sort((a, b) => b.scale - a.scale || b.area - a.area)[0]?.frame;
};

// A one-shot reveal after an explicit layer activation, shared by the native
// Leaflet map and the isolated terrain renderer. Only the nearest station drives
// the camera; further alternatives must not make the useful station smaller.
export function createSnotelMapReveal({ getMap, window: win, terrain = false, getOcclusions = () => [] }) {
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
    const show = (stations, obstructions = getOcclusions()) => {
        const map = getMap();
        if (!map || !stations.length || map.isMoving?.()) return false;
        try {
            const center = map.getCenter(), zoom = map.getZoom();
            const size = terrain ? map.getContainer() : map.getSize();
            const width = terrain ? size.clientWidth : size.x, height = terrain ? size.clientHeight : size.y;
            if (![center.lat, center.lng, zoom, width, height].every(Number.isFinite) || width < 80 || height < 80) return false;
            // Keep Alaska's stations in the world copy nearest the camera.
            const longitude = lon => lon + 360 * Math.round((center.lng - lon) / 360);
            const project = ([lon, lat]) => terrain ? map.project([lon, lat]) : map.latLngToContainerPoint([lat, lon]);
            const occlusions = readSnotelMapOcclusions(obstructions).map(rect => rect.map((value, index) => value * (index % 2 ? height : width)));
            const container = map.getContainer?.(), origin = container?.getBoundingClientRect?.();
            const controls = origin ? [...container.ownerDocument.querySelectorAll('.leaflet-control, #selboxdiv, #selmap, .bpb-terrain-controls, .maplibregl-ctrl')].slice(0, 12)
                .map(control => control.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0)
                .map(rect => [rect.left - origin.left, rect.top - origin.top, rect.right - origin.left, rect.bottom - origin.top]) : [];
            const obstacles = [...occlusions, ...controls];
            const points = stations.map(station => [longitude(station.longitude), station.latitude]);
            if (points.some(([lon, lat]) => {
                const point = project([lon, lat]);
                return point.x >= 24 && point.x <= width - 24 && point.y >= 24 && point.y <= height - 24
                    && obstacles.every(rect => point.x <= rect[0] - 12 || point.x >= rect[2] + 12 || point.y <= rect[1] - 12 || point.y >= rect[3] + 12);
            })) return false;
            const nearest = nearbySnotelStations(stations, { latitude: center.lat, longitude: ((center.lng + 180) % 360 + 360) % 360 - 180 }, 1)[0];
            if (!nearest) return false;
            const target = [longitude(nearest.longitude), nearest.latitude], anchor = project([center.lng, center.lat]), projected = project(target);
            const frame = viewFrame(width, height, obstacles, { x: projected.x - anchor.x, y: projected.y - anchor.y });
            if (!frame) return false;
            const nearby = [[center.lng, center.lat], target];
            const bounds = [
                [Math.min(...nearby.map(point => point[0])), Math.min(...nearby.map(point => point[1]))],
                [Math.max(...nearby.map(point => point[0])), Math.max(...nearby.map(point => point[1]))],
            ];
            const padding = { left: frame[0], top: frame[1], right: width - frame[2], bottom: height - frame[3] };
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
