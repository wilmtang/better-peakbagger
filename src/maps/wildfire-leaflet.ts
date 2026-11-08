// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWildfireSession } from './wildfire-session.ts';
import type { WildfireData } from './wildfire-session.ts';
import { wildfireDetails } from './wildfire-details.js';
import { wildfireRecords, wildfireWorldCopy } from './wildfire-core.js';
// The minimal page-owned Leaflet contract this module reads.
interface FireFeature { id?: unknown; properties: Record<string, unknown>; geometry: { type: string }; }
interface FireLayer {
    feature?: FireFeature; bindPopup(content: Node, options: object): unknown; on(type: string, listener: () => void): unknown;
    getPopup(): { options: { autoPan?: boolean }; getLatLng(): unknown }; openPopup(latLng?: unknown): unknown;
}
interface FireGroup { addTo(map: unknown): unknown; getLayers(): FireLayer[]; }
interface FireLeaflet {
    geoJSON(data: unknown, options: { pane: string; style: object; pointToLayer(feature: FireFeature, point: unknown): unknown; onEachFeature(feature: FireFeature, layer: FireLayer): void }): FireGroup;
    circleMarker(point: unknown, options: object): unknown;
}
interface FireMap {
    getPane(name: string): HTMLElement | undefined; createPane(name: string): HTMLElement; removeLayer(layer: unknown): unknown;
    getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number }; getZoom(): number; getCenter(): { lng: number };
    on(type: string, listener: () => void): unknown; off(type: string, listener: () => void): unknown;
}
interface FireWindow { L: FireLeaflet; document: Document; fetch: typeof fetch; }
export function createLeafletWildfires({ win, map, document = win.document, onStatus }: { win: FireWindow; map: FireMap; document?: Document; onStatus(status: Record<string, unknown>): void }) {
    const L = win.L; let group: FireGroup | null = null, dataKey = '', openFire: unknown = null, openAt: unknown = null;
    const pane = 'bpb-wildfires';
    if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane)!.style.zIndex = '350'; }
    const remove = () => { if (group) map.removeLayer(group); group = null; };
    const session = createWildfireSession({ document, readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() }), fetchImpl: win.fetch.bind(win), onStatus,
        onData(result: WildfireData) {
            const longitude = map.getCenter().lng;
            const features = [...result.perimeters, ...result.incidents].map(feature => wildfireWorldCopy(feature as never, longitude));
            const key = JSON.stringify(features); if (key === dataKey) return; dataKey = key;
            if (!features.length) { openFire = null; remove(); return; }
            const records = new Map(wildfireRecords(result.incidents as never, result.perimeters as never).map(record => [record.id, record]));
            const next = L.geoJSON({ type: 'FeatureCollection', features }, { pane,
                style: { pane, color: '#c5412c', weight: 2, fillColor: '#e66b39', fillOpacity: .18 },
                pointToLayer: (_feature, point) => L.circleMarker(point, { pane, radius: 6, color: '#fff', weight: 2, fillColor: '#c5412c', fillOpacity: 1 }),
                onEachFeature(feature, layer) {
                    const fire = (records.get(feature.id as never) || { ...feature.properties, hasPerimeter: feature.geometry.type !== 'Point' }) as { name: string };
                    const content = win.document.createElement('div'), title = win.document.createElement('strong'); title.textContent = fire.name;
                    content.append(title, wildfireDetails(win.document, fire as never)); layer.bindPopup(content, { maxWidth: 280 });
                    layer.on('popupopen', () => { openFire = feature.id; openAt = layer.getPopup().getLatLng(); });
                    layer.on('popupclose', () => { if (openFire === feature.id) openFire = null; });
                },
            });
            const reopen = openFire, at = openAt;
            next.addTo(map); remove(); group = next;
            // The replacement must not close the popup being read, or pan to it again.
            const target = reopen === null ? null : next.getLayers().find(layer => layer.feature?.id === reopen);
            if (target) { const popup = target.getPopup(); popup.options.autoPan = false; target.openPopup(at); popup.options.autoPan = true; }
        } });
    const moving = () => session.moving(), refresh = () => session.refresh();
    map.on('movestart', moving); map.on('moveend', refresh);
    return { update: session.update, retry: session.retry, dispose() { map.off('movestart', moving); map.off('moveend', refresh); session.dispose(); remove(); } };
}
