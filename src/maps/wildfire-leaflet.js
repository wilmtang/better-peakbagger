// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWildfireSession } from './wildfire-session.js';
import { wildfireDetails } from './wildfire-details.js';
import { wildfireRecords, wildfireWorldCopy } from './wildfire-core.js';
export function createLeafletWildfires({ win, map, document = win.document, onStatus }) {
    const L = win.L; let group = null, dataKey = '';
    const pane = 'bpb-wildfires';
    if (!map.getPane(pane)) { map.createPane(pane); map.getPane(pane).style.zIndex = '350'; }
    const remove = () => { if (group) map.removeLayer(group); group = null; };
    const session = createWildfireSession({ document, readView: () => ({ bounds: map.getBounds(), zoom: map.getZoom() }), fetchImpl: win.fetch.bind(win), onStatus,
        onData(result) {
            const longitude = map.getCenter().lng;
            const features = [...result.perimeters, ...result.incidents].map(feature => wildfireWorldCopy(feature, longitude));
            const key = JSON.stringify(features); if (key === dataKey) return; dataKey = key;
            if (!features.length) { remove(); return; }
            const records = new Map(wildfireRecords(result.incidents, result.perimeters).map(record => [record.id, record]));
            const next = L.geoJSON({ type: 'FeatureCollection', features }, { pane,
                style: { pane, color: '#c5412c', weight: 2, fillColor: '#e66b39', fillOpacity: .18 },
                pointToLayer: (feature, point) => L.circleMarker(point, { pane, radius: 6, color: '#fff', weight: 2, fillColor: '#c5412c', fillOpacity: 1 }),
                onEachFeature(feature, layer) {
                    const fire = records.get(feature.id) || { ...feature.properties, hasPerimeter: feature.geometry.type !== 'Point' };
                    const content = win.document.createElement('div'), title = win.document.createElement('strong'); title.textContent = fire.name;
                    content.append(title, wildfireDetails(win.document, fire)); layer.bindPopup(content, { maxWidth: 280 });
                },
            });
            next.addTo(map); remove(); group = next;
        } });
    const moving = () => session.moving(), refresh = () => session.refresh();
    map.on('movestart', moving); map.on('moveend', refresh);
    return { update: session.update, retry: session.retry, dispose() { map.off('movestart', moving); map.off('moveend', refresh); session.dispose(); remove(); } };
}
